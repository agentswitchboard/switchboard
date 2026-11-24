import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import type { PersonLinkTokenClaims } from '#sign-in-core/contracts/person-link-token';
import type { SignInClock, SignInIdSource, Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import type { FleetPermission } from '#sign-in-core/organizations/fleet-permission';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';
import type { PersonFleetAuthorizationSnapshot } from '#sign-in-core/organizations/person-fleet-issuance';
import {
	decidePersonLinkClaims,
	type PersonLinkClaimsRefusal,
} from '#sign-in-core/organizations/person-link-claims';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import {
	organizationIdSchema,
	type OrganizationId,
	type PersonId,
} from '#sign-in-core/storage/models/sign-in-store';

/** C8 part B: a person's link, one WebSocket upgrade per organization. */
export const personLinkPathPrefix = '/api/fleet/person-link/';

export type PersonLinkRefusalReason =
	| 'method-not-allowed'
	| 'websocket-upgrade-required'
	| 'credential-ambiguous'
	| 'credential-missing'
	| 'origin-refused'
	| 'session-required'
	| 'proof-refused'
	| 'organization-refused'
	| 'authorization-unavailable'
	| 'signing-unavailable'
	| 'central-link-unavailable';

export interface PersonLinkRefusal {
	readonly kind: 'refuse';
	readonly status: 401 | 403 | 405 | 503;
	readonly reason: PersonLinkRefusalReason;
}

/** The route's whole outcome: forward the upgrade with this token, or refuse it. */
export type PersonLinkRouteOutcome =
	| {
			readonly kind: 'forward';
			readonly organizationId: OrganizationId;
			readonly token: string;
	  }
	| PersonLinkRefusal;

/** Who a credential names: the person and the live session it belongs to. */
export interface PersonLinkCaller {
	readonly personId: PersonId;
	readonly sessionId: Uuid7;
}
export type PersonLinkAuthentication =
	| { readonly kind: 'authenticated'; readonly caller: PersonLinkCaller }
	| { readonly kind: 'refused' }
	| { readonly kind: 'unavailable' };
export type PersonLinkSigning =
	| { readonly kind: 'signed'; readonly token: string }
	| { readonly kind: 'unavailable' };

/** Everything the decision reads from outside, injected: core holds no runtime. */
export interface PersonLinkRoutePorts {
	/** The Better Auth session the cookie names, live and verified. */
	readonly authenticateBrowserSession: () => Promise<PersonLinkAuthentication>;
	/** The person-fleet token and its DPoP proof over this upgrade (htm GET, htu this URL). */
	readonly authenticateCliCredential: (credential: {
		readonly accessToken: string;
		readonly proof: string;
	}) => Promise<PersonLinkAuthentication>;
	/** The live membership and fences of the named organization, read in one statement. */
	readonly readAuthorizationSnapshot: (
		caller: PersonLinkCaller,
		organizationId: OrganizationId,
	) => Promise<SignInStoreResult<PersonFleetAuthorizationSnapshot | null>>;
	readonly signToken: (claims: PersonLinkTokenClaims) => Promise<PersonLinkSigning>;
	/** The loaded role mapping, as the person-fleet issuance receives it. */
	readonly permissionsForRole: (role: string) => readonly FleetPermission[] | null;
	readonly clock: SignInClock;
	readonly ids: SignInIdSource;
}

export interface PersonLinkUpgradeRequest {
	readonly method: string;
	/** The request's path, as the public route received it. */
	readonly pathname: string;
	readonly headers: Headers;
}

/**
 * Decides one person-link upgrade. Sign-in authenticates the caller (a session cookie with the
 * exact issuer Origin, or a person-fleet token with its DPoP proof; never both), reads the
 * membership live, and mints the short person-link token. It knows no operation and never sees a
 * frame. Returns a result; it never throws for a refusal.
 */
export async function decidePersonLinkRoute(props: {
	readonly request: PersonLinkUpgradeRequest;
	readonly configuration: Pick<
		SignInConfiguration,
		'issuer' | 'centralPersonLinkAudience' | 'accessTokenSeconds'
	>;
	readonly ports: PersonLinkRoutePorts;
}): Promise<PersonLinkRouteOutcome> {
	const { request, configuration, ports } = props;
	if (request.method !== 'GET') return refuse(405, 'method-not-allowed');
	if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
		return refuse(405, 'websocket-upgrade-required');
	const authentication = await authenticate({ request, issuer: configuration.issuer, ports });
	if (authentication.kind !== 'authenticated') return authentication;
	const organization = organizationIdSchema.safeParse(
		request.pathname.slice(personLinkPathPrefix.length),
	);
	if (!organization.success) return refuse(403, 'organization-refused');
	const organizationId = organization.data;
	// S is sampled before the read is dispatched, as the person-fleet issuance requires.
	const snapshotAt = ports.clock.now();
	const snapshot = await ports.readAuthorizationSnapshot(authentication.caller, organizationId);
	if (snapshot.kind === 'store-unavailable') return refuse(503, 'authorization-unavailable');
	const decision = decidePersonLinkClaims({
		issuance: {
			snapshot: snapshot.value,
			snapshotAt,
			tokenLifetimeMilliseconds: configuration.accessTokenSeconds * 1000,
			loadedPolicyDigest: fleetPermissionPolicyDigest,
			permissionsForRole: ports.permissionsForRole,
		},
		issuer: configuration.issuer,
		audience: configuration.centralPersonLinkAudience,
		subject: authentication.caller.personId,
		issuedAtSeconds: Math.floor(ports.clock.now() / 1000),
		tokenId: ports.ids.nextId(),
	});
	if (decision.kind === 'refused') return refusalForClaims(decision.reason);
	const signed = await ports.signToken(decision.claims);
	if (signed.kind === 'unavailable') return refuse(503, 'signing-unavailable');
	return { kind: 'forward', organizationId, token: signed.token };
}

async function authenticate(props: {
	readonly request: PersonLinkUpgradeRequest;
	readonly issuer: string;
	readonly ports: PersonLinkRoutePorts;
}): Promise<
	{ readonly kind: 'authenticated'; readonly caller: PersonLinkCaller } | PersonLinkRefusal
> {
	const { headers } = props.request;
	const browser = headers.has('cookie');
	const cli = headers.has('authorization') || headers.has('dpop');
	if (browser && cli) return refuse(401, 'credential-ambiguous');
	if (!browser && !cli) return refuse(401, 'credential-missing');
	let authentication: PersonLinkAuthentication;
	if (browser) {
		// The browser path is the issuer's own pages: any other Origin, or none, is refused.
		if (headers.get('origin') !== new URL(props.issuer).origin)
			return refuse(403, 'origin-refused');
		authentication = await props.ports.authenticateBrowserSession();
		if (authentication.kind === 'refused') return refuse(401, 'session-required');
	} else {
		const accessToken = /^DPoP ([^\s]+)$/u.exec(headers.get('authorization') ?? '')?.[1];
		const proof = headers.get('dpop');
		if (accessToken === undefined || proof === null) return refuse(401, 'proof-refused');
		authentication = await props.ports.authenticateCliCredential({ accessToken, proof });
		if (authentication.kind === 'refused') return refuse(401, 'proof-refused');
	}
	if (authentication.kind === 'unavailable') return refuse(503, 'authorization-unavailable');
	return authentication;
}

/** A live session that ended is 401; every missing authority is the same silent 403. */
function refusalForClaims(reason: PersonLinkClaimsRefusal): PersonLinkRefusal {
	switch (reason) {
		case 'no-session':
		case 'session-expired':
			return refuse(401, 'session-required');
		case 'no-organization':
		case 'no-membership':
		case 'subject-missing':
		case 'subject-inactive':
		case 'organization-fence-missing':
		case 'organization-inactive':
			return refuse(403, 'organization-refused');
		case 'policy-mismatch':
		case 'unknown-role':
		case 'invalid-window':
		case 'invalid-claims':
			return refuse(503, 'authorization-unavailable');
		default:
			return reason satisfies never;
	}
}

function refuse(
	status: PersonLinkRefusal['status'],
	reason: PersonLinkRefusalReason,
): PersonLinkRefusal {
	return { kind: 'refuse', status, reason };
}
