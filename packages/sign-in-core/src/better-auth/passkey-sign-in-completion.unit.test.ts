import { expect, it, vi } from 'vitest';

import { completePasskeySignIn } from '#sign-in-core/better-auth/passkey-sign-in-completion';
import {
	releaseSignInResponse,
	type SignInResponseReleasePorts,
} from '#sign-in-core/response-release/sign-in-response-release';

const session = {
	personId: '11111111-1111-7111-8111-111111111111',
	sessionId: '22222222-2222-7222-8222-222222222222',
};

it('preserves the release fence refusal after deleting an inactive issued session', async (): Promise<void> => {
	// Arrange: a real release fence refuses a session the provider has already issued.
	const storedSessions = new Set([session.sessionId]);
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	const ports: SignInResponseReleasePorts = {
		issuer: 'https://issuer.example.invalid',
		toolPortalOrigin: 'https://portal.example.invalid',
		requestedResource: null,
		managementAudience: 'https://portal.example.invalid/management',
		centralAdminAudience: 'https://central.example.invalid/admin',
		ownerFleetCliClientId: 'owner-fleet-test',
		accessTokenSeconds: 300,
		now: () => 0,
		inspectSignedToken: () => {
			throw new Error('No token grant in this sign-in');
		},
		readAgent: async () => null,
		readWorkspaceResource: async () => null,
		isPersonSessionActive: async () => false,
		isPersonOrganizationSessionActive: async () => false,
		deleteSession: async (sessionId: string): Promise<void> => {
			storedSessions.delete(sessionId);
		},
		cleanupUnboundPerson: async (): Promise<void> => undefined,
	};
	const response = await releaseSignInResponse({
		response: Response.json(
			{ session: { id: session.sessionId } },
			{ headers: { 'set-cookie': 'test-session=issued' } },
		),
		tokenGrant: 'none',
		issuedSessions: [session],
		createdUserIds: [],
		ports,
	});

	// Act: completion must not turn the authoritative 403 into the handler's catch-all 503.
	await expect(
		completePasskeySignIn({ response, issuedSessions: [session], recordSignIn }),
	).resolves.toBeUndefined();

	// Assert
	expect(response.status).toBe(403);
	expect(response.headers.has('set-cookie')).toBe(false);
	expect(await response.json()).toEqual({ error: 'not-allowed' });
	expect(storedSessions.size).toBe(0);
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: 'anonymous', outcome: 'failed', method: 'passkey' }],
	]);
});

it.each([
	{ body: { error: 'different-refusal' }, headers: {} },
	{ body: { error: 'not-allowed' }, headers: { 'set-cookie': 'test-session=issued' } },
])(
	'keeps a non-release 403 with an issued session fail-closed: $body',
	async ({ body, headers }): Promise<void> => {
		// Arrange / Act / Assert
		await expect(
			completePasskeySignIn({
				response: Response.json(body, { status: 403, headers }),
				issuedSessions: [session],
				recordSignIn: async (): Promise<void> => undefined,
			}),
		).rejects.toThrow('disagree');
	},
);

it('records a successful sign-in for the one issued person', async () => {
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	await completePasskeySignIn({
		response: new Response(null, { status: 200 }),
		issuedSessions: [session],
		recordSignIn,
	});
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: session.personId, outcome: 'succeeded', method: 'passkey' }],
	]);
});
it('records an ordinary refusal without throwing', async () => {
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	await completePasskeySignIn({
		response: new Response(null, { status: 401 }),
		issuedSessions: [],
		recordSignIn,
	});
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: 'anonymous', outcome: 'failed', method: 'passkey' }],
	]);
});
it.each([
	{ status: 500, sessions: [session] },
	{ status: 200, sessions: [] },
	{ status: 200, sessions: [session, session] },
])('fails closed for $status with mismatched issued sessions', async ({ status, sessions }) => {
	const recordSignIn = vi.fn(async (): Promise<void> => undefined);
	await expect(
		completePasskeySignIn({
			response: new Response(null, { status }),
			issuedSessions: sessions,
			recordSignIn,
		}),
	).rejects.toThrow('disagree');
	expect(recordSignIn.mock.calls).toEqual([
		[{ actor: 'anonymous', outcome: 'failed', method: 'passkey' }],
	]);
});
it('propagates an unavailable audit write', async () => {
	await expect(
		completePasskeySignIn({
			response: new Response(),
			issuedSessions: [session],
			recordSignIn: async () => {
				throw new Error('audit unavailable');
			},
		}),
	).rejects.toThrow('audit unavailable');
});
