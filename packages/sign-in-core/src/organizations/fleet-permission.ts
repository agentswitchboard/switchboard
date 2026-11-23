import { z } from 'zod';

import type { FleetPermission as CentralFleetPermission } from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';

// PD 2530c3a3: exactly the ten route permissions (C3 added `approval:decide`). Central's generated
// FleetPermission must equal this set; the check below fails the build when either side moves.
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
/** Exact in both directions: a permission added on either side alone breaks the build. */
export type FleetPermissionMatchesCentral = AssertWireType<
	WireTypesEqual<FleetPermission, CentralFleetPermission>
>;
type SignInOnlyPermissionMatches = WireTypesEqual<
	FleetPermission | 'approval:pass',
	CentralFleetPermission
>;
type CentralOnlyPermissionMatches = WireTypesEqual<
	FleetPermission,
	CentralFleetPermission | 'approval:pass'
>;
export type FleetPermissionEqualityControls = [
	// @ts-expect-error A permission sign-in grants that central does not know breaks the build.
	AssertWireType<SignInOnlyPermissionMatches>,
	// @ts-expect-error A permission central checks that sign-in cannot grant breaks the build.
	AssertWireType<CentralOnlyPermissionMatches>,
];

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
