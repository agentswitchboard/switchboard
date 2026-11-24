import { expect, it } from 'vitest';

import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';

const configuration = {
	issuer: 'https://sign-in.example.invalid',
	mode: 'private',
	ownerEmail: 'owner@example.invalid',
	toolPortalOrigin: 'https://portal.example.invalid',
	managementAudience: 'https://portal.example.invalid/management',
	centralIdentityAudience: 'https://central.example.invalid/identity',
	centralAdminAudience: 'https://central.example.invalid/admin',
	centralPersonLinkAudience: 'https://central.example.invalid/person-link',
	centralPublicOrigin: 'https://central.example.invalid',
	adminPageClientId: 'admin-page-local',
	ownerFleetCliClientId: 'owner-fleet-cli-local',
	organizationStatementLifetimeSeconds: 10_368_000,
	organizationIds: ['11111111-1111-7111-8111-111111111111'],
	ownerCliClientId: 'owner-cli-local',
	ownerCliRedirectUri: 'http://127.0.0.1/callback',
	turnstile: { kind: 'deployed', siteKey: '1x00000000000000000000AA' },
} as const;
const machineLogin = {
	routerClientId: '019a3dce-2000-7000-8000-0000000000f1',
	machineAudience: 'https://central.example.invalid/machine',
	linkUrlTemplate: 'https://sign-in.example.invalid/api/fleet/link/{organization_id}',
};

it('accepts a configuration without the person-link audience: the route is off', (): void => {
	expect(signInConfigurationSchema.safeParse(configuration).success).toBe(true);
	const { centralPersonLinkAudience: _offUntilConfigured, ...without } = configuration;
	const parsed = signInConfigurationSchema.safeParse(without);
	expect(parsed.success).toBe(true);
	expect(parsed.data?.centralPersonLinkAudience).toBeUndefined();
});

it('refuses a person-link audience that is not a URL', (): void => {
	expect(
		signInConfigurationSchema.safeParse({
			...configuration,
			centralPersonLinkAudience: 'person-link',
		}).success,
	).toBe(false);
});

it.each(['managementAudience', 'centralIdentityAudience', 'centralAdminAudience'] as const)(
	'refuses a person-link audience equal to %s',
	(other): void => {
		const parsed = signInConfigurationSchema.safeParse({
			...configuration,
			centralPersonLinkAudience: configuration[other],
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
			'The management, stamp, admin, person-link and configured machine audiences must be distinct',
		);
	},
);

it('refuses a person-link audience equal to the configured machine audience', (): void => {
	const distinct = signInConfigurationSchema.safeParse({ ...configuration, machineLogin });
	const shared = signInConfigurationSchema.safeParse({
		...configuration,
		machineLogin,
		centralPersonLinkAudience: machineLogin.machineAudience,
	});
	expect([distinct.success, shared.success]).toEqual([true, false]);
});
