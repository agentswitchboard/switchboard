import { describe, expect, it } from 'vitest';

import { personSessionConfirmationSchema } from '#sign-in-core/contracts/person-identity-contracts';

const activeSession = {
	active: true,
	sub: '11111111-1111-7111-8111-111111111111',
	sid: '22222222-2222-7222-8222-222222222222',
	aud: 'https://central.example.invalid/admin',
	exp: 2_208_989_400,
	organization_id: '33333333-3333-7333-8333-333333333333',
	checkedAt: 2_208_988_800_000,
};

describe('K5 names the permission checked for this request', () => {
	it.each([
		'workspace:create',
		'workspaceAdmin:allowMachine',
		'workspaceAdmin:withdrawMachine',
		'workspaceAdmin:removeSession',
		'machine:enroll',
		'machine:revoke',
		'machine:setTokenLifetime',
		'organization:view',
		'organization:readAudit',
		'approval:decide',
	])('carries the checked permission %s', (permission) => {
		// Arrange / Act: the literal set is the Program Design's route permissions plus C3's approval:decide.
		const confirmation = personSessionConfirmationSchema.parse({ ...activeSession, permission });
		// Assert
		expect(confirmation).toMatchObject({ ...activeSession, permission });
	});
	it.each(['owner', 'member', 'workspace:delete', 'machine:Enroll', 'unknown:action'])(
		'refuses %s as a checked permission',
		(permission) => {
			// Arrange / Act / Assert: role names and undeclared actions cannot authorize a route.
			expect(
				personSessionConfirmationSchema.safeParse({ ...activeSession, permission }).success,
			).toBe(false);
		},
	);
	it('refuses an active confirmation without a checked permission', () => {
		// Arrange / Act / Assert
		expect(personSessionConfirmationSchema.safeParse(activeSession).success).toBe(false);
	});
	it('keeps an inactive answer free of permission and identity details', () => {
		// Arrange / Act / Assert
		expect(personSessionConfirmationSchema.parse({ active: false })).toEqual({ active: false });
		expect(
			personSessionConfirmationSchema.safeParse({ active: false, permission: 'organization:view' })
				.success,
		).toBe(false);
	});
});
