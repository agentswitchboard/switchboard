import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { expect, it } from 'vitest';

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

it('always enables the native per-address memory limiter independently of production mode', () => {
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
	const provider = createSignInProvider({
		openDatabase: () => database,
		store: createSignInStore({
			openDatabase: () => database,
			platform,
			ownerEmail: configuration.ownerEmail,
		}),
		platform,
		configuration,
		secret: 'test-only-provider-secret-'.repeat(3),
		turnstileSecret: { kind: 'missing' },
		google: { clientId: 'test-google', clientSecret: 'test-only-google-secret' },
		github: { clientId: 'test-github', clientSecret: 'test-only-github-secret' },
		authority: { kind: 'public' },
		requestState: createProviderRequestState(),
	});
	// R52 explicitly fixes this layer even in tests/development. Native defaults
	// instead depend on NODE_ENV and therefore do not meet that requirement.
	expect(provider.options.rateLimit).toMatchObject({
		enabled: true,
		storage: 'memory',
		window: 10,
		max: 100,
	});
});
