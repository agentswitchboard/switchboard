import { describe, expect, it } from 'vitest';

import {
	fleetAdminOperationSchema,
	fleetPermissionSchema,
	permissionForFleetAdminOperation,
} from '#sign-in-core/organizations/fleet-permission';

describe('Fleet route permissions from the adopted PD table', () => {
	it.each([
		['CreateWorkspace', 'workspace:create'],
		['AllowMachine', 'workspaceAdmin:allowMachine'],
		['WithdrawMachineAllowance', 'workspaceAdmin:withdrawMachine'],
		['RemoveSession', 'workspaceAdmin:removeSession'],
		['RevokeMachineEnrollment', 'machine:revoke'],
		['SetTokenLifetime', 'machine:setTokenLifetime'],
		['IdentityLookup', 'organization:view'],
		['WorkspaceLookup', 'organization:view'],
		['MachineLookup', 'organization:view'],
		['CommandStatus', 'organization:view'],
		['WhoIsLoggedIn', 'organization:view'],
		['ReadAudit', 'organization:readAudit'],
	])('%s needs exactly %s', (operation, permission) => {
		// Arrange: literal expectations come from the Program Design's permission table.
		const parsed = fleetAdminOperationSchema.parse(operation);
		// Act / Assert
		expect(permissionForFleetAdminOperation(parsed)).toBe(permission);
	});
	it.each(['owner', 'member', 'workspace:delete', 'machine:Enroll', 'unknown:action'])(
		'refuses the non-permission %j',
		(permission) => {
			// Arrange / Act / Assert
			expect(fleetPermissionSchema.safeParse(permission).success).toBe(false);
		},
	);
	it('keeps internal decisions off the forwarded admin operation set', () => {
		// Arrange / Act / Assert: device-code approval is a verified service action, never a forwarded body.
		for (const operation of ['DecideDeviceLogin', 'DecideMachineToken', 'ProvisionOrganization'])
			expect(fleetAdminOperationSchema.safeParse(operation).success).toBe(false);
		expect(fleetPermissionSchema.options).toHaveLength(11);
	});
});
