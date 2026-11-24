import { signInConfigurationSchema } from '@agent-collaboration/sign-in-core';
import { createProviderRequestState } from '@agent-collaboration/sign-in-core/better-auth';
import type { SignInProviderProps } from '@agent-collaboration/sign-in-core/better-auth';

import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	turnstileTestSecret,
	turnstileTestSiteKey,
} from '#sign-in-test-support/test-fixtures/turnstile-test-keys';

export function storageProviderProperties(
	context: StorageCaseContext,
	organizationId: string,
): Omit<SignInProviderProps, 'authority' | 'generatedClientId'> {
	return {
		openDatabase: context.openDatabase,
		store: context.store,
		platform: context.platform,
		configuration: signInConfigurationSchema.parse({
			issuer: 'https://storage-sign-in.invalid',
			mode: 'private',
			ownerEmail: storageCaseOwnerEmail,
			toolPortalOrigin: 'https://storage-portal.invalid',
			managementAudience: 'https://storage-portal.invalid/management',
			centralIdentityAudience: 'https://central.example.invalid/identity',
			centralAdminAudience: 'https://central.example.invalid/admin',
			centralPublicOrigin: 'https://central.example.invalid',
			adminPageClientId: 'admin-page-local',
			ownerFleetCliClientId: 'owner-fleet-cli-local',
			organizationStatementLifetimeSeconds: 10_368_000,
			organizationIds: [organizationId],
			ownerCliClientId: 'storage-owner-cli',
			ownerCliRedirectUri: 'http://127.0.0.1/callback',
			accessTokenSeconds: 300,
			managementHumanCheck: 'remembered-login',
			turnstile: { kind: 'deployed', siteKey: turnstileTestSiteKey },
		}),
		secret: 'test-only-storage-secret-'.repeat(3),
		turnstileSecret: { kind: 'configured', secretKey: turnstileTestSecret },
		google: { clientId: 'fixture-google', clientSecret: 'fixture-google-secret' },
		github: { clientId: 'fixture-github', clientSecret: 'fixture-github-secret' },
		requestState: createProviderRequestState(),
	};
}
