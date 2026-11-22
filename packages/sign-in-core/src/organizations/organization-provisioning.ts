import type {
	OrganizationStatementDigestReply,
	ProvisionOrganization,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { OrganizationStatementSigningRequest } from '#sign-in-core/contracts/organization-statement';
import type { OrganizationStampRecords } from '#sign-in-core/organizations/organization-stamp-renewal';
import type {
	SignInStoreFailure,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';

export type OrganizationFleetState = 'settingUp' | 'ready';
/** A link outcome the caller cannot confirm either way; it stays retryable. */
export type CentralLinkUncertainty = 'unavailable' | 'timeout' | 'malformed-reply';
/** Central decided against this statement; a resend of the same bytes would be refused again. */
export type OrganizationStatementRefusal = 'organization-mismatch' | 'invalid-statement' | 'stale';
export type ProvisionOrganizationAnswer =
	| { readonly kind: 'provisioned' }
	| { readonly kind: 'refused'; readonly reason: OrganizationStatementRefusal }
	| { readonly kind: 'unknown'; readonly reason: CentralLinkUncertainty };
/** Central's verified facts about its stored stamp; the statement bytes never cross the link. */
export type OrganizationStatementDigestAnswer =
	| ({ readonly kind: 'current' } & Readonly<OrganizationStatementDigestReply>)
	| { readonly kind: 'none' }
	| { readonly kind: 'unavailable'; readonly reason: CentralLinkUncertainty };

export interface OrganizationProvisioningStore {
	readonly readFleetState: (
		organizationId: OrganizationId,
	) => Promise<SignInStoreResult<OrganizationFleetState | null>>;
	readonly markFleetReady: (organizationId: OrganizationId) => Promise<SignInStoreResult<void>>;
}
/** Setup and renewal share one private operation: a renewal is a statement naming its predecessor. */
export interface OrganizationProvisioningClient {
	/** `signal` aborts the in-flight link request at the caller's deadline (D7). */
	readonly provisionOrganization: (request: {
		readonly organizationId: OrganizationId;
		readonly organizationStatement: ProvisionOrganization['organizationStatement'];
		readonly signal?: AbortSignal;
	}) => Promise<ProvisionOrganizationAnswer>;
	readonly readStatementDigest: (
		organizationId: OrganizationId,
		options?: { readonly signal?: AbortSignal },
	) => Promise<OrganizationStatementDigestAnswer>;
}
export type SignOrganizationStatement = (
	request: OrganizationStatementSigningRequest,
) => Promise<string>;

export type OrganizationProvisioningResult =
	| { readonly kind: 'ready' }
	| { readonly kind: 'not-found' }
	| {
			readonly kind: 'setting-up';
			readonly reason: CentralLinkUncertainty | 'signing-unavailable';
	  }
	| { readonly kind: 'refused'; readonly reason: OrganizationStatementRefusal }
	| SignInStoreFailure;

/** Only a confirmed central answer advances state. Unknown outcomes remain retryable by organization ID. */
export async function ensureOrganizationProvisioned(props: {
	readonly organizationId: OrganizationId;
	readonly store: OrganizationProvisioningStore;
	readonly stamps: Pick<OrganizationStampRecords, 'seedConfirmedStamp'>;
	readonly centralClient: Pick<
		OrganizationProvisioningClient,
		'provisionOrganization' | 'readStatementDigest'
	>;
	readonly signStatement: SignOrganizationStatement;
}): Promise<OrganizationProvisioningResult> {
	const state = await props.store.readFleetState(props.organizationId);
	if (state.kind === 'store-unavailable') return state;
	if (state.value === null) return { kind: 'not-found' };
	if (state.value === 'ready') return { kind: 'ready' };
	let organizationStatement: ProvisionOrganization['organizationStatement'];
	try {
		// Setup never names a predecessor; only renewal replaces a stored stamp.
		organizationStatement = await props.signStatement({ organizationId: props.organizationId });
	} catch {
		return { kind: 'setting-up', reason: 'signing-unavailable' };
	}
	const answer = await props.centralClient.provisionOrganization({
		organizationId: props.organizationId,
		organizationStatement,
	});
	switch (answer.kind) {
		case 'unknown':
			return { kind: 'setting-up', reason: answer.reason };
		case 'refused':
			return answer;
		case 'provisioned': {
			const saved = await props.store.markFleetReady(props.organizationId);
			if (saved.kind === 'store-unavailable') return saved;
			await seedStampAfterSetup(props);
			return { kind: 'ready' };
		}
		default:
			return unreachableProvisioningAnswer(answer);
	}
}

/**
 * D5 (Lead, 12 Nov): central answers `provisioned` whether it stored these bytes or already held
 * a stamp, so the record is seeded from central's own facts, never from what was sent. A failed
 * read leaves the record empty and the first guarded use seeds it (D3).
 */
async function seedStampAfterSetup(
	props: Parameters<typeof ensureOrganizationProvisioned>[0],
): Promise<void> {
	let current: OrganizationStatementDigestAnswer;
	try {
		current = await props.centralClient.readStatementDigest(props.organizationId);
	} catch {
		return;
	}
	if (current.kind !== 'current') return;
	await props.stamps.seedConfirmedStamp({
		organizationId: props.organizationId,
		stamp: {
			digest: current.digest,
			expiresAt: current.expiresAt,
			signingKeyId: current.signingKeyId,
		},
	});
}

function unreachableProvisioningAnswer(_answer: never): never {
	throw new Error('Unknown organization provisioning answer');
}
