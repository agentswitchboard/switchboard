import { z } from 'zod';

// The Fleet route permissions from PD 2530c3a3 and the owner approval grant from Sign-in D8.
export const fleetPermissionSchema = z.enum([
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
]);
export type FleetPermission = z.infer<typeof fleetPermissionSchema>;

export const fleetAdminOperationSchema = z.enum([
	'CreateWorkspace',
	'AllowMachine',
	'WithdrawMachineAllowance',
	'RemoveSession',
	'RevokeMachineEnrollment',
	'SetTokenLifetime',
	'IdentityLookup',
	'WorkspaceLookup',
	'MachineLookup',
	'CommandStatus',
	'WhoIsLoggedIn',
	'ReadAudit',
]);
export type FleetAdminOperation = z.infer<typeof fleetAdminOperationSchema>;

const requiredPermissions = {
	CreateWorkspace: 'workspace:create',
	AllowMachine: 'workspaceAdmin:allowMachine',
	WithdrawMachineAllowance: 'workspaceAdmin:withdrawMachine',
	RemoveSession: 'workspaceAdmin:removeSession',
	RevokeMachineEnrollment: 'machine:revoke',
	SetTokenLifetime: 'machine:setTokenLifetime',
	IdentityLookup: 'organization:view',
	WorkspaceLookup: 'organization:view',
	MachineLookup: 'organization:view',
	CommandStatus: 'organization:view',
	WhoIsLoggedIn: 'organization:view',
	ReadAudit: 'organization:readAudit',
} as const satisfies Readonly<Record<FleetAdminOperation, FleetPermission>>;

/** The transport selects an operation from its route before it parses a request body. */
export function permissionForFleetAdminOperation(operation: FleetAdminOperation): FleetPermission {
	return requiredPermissions[operation];
}
