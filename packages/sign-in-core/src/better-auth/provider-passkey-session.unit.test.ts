import { createAuthMiddleware } from 'better-auth/api';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { expect, it, vi } from 'vitest';

import { createSignInProvider } from '#sign-in-core/better-auth/provider-configuration';
import { createProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';
import {
	epochMillisecondsSchema,
	uuid7Schema,
	type SignInPlatform,
} from '#sign-in-core/contracts/sign-in-platform';
import { signInSchema } from '#sign-in-core/storage/sign-in-schema';
import { createSignInStore } from '#sign-in-core/storage/sign-in-store';

it.each(['/passkey/verify-authentication', '/callback/google', null])(
	'marks only passkey sessions in the creation hook: %s',
	async (path) => {
		// This process-local storage stand-in never reaches a real database. The
		// claim is the real provider's configuration, independent of storage startup.
		const database = drizzle(
			async () => {
				throw new Error('Provider option test must not query storage');
			},
			{ schema: signInSchema },
		);
		const platform = {
			// The test claims native provider configuration, outside the outer port.
			requestLimiter: { allow: async () => ({ kind: 'allowed' }) },
			clock: { now: () => epochMillisecondsSchema.parse(2_208_988_800_000) },
			ids: { nextId: () => uuid7Schema.parse('11111111-1111-7111-8111-111111111111') },
			runAtomically: async () => ({ kind: 'failed', reason: 'database-error' }),
			centralClient: {
				readStatementDigest: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
				pushAuthorizationRevision: async () => ({ kind: 'unknown', reason: 'unavailable' }),
				sendFleetAdminRequest: async () => ({
					kind: 'unknown' as const,
					reason: 'unavailable' as const,
				}),
				relayFleetAdminRequest: async () => ({
					kind: 'unknown' as const,
					reason: 'unavailable' as const,
				}),
				provisionOrganization: async () => ({ kind: 'unknown', reason: 'unavailable' }),
			},
			log: (): void => undefined,
			crypto: globalThis.crypto,
		} satisfies SignInPlatform;
		const configuration = signInConfigurationSchema.parse({
			issuer: 'https://sign-in.invalid',
			mode: 'private',
			ownerEmail: 'owner@example.invalid',
			toolPortalOrigin: 'https://portal.invalid',
			managementAudience: 'https://portal.invalid/management',
			centralIdentityAudience: 'https://central.example.invalid/identity',
			centralAdminAudience: 'https://central.example.invalid/admin',
			centralPublicOrigin: 'https://central.example.invalid',
			adminPageClientId: 'admin-page-local',
			ownerFleetCliClientId: 'owner-fleet-cli-local',
			organizationStatementLifetimeSeconds: 10_368_000,
			organizationIds: ['22222222-2222-7222-8222-222222222222'],
			ownerCliClientId: 'owner-cli',
			ownerCliRedirectUri: 'http://127.0.0.1/callback',
			turnstile: { kind: 'deployed', siteKey: 'test-only-site-key' },
		});
		const store = createSignInStore({
			openDatabase: () => database,
			platform,
			ownerEmail: configuration.ownerEmail,
		});
		vi.spyOn(store.persons, 'ensurePersonActive').mockResolvedValue({
			kind: 'available',
			value: true,
		});
		vi.spyOn(store.organizations, 'membershipsForPerson').mockResolvedValue({
			kind: 'available',
			value: [],
		});
		const provider = createSignInProvider({
			openDatabase: () => database,
			store,
			platform,
			configuration,
			secret: 'test-only-provider-secret-'.repeat(3),
			turnstileSecret: { kind: 'missing' },
			google: { clientId: 'test-google', clientSecret: 'test-only-google-secret' },
			github: { clientId: 'test-github', clientSecret: 'test-only-github-secret' },
			authority: { kind: 'public' },
			requestState: createProviderRequestState(),
		});

		const before = provider.options.databaseHooks?.session?.create?.before;
		if (before === undefined) throw new Error('Session creation hook missing');
		const session = {
			id: platform.ids.nextId(),
			userId: platform.ids.nextId(),
			token: 'test-only-token',
			createdAt: new Date(platform.clock.now()),
			updatedAt: new Date(platform.clock.now()),
			expiresAt: new Date(platform.clock.now() + 60_000),
		};
		let result: unknown;
		if (path === null) result = await before(session, null);
		else {
			const invoke = createAuthMiddleware(async (context) => {
				result = await before(session, context);
			});
			await invoke({ path, context: await provider.$context });
		}
		expect(result).toMatchObject({ data: { ...session, activeOrganizationId: null } });
		if (path === '/passkey/verify-authentication')
			expect(result).toMatchObject({
				data: { secondFactorAt: platform.clock.now(), secondFactorMethod: 'passkey' },
			});
		else {
			expect(result).not.toHaveProperty('data.secondFactorAt');
			expect(result).not.toHaveProperty('data.secondFactorMethod');
		}
	},
);
