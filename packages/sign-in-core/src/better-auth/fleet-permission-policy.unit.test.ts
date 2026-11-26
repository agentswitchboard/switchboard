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

it('owners hold all ten Fleet permissions and members hold none', (): void => {
	// PD 2530c3a3 defines the route grants. Sign-in D8 adds approval:decide for the owner.
	expect(fleetPermissionsForRole('owner')).toEqual([
		'approval:decide',
		'machine:enroll',
		'machine:revoke',
		'machine:setTokenLifetime',
		'organization:readAudit',
		'organization:view',
		'workspace:create',
		'workspaceAdmin:allowMachine',
		'workspaceAdmin:removeSession',
		'workspaceAdmin:withdrawMachine',
	]);
	expect(fleetPermissionsForRole('member')).toEqual([]);
	expect(fleetPermissionsForRole('admin')).toBeNull();
});
