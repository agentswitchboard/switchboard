import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { hasPermission } from 'better-auth/plugins/organization';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	organizationAccessControl,
	organizationRoles,
} from '#sign-in-core/better-auth/organization-access-control';
import { checkOrganizationPermission } from '#sign-in-core/better-auth/organization-permission-check';
import {
	fleetPermissionSchema,
	type FleetPermission,
} from '#sign-in-core/organizations/fleet-permission';
import {
	organizationIdSchema,
	personIdSchema,
	type OrganizationId,
} from '#sign-in-core/storage/models/sign-in-store';

vi.mock('better-auth/plugins/organization', async (importOriginal) => {
	const original = await importOriginal<typeof import('better-auth/plugins/organization')>();
	return { ...original, hasPermission: vi.fn(original.hasPermission) };
});

const issuer = 'https://sign-in.example.invalid';
const verifiedPerson = personIdSchema.parse('11111111-1111-7111-8111-111111111111');
const firstOrganization = organizationIdSchema.parse('22222222-2222-7222-8222-222222222222');
const requestOrganization = organizationIdSchema.parse('33333333-3333-7333-8333-333333333333');
type MemberRoleReader = Parameters<typeof checkOrganizationPermission>[0]['readMemberRole'];

// The member read and verified identity are controlled at this unit layer.
// Better Auth creates the real endpoint context and applies its real permission helper.
function permissionEndpoint(
	readMemberRole: MemberRoleReader,
	poisonRoleCache = false,
): {
	readonly request: (
		organizationId: OrganizationId,
		permission: FleetPermission,
	) => Promise<unknown>;
} {
	const endpoint = createAuthEndpoint(
		'/unit-permission',
		{
			method: 'POST',
			body: z.strictObject({
				organizationId: organizationIdSchema,
				permission: fleetPermissionSchema,
			}),
		},
		async (context) => {
			if (poisonRoleCache)
				await hasPermission(
					{
						role: 'owner',
						organizationId: context.body.organizationId,
						permissions: { organization: ['view'] },
						options: {
							ac: organizationAccessControl,
							roles: { owner: organizationRoles.member },
							dynamicAccessControl: { enabled: false },
						},
						useMemoryCache: false,
					},
					context,
				);
			return context.json(
				await checkOrganizationPermission({
					context,
					personId: verifiedPerson,
					organizationId: context.body.organizationId,
					permission: context.body.permission,
					readMemberRole,
				}),
			);
		},
	);
	const auth = betterAuth({
		baseURL: issuer,
		secret: 'test-only-permission-context-secret-'.repeat(3),
		plugins: [{ id: 'unit-permission-context', endpoints: { permissionCheck: endpoint } }],
	});
	return {
		async request(organizationId, permission): Promise<unknown> {
			const response = await auth.handler(
				new Request(`${issuer}/api/auth/unit-permission`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: issuer },
					body: JSON.stringify({ organizationId, permission }),
				}),
			);
			expect(response.status).toBe(200);
			const body: unknown = await response.json();
			return body;
		},
	};
}

beforeEach((): void => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
});
afterEach((): void => {
	vi.useRealTimers();
});

describe('fresh organization permission checks in a native endpoint context', () => {
	it.each([
		['workspace:create', { workspace: ['create'] }],
		['workspaceAdmin:allowMachine', { workspaceAdmin: ['allowMachine'] }],
		['workspaceAdmin:withdrawMachine', { workspaceAdmin: ['withdrawMachine'] }],
		['workspaceAdmin:removeSession', { workspaceAdmin: ['removeSession'] }],
		['machine:enroll', { machine: ['enroll'] }],
		['machine:revoke', { machine: ['revoke'] }],
		['machine:setTokenLifetime', { machine: ['setTokenLifetime'] }],
		['organization:view', { organization: ['view'] }],
		['organization:readAudit', { organization: ['readAudit'] }],
		['approval:decide', { approval: ['decide'] }],
		['organization:repairWork', { organization: ['repairWork'] }],
	] as const)('grants the owner and refuses a member for %s', async (permission, permissions) => {
		// Arrange
		let role = 'owner';
		const endpoint = permissionEndpoint(async () => ({ kind: 'available', value: role }));
		// Act / Assert: a subsequent request must observe the changed member row.
		await expect(endpoint.request(requestOrganization, permission)).resolves.toEqual({
			kind: 'available',
			value: true,
		});
		role = 'member';
		await expect(endpoint.request(requestOrganization, permission)).resolves.toEqual({
			kind: 'available',
			value: false,
		});
		// Both roles could hide a wrong-action mapping: owner grants every action and member none.
		// The spy still executes the original helper, and records the action actually checked.
		expect(
			vi.mocked(hasPermission).mock.calls.map(([input]) => ({
				organizationId: input.organizationId,
				permissions: input.permissions,
				useMemoryCache: input.useMemoryCache,
			})),
		).toEqual([
			{ organizationId: requestOrganization, permissions, useMemoryCache: false },
			{ organizationId: requestOrganization, permissions, useMemoryCache: false },
		]);
	});
	it('reads the verified person in the request organization every time, including after removal', async () => {
		// Arrange: owning the first organization confers nothing in the second.
		const reads: unknown[] = [];
		let memberPresent = true;
		const endpoint = permissionEndpoint(async (request) => {
			reads.push(request);
			return {
				kind: 'available',
				value: request.organizationId === firstOrganization && memberPresent ? 'owner' : null,
			};
		});
		// Act / Assert
		await expect(endpoint.request(firstOrganization, 'organization:view')).resolves.toEqual({
			kind: 'available',
			value: true,
		});
		await expect(endpoint.request(requestOrganization, 'organization:view')).resolves.toEqual({
			kind: 'available',
			value: false,
		});
		memberPresent = false;
		await expect(endpoint.request(firstOrganization, 'organization:view')).resolves.toEqual({
			kind: 'available',
			value: false,
		});
		expect(reads).toEqual([
			{ personId: verifiedPerson, organizationId: firstOrganization },
			{ personId: verifiedPerson, organizationId: requestOrganization },
			{ personId: verifiedPerson, organizationId: firstOrganization },
		]);
	});
	it('preserves an unavailable member read instead of treating it as a grant or missing member', async () => {
		// Arrange
		const failure = { kind: 'store-unavailable', reason: 'database-error' } as const;
		const endpoint = permissionEndpoint(async () => failure);
		// Act / Assert
		await expect(endpoint.request(requestOrganization, 'organization:view')).resolves.toEqual(
			failure,
		);
	});
	it('ignores a stale native role cache and uses the configured access-control roles', async () => {
		// Arrange: the real helper first caches an owner role with no permissions for this organization.
		const endpoint = permissionEndpoint(async () => ({ kind: 'available', value: 'owner' }), true);
		// Act / Assert: useMemoryCache:true would reuse that role and incorrectly refuse the owner.
		await expect(endpoint.request(requestOrganization, 'organization:view')).resolves.toEqual({
			kind: 'available',
			value: true,
		});
	});
});
