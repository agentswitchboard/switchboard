// Change records from Central's OrganizationAdminResult.fixtures.json at c58d1b22.
import type { OrganizationChangeRecord } from '#sign-in-core/central-link/generated/central-sign-in.gen';

export const organizationChangeFixtures = [
	{
		createdAtMillis: 1900000000000,
		id: '019a3dce-2000-7000-8000-000000000003',
		kind: 'organizationProvisioned',
		origin: {
			kind: 'signInProvisioning',
		},
		requestId: 'stamp:digest-fixture',
		targetId: '019a3dce-2000-7000-8000-000000000001',
	},
	{
		createdAtMillis: 1900000001000,
		id: '019a3dce-2000-7000-8000-000000000004',
		kind: 'stampRenewed',
		origin: {
			kind: 'signInProvisioning',
		},
		requestId: 'renewal:digest-fixture',
		targetId: '019a3dce-2000-7000-8000-000000000001',
	},
	{
		createdAtMillis: 1900000002000,
		id: '019a3dce-2000-7000-8000-000000000005',
		kind: 'workspaceCreated',
		origin: {
			kind: 'person',
			permissionChecked: 'workspace:create',
			personId: '019a3dce-2000-7000-8000-000000000006',
		},
		requestId: 'person:fixture-operation',
		targetId: '019a3dce-2000-7000-8000-000000000002',
	},
	{
		createdAtMillis: 1900000003000,
		id: '019a3dce-2000-7000-8000-000000000010',
		kind: 'machineEnrolled',
		origin: {
			kind: 'person',
			permissionChecked: 'machine:enroll',
			personId: '019a3dce-2000-7000-8000-000000000006',
		},
		requestId:
			'019a3dce-2000-7000-8000-000000000014:machineEnrolled:019a3dce-2000-7000-8000-000000000007',
		targetId: '019a3dce-2000-7000-8000-000000000007',
	},
	{
		createdAtMillis: 1900000004000,
		id: '019a3dce-2000-7000-8000-000000000011',
		kind: 'machineRevoked',
		origin: {
			kind: 'person',
			permissionChecked: 'machine:revoke',
			personId: '019a3dce-2000-7000-8000-000000000006',
		},
		requestId:
			'019a3dce-2000-7000-8000-000000000015:machineRevoked:019a3dce-2000-7000-8000-000000000007',
		targetId: '019a3dce-2000-7000-8000-000000000007',
	},
	{
		createdAtMillis: 1900000005000,
		id: '019a3dce-2000-7000-8000-000000000012',
		kind: 'machineExpired',
		origin: {
			kind: 'automatic',
		},
		requestId:
			'019a3dce-2000-7000-8000-000000000007:machineExpired:019a3dce-2000-7000-8000-000000000007',
		targetId: '019a3dce-2000-7000-8000-000000000007',
	},
	{
		createdAtMillis: 1900000006000,
		id: '019a3dce-2000-7000-8000-000000000013',
		kind: 'allowanceChanged',
		origin: {
			kind: 'automatic',
		},
		requestId:
			'019a3dce-2000-7000-8000-000000000007:allowanceChanged:019a3dce-2000-7000-8000-000000000002',
		targetId: '019a3dce-2000-7000-8000-000000000002',
	},
	{
		createdAtMillis: 1900000007000,
		id: '019a3dce-2000-7000-8000-000000000016',
		kind: 'machineAllowanceChanged',
		machineId: '019a3dce-2000-7000-8000-000000000007',
		origin: {
			kind: 'person',
			permissionChecked: 'machine:enroll',
			personId: '019a3dce-2000-7000-8000-000000000006',
		},
		requestId: 'allowance-granted',
		state: 'active',
		workspaceId: '019a3dce-2000-7000-8000-000000000002',
	},
	{
		createdAtMillis: 1900000008000,
		id: '019a3dce-2000-7000-8000-000000000017',
		kind: 'machineAllowanceChanged',
		machineId: '019a3dce-2000-7000-8000-000000000007',
		origin: {
			kind: 'automatic',
		},
		requestId: 'allowance-expired',
		state: 'withdrawn',
		workspaceId: '019a3dce-2000-7000-8000-000000000002',
	},
] as const satisfies readonly OrganizationChangeRecord[];
