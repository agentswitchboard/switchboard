import { expect, it } from 'vitest';

import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';
import { organizationStatementClaimsSchema } from '#sign-in-core/contracts/organization-statement';

const configured = {
	issuer: 'https://sign-in.example.invalid',
	mode: 'private',
	ownerEmail: 'owner@example.invalid',
	toolPortalOrigin: 'https://portal.example.invalid',
	managementAudience: 'https://portal.example.invalid/management',
	centralIdentityAudience: 'https://central.example.invalid/identity',
	centralAdminAudience: 'https://central.example.invalid/admin',
	centralPublicOrigin: 'https://central.example.invalid',
	adminPageClientId: 'admin-page-local',
	ownerFleetCliClientId: 'owner-fleet-cli-local',
	organizationStatementLifetimeSeconds: 10_368_000,
	organizationIds: ['11111111-1111-7111-8111-111111111111'],
	ownerCliClientId: 'owner-cli-local',
	ownerCliRedirectUri: 'http://127.0.0.1/callback',
	turnstile: { kind: 'deployed', siteKey: 'fixture-site-key' },
};
it('requires an explicit central audience and the 120-day lifetime without borrowing the person-token default', (): void => {
	expect(signInConfigurationSchema.safeParse(configured).success).toBe(true);
	const { centralIdentityAudience: _audience, ...withoutAudience } = configured;
	const { organizationStatementLifetimeSeconds: _lifetime, ...withoutLifetime } = configured;
	expect(signInConfigurationSchema.safeParse(withoutAudience).success).toBe(false);
	expect(signInConfigurationSchema.safeParse(withoutLifetime).success).toBe(false);
	expect(
		signInConfigurationSchema.safeParse({
			...configured,
			organizationStatementLifetimeSeconds: 300,
		}).success,
	).toBe(false);
	// The retired one-year value is refused, not silently accepted alongside the new one.
	expect(
		signInConfigurationSchema.safeParse({
			...configured,
			organizationStatementLifetimeSeconds: 31_536_000,
		}).success,
	).toBe(false);
});
it.each([
	{
		case: 'a path on the central origin',
		centralPublicOrigin: 'https://central.example.invalid/v1',
	},
	{ case: 'a trailing slash', centralPublicOrigin: 'https://central.example.invalid/' },
	{ case: 'a query', centralPublicOrigin: 'https://central.example.invalid?x=1' },
	{ case: 'the admin page reusing the CLI client ID', adminPageClientId: 'owner-cli-local' },
	{ case: 'the fleet CLI reusing the CLI client ID', ownerFleetCliClientId: 'owner-cli-local' },
	{
		case: 'the fleet CLI reusing the admin page client ID',
		ownerFleetCliClientId: 'admin-page-local',
	},
])(
	'refuses admin settings that would sign the wrong htu or merge two system clients: $case',
	({ case: _case, ...override }): void => {
		expect(signInConfigurationSchema.safeParse({ ...configured, ...override }).success).toBe(false);
	},
);
it('keeps the statement profile closed and the two organization claims equal', (): void => {
	const claims = {
		purpose: 'fleet-organization-stamp',
		version: 1,
		iss: configured.issuer,
		aud: configured.centralIdentityAudience,
		sub: configured.organizationIds[0],
		organization_id: configured.organizationIds[0],
		iat: 100,
		exp: 200,
	};
	expect(organizationStatementClaimsSchema.safeParse(claims).success).toBe(true);
	for (const extra of [
		{ sid: 'person-session' },
		{ replaces: null },
		{ replaces: 'A'.repeat(64) },
		{ sub: '22222222-2222-7222-8222-222222222222' },
	])
		expect(organizationStatementClaimsSchema.safeParse({ ...claims, ...extra }).success).toBe(
			false,
		);
});
