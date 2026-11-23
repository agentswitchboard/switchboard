import { expect, it } from 'vitest';

import {
	fleetPermissionPolicy,
	fleetPermissionsForRole,
} from '#sign-in-core/better-auth/fleet-permission-policy';
import { canonicalJsonSha256Hex } from '#sign-in-core/contracts/canonical-json';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';

it('the pinned digest is the SHA-256 of the canonical policy, so a changed mapping cannot keep it', async (): Promise<void> => {
	await expect(canonicalJsonSha256Hex(globalThis.crypto, fleetPermissionPolicy)).resolves.toBe(
		fleetPermissionPolicyDigest,
	);
});

it('owners hold all eleven Fleet permissions and members hold none', (): void => {
	// Expected sets come from PD 2530c3a3's route permissions, C3's owner-only `approval:decide` and `organization:repairWork`, and
	// B2's "a member holds no permissions".
	expect(fleetPermissionsForRole('owner')).toEqual([
		'approval:decide',
		'machine:enroll',
		'machine:revoke',
		'machine:setTokenLifetime',
		'organization:readAudit',
		'organization:repairWork',
		'organization:view',
		'workspace:create',
		'workspaceAdmin:allowMachine',
		'workspaceAdmin:removeSession',
		'workspaceAdmin:withdrawMachine',
	]);
	expect(fleetPermissionsForRole('member')).toEqual([]);
	expect(fleetPermissionsForRole('admin')).toBeNull();
});
