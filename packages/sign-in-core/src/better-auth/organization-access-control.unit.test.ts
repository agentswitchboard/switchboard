import { describe, expect, it } from 'vitest';

import {
	organizationAccessControl,
	organizationRoles,
} from '#sign-in-core/better-auth/organization-access-control';
import { createOrganizationRoleHooks } from '#sign-in-core/better-auth/organization-role-hooks';

describe('organization roles on the native plugin statement', () => {
	it('grants owner every declared native and Fleet action while member has no permission', () => {
		// Arrange: each literal is an action the adopted PD binds to an offered operation.
		const statements = organizationAccessControl.statements;
		// Act / Assert: use the plugin's real role authorizer, not a copy of its lookup.
		expect(organizationRoles.owner.authorize({ invitation: ['create', 'cancel'] }).success).toBe(
			true,
		);
		expect(organizationRoles.owner.authorize({ member: ['delete'] }).success).toBe(true);
		expect(
			organizationRoles.owner.authorize({ machine: ['enroll', 'revoke', 'setTokenLifetime'] })
				.success,
		).toBe(true);
		expect(organizationRoles.owner.authorize({ workspace: ['create'] }).success).toBe(true);
		expect(
			organizationRoles.owner.authorize({
				workspaceAdmin: ['allowMachine', 'withdrawMachine', 'removeSession'],
			}).success,
		).toBe(true);
		expect(organizationRoles.owner.authorize({ organization: ['view', 'readAudit'] }).success).toBe(
			true,
		);
		// C3: `approval:decide` is the owner's alone.
		expect(organizationRoles.owner.authorize({ approval: ['decide'] }).success).toBe(true);
		for (const [resource, actions] of Object.entries(statements))
			for (const action of actions)
				expect(organizationRoles.member.authorize({ [resource]: [action] }).success).toBe(false);
		expect(Object.keys(organizationRoles).toSorted()).toEqual(['member', 'owner']);
	});
});

const user = {
	id: 'person',
	name: 'Person',
	email: 'person@example.invalid',
	emailVerified: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};
const organization = {
	id: 'organization',
	name: 'Organization',
	slug: 'organization',
	createdAt: new Date(0),
};
const context = { user, organization };
function member(role: string): {
	readonly id: string;
	readonly userId: string;
	readonly organizationId: string;
	readonly role: string;
	readonly createdAt: Date;
} {
	return {
		id: 'membership',
		userId: user.id,
		organizationId: organization.id,
		role,
		createdAt: new Date(0),
	};
}
function invitation(role: string): {
	readonly email: string;
	readonly role: string;
	readonly organizationId: string;
	readonly inviterId: string;
} {
	return { email: user.email, role, organizationId: organization.id, inviterId: user.id };
}

describe('the organization plugin role hooks', () => {
	it.each(['admin', 'owner,member', 'member,owner', 'manager', ''])(
		'refuses unsupported role %j at every role-setting hook',
		async (role) => {
			// Arrange
			const hooks = createOrganizationRoleHooks();
			// Act / Assert: the plugin stops the write when its before hook rejects.
			await expect(hooks.beforeAddMember({ ...context, member: member(role) })).rejects.toThrow(
				'organization-role-not-allowed',
			);
			await expect(
				hooks.beforeUpdateMemberRole({ ...context, member: member('member'), newRole: role }),
			).rejects.toThrow('organization-role-not-allowed');
			await expect(
				hooks.beforeCreateInvitation({ organization, inviter: user, invitation: invitation(role) }),
			).rejects.toThrow('organization-role-not-allowed');
		},
	);
	it('refuses owner invitations and owner removal; an ordinary member remains removable', async () => {
		// Arrange
		const hooks = createOrganizationRoleHooks();
		// Act / Assert
		await expect(
			hooks.beforeCreateInvitation({
				organization,
				inviter: user,
				invitation: invitation('owner'),
			}),
		).rejects.toThrow('owner-invitation-not-allowed');
		await expect(hooks.beforeRemoveMember({ ...context, member: member('owner') })).rejects.toThrow(
			'owner-removal-not-allowed',
		);
		await expect(
			hooks.beforeCreateInvitation({
				organization,
				inviter: user,
				invitation: invitation('member'),
			}),
		).resolves.toBeUndefined();
		await expect(
			hooks.beforeRemoveMember({ ...context, member: member('member') }),
		).resolves.toBeUndefined();
	});
});
