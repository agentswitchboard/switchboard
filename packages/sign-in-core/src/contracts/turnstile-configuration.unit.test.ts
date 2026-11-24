import { expect, test } from 'vitest';

import { signInConfigurationSchema } from '#sign-in-core/contracts/deployment-configuration';

const configuration = {
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
	turnstile: { kind: 'deployed', siteKey: '1x00000000000000000000AA' },
};

test('Turnstile accepts a deployed issuer with mandatory site configuration', () => {
	expect(signInConfigurationSchema.safeParse(configuration).success).toBe(true);
});

test.each(['localhost', 'localhost.', 'app.localhost', '127.0.0.1', '127.2.3.4', '[::1]'])(
	'Turnstile refuses deployed configuration for loopback issuer %s',
	(hostname: string): void => {
		expect(
			signInConfigurationSchema.safeParse({
				...configuration,
				issuer: `http://${hostname}:3000`,
			}).success,
		).toBe(false);
	},
);

test.each(['localhost', '127.0.0.1', '[::1]'])(
	'Turnstile accepts explicitly local configuration for %s',
	(hostname: string): void => {
		expect(
			signInConfigurationSchema.safeParse({
				...configuration,
				issuer: `http://${hostname}:3000`,
				turnstile: { ...configuration.turnstile, kind: 'local' },
			}).success,
		).toBe(true);
	},
);

test('Turnstile refuses a local profile on a non-local issuer', () => {
	expect(
		signInConfigurationSchema.safeParse({
			...configuration,
			turnstile: { ...configuration.turnstile, kind: 'local' },
		}).success,
	).toBe(false);
});

test('Turnstile refuses a verifier override in deployed configuration', () => {
	expect(
		signInConfigurationSchema.safeParse({
			...configuration,
			turnstile: {
				...configuration.turnstile,
				siteVerifyURLOverride: 'http://127.0.0.1:3001/siteverify',
			},
		}).success,
	).toBe(false);
});

test('Turnstile accepts a local verifier and refuses an external override', () => {
	const local = {
		...configuration,
		issuer: 'http://127.0.0.1:3000',
		turnstile: {
			...configuration.turnstile,
			kind: 'local',
			siteVerifyURLOverride: 'http://127.0.0.1:3001/siteverify',
		},
	};
	expect(signInConfigurationSchema.safeParse(local).success).toBe(true);
	expect(
		signInConfigurationSchema.safeParse({
			...local,
			turnstile: {
				...local.turnstile,
				siteVerifyURLOverride: 'https://untrusted.example.invalid/siteverify',
			},
		}).success,
	).toBe(false);
});

test('Turnstile is mandatory and has no no-captcha configuration fallback', () => {
	const { turnstile: _turnstile, ...withoutCaptcha } = configuration;
	expect(signInConfigurationSchema.safeParse(withoutCaptcha).success).toBe(false);
});
