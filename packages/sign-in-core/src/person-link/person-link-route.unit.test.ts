import { expect, it } from 'vitest';

import type { PersonLinkTokenClaims } from '#sign-in-core/contracts/person-link-token';
import { epochMillisecondsSchema, uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';
import type { PersonFleetAuthorizationSnapshot } from '#sign-in-core/organizations/person-fleet-issuance';
import {
	decidePersonLinkRoute,
	type PersonLinkAuthentication,
	type PersonLinkRouteOutcome,
	type PersonLinkRoutePorts,
	type PersonLinkSigning,
} from '#sign-in-core/person-link/person-link-route';
import type { SignInStoreResult } from '#sign-in-core/storage/models/sign-in-database';
import { personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

const now = epochMillisecondsSchema.parse(2_208_988_800_000);
const issuer = 'https://sign-in.example.invalid';
const organizationId = '019a3dce-2000-7000-8000-000000000001';
const caller = {
	personId: personIdSchema.parse('019a3dce-2000-7000-8000-000000000003'),
	sessionId: uuid7Schema.parse('019a3dce-2000-7000-8000-000000000005'),
};
const upgrade = { connection: 'Upgrade', upgrade: 'websocket' };
const browser = { ...upgrade, cookie: 'session=fixture', origin: issuer };
const cli = { ...upgrade, authorization: 'DPoP person-fleet-token', dpop: 'proof' };

const memberSnapshot: PersonFleetAuthorizationSnapshot = {
	sessionExpiresAt: epochMillisecondsSchema.parse(now + 3_600_000),
	organizationId,
	confirmation: { kind: 'unconfirmed' },
	memberRole: 'member',
	subject: { id: '019a3dce-2000-7000-8000-000000000002', revision: 1, state: 'active' },
	organizationFence: {
		revision: 1,
		state: 'active',
		permissionPolicyDigest: fleetPermissionPolicyDigest,
	},
};

interface Observed {
	readonly signed: PersonLinkTokenClaims[];
	readonly reads: string[];
	readonly cliCredentials: { readonly accessToken: string; readonly proof: string }[];
}

async function decide(props: {
	readonly method?: string;
	readonly path?: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly browser?: PersonLinkAuthentication;
	readonly cli?: PersonLinkAuthentication;
	readonly snapshot?: SignInStoreResult<PersonFleetAuthorizationSnapshot | null>;
	readonly signing?: PersonLinkSigning;
	readonly audience?: 'configured' | 'absent';
}): Promise<{ readonly outcome: PersonLinkRouteOutcome; readonly observed: Observed }> {
	const observed: Observed = { signed: [], reads: [], cliCredentials: [] };
	const ports: PersonLinkRoutePorts = {
		clock: { now: () => now },
		ids: { nextId: () => uuid7Schema.parse('019a3dce-2000-7000-8000-000000000004') },
		permissionsForRole: (role) => (role === 'member' ? [] : null),
		authenticateBrowserSession: async () => props.browser ?? { kind: 'authenticated', caller },
		authenticateCliCredential: async (credential) => {
			observed.cliCredentials.push(credential);
			return props.cli ?? { kind: 'authenticated', caller };
		},
		readAuthorizationSnapshot: async (_caller, organization) => {
			observed.reads.push(organization);
			return props.snapshot ?? { kind: 'available', value: memberSnapshot };
		},
		signToken: async (claims) => {
			observed.signed.push(claims);
			return props.signing ?? { kind: 'signed', token: 'signed-person-link-token' };
		},
	};
	const outcome = await decidePersonLinkRoute({
		request: {
			method: props.method ?? 'GET',
			pathname: props.path ?? `/api/fleet/person-link/${organizationId}`,
			headers: new Headers(props.headers),
		},
		configuration: {
			issuer,
			accessTokenSeconds: 300,
			...(props.audience === 'absent'
				? {}
				: { centralPersonLinkAudience: 'https://central.example.invalid/person-link' }),
		},
		ports,
	});
	return { outcome, observed };
}

it('forwards a browser session with the exact Origin, minting for the organization in the path', async (): Promise<void> => {
	const { outcome, observed } = await decide({ headers: browser });
	expect(outcome).toEqual({ kind: 'forward', organizationId, token: 'signed-person-link-token' });
	expect(observed.reads).toEqual([organizationId]);
	expect(observed.signed[0]).toMatchObject({
		aud: 'https://central.example.invalid/person-link',
		token_profile: 'person-link',
		sub: caller.personId,
		exp: Math.floor(now / 1000) + 60,
	});
});

it('passes the CLI token and proof to the verifier and forwards a verified caller', async (): Promise<void> => {
	const { outcome, observed } = await decide({ headers: cli });
	expect(outcome.kind).toBe('forward');
	expect(observed.cliCredentials).toEqual([{ accessToken: 'person-fleet-token', proof: 'proof' }]);
});

it.each<{
	readonly name: string;
	readonly input: Parameters<typeof decide>[0];
	readonly status: number;
	readonly reason: string;
}>([
	{
		name: 'a POST',
		input: { method: 'POST', headers: browser },
		status: 405,
		reason: 'method-not-allowed',
	},
	{
		name: 'a GET without upgrade',
		input: { headers: { cookie: 'c', origin: issuer } },
		status: 405,
		reason: 'websocket-upgrade-required',
	},
	{ name: 'no credential', input: { headers: upgrade }, status: 401, reason: 'credential-missing' },
	{
		name: 'both credentials',
		input: { headers: { ...browser, ...cli } },
		status: 401,
		reason: 'credential-ambiguous',
	},
	{
		name: 'a cookie without Origin',
		input: { headers: { ...upgrade, cookie: 'c' } },
		status: 403,
		reason: 'origin-refused',
	},
	{
		name: 'a cookie from another origin',
		input: { headers: { ...browser, origin: 'https://sign-in.example.invalid:8443' } },
		status: 403,
		reason: 'origin-refused',
	},
	{
		name: 'no live session',
		input: { headers: browser, browser: { kind: 'refused' } },
		status: 401,
		reason: 'session-required',
	},
	{
		name: 'a Bearer token',
		input: { headers: { ...cli, authorization: 'Bearer t' } },
		status: 401,
		reason: 'proof-refused',
	},
	{
		name: 'a DPoP token without a proof',
		input: { headers: { ...upgrade, authorization: 'DPoP t' } },
		status: 401,
		reason: 'proof-refused',
	},
	{
		name: 'a refused proof',
		input: { headers: cli, cli: { kind: 'refused' } },
		status: 401,
		reason: 'proof-refused',
	},
	{
		name: 'an unavailable verifier',
		input: { headers: cli, cli: { kind: 'unavailable' } },
		status: 503,
		reason: 'authorization-unavailable',
	},
	{
		name: 'an organization that is not a UUIDv7',
		input: { headers: browser, path: '/api/fleet/person-link/not-an-organization' },
		status: 403,
		reason: 'organization-refused',
	},
	{
		name: 'a non-member',
		input: {
			headers: browser,
			snapshot: { kind: 'available', value: { ...memberSnapshot, memberRole: null } },
		},
		status: 403,
		reason: 'organization-refused',
	},
	{
		name: 'an ended session',
		input: { headers: browser, snapshot: { kind: 'available', value: null } },
		status: 401,
		reason: 'session-required',
	},
	{
		name: 'an unavailable store',
		input: { headers: browser, snapshot: { kind: 'store-unavailable', reason: 'database-error' } },
		status: 503,
		reason: 'authorization-unavailable',
	},
	{
		name: 'an unavailable signer',
		input: { headers: browser, signing: { kind: 'unavailable' } },
		status: 503,
		reason: 'signing-unavailable',
	},
])('refuses $name', async ({ input, status, reason }): Promise<void> => {
	const { outcome } = await decide(input);
	expect(outcome).toEqual({ kind: 'refuse', status, reason });
});

it.each([
	['a browser', browser],
	['a CLI', cli],
])(
	'is off without the person-link audience: %s gets 503 and nothing is verified, read or minted',
	async (_caller, headers): Promise<void> => {
		const { outcome, observed } = await decide({ headers, audience: 'absent' });
		expect(outcome).toEqual({ kind: 'refuse', status: 503, reason: 'person-link-not-configured' });
		expect([observed.cliCredentials, observed.reads, observed.signed]).toEqual([[], [], []]);
	},
);

it('reads and mints nothing for a request refused before authentication', async (): Promise<void> => {
	const { observed } = await decide({ headers: { ...upgrade, cookie: 'c' } });
	expect([observed.reads, observed.signed]).toEqual([[], []]);
});
