import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access';

// Keep the native plugin permissions: its endpoints check these names before our hooks run.
export const organizationAccessControl = createAccessControl({
	...defaultStatements,
	organization: [...defaultStatements.organization, 'view', 'readAudit', 'repairWork'],
	machine: ['enroll', 'revoke', 'setTokenLifetime'],
	workspace: ['create'],
	workspaceAdmin: ['allowMachine', 'withdrawMachine', 'removeSession'],
	approval: ['decide'],
});

export const organizationRoles = {
	owner: organizationAccessControl.newRole({
		...ownerAc.statements,
		organization: [...ownerAc.statements.organization, 'view', 'readAudit', 'repairWork'],
		machine: ['enroll', 'revoke', 'setTokenLifetime'],
		workspace: ['create'],
		workspaceAdmin: ['allowMachine', 'withdrawMachine', 'removeSession'],
		approval: ['decide'],
	}),
	member: organizationAccessControl.newRole({}),
};
