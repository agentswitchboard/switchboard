import { afterAll, beforeAll, expect, it } from 'vitest';

import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import {
	routeClassification,
	routeKey,
	type RouteIdentity,
} from '#sign-in-test-support/fuzz/route-classification';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { installedProviderEndpointInventory } from '#sign-in-test-support/test-fixtures/provider-endpoint-inventory';

useControlledSignInClock();

// Method identities for outer-owned entries. Source discovery independently checks the
// paths and prefixes, including new branches, rather than trusting this list alone.
const handlerRoutes: readonly RouteIdentity[] = [
	{ method: 'GET', path: '/sign-in' },
	{ method: 'GET', path: '/owner-ready' },
	{ method: 'GET', path: '/organization-admin' },
	{ method: 'GET', path: '/.well-known/oauth-authorization-server' },
	{ method: 'GET', path: '/.well-known/openid-configuration' },
	{ method: 'GET', path: '/api/auth/callback/google' },
	{ method: 'GET', path: '/api/auth/callback/github' },
	{ method: 'POST', path: '/api/auth/callback/google' },
	{ method: 'POST', path: '/api/auth/callback/github' },
	{ method: 'POST', path: '/api/auth/owner/bootstrap' },
	{ method: 'POST', path: '/api/auth/organization-admin/create-workspace' },
	{ method: 'POST', path: '/api/auth/organization-admin/workspace-lookup' },
	{ method: 'POST', path: '/api/auth/organization-admin/change-records' },
	{ method: 'POST', path: '/api/auth/organization-admin/v1/create-workspace' },
	{ method: 'POST', path: '/api/auth/organization-admin/v1/workspace-lookup' },
	{ method: 'POST', path: '/api/auth/organization-admin/v1/change-records' },
];

let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
beforeAll(async () => {
	harness = await startLocalAuthHarness();
});
afterAll(async () => {
	await harness?.close();
});

it('classifies exactly the installed provider and outer-handler routes, and gives every reachable route a family', async () => {
	const inventory = await installedProviderEndpointInventory(
		harness.miniflare,
		harness.providerConfiguration,
	);
	expect(inventory.noHttpPathApis).toEqual([
		{ endpointName: 'addMember', serverOnly: false },
		{ endpointName: 'generateTOTP', serverOnly: true },
		{ endpointName: 'prepareOrganizationFleetCall', serverOnly: true },
		{ endpointName: 'readShellSession', serverOnly: true },
		{ endpointName: 'recoverForgottenOrganization', serverOnly: true },
		{ endpointName: 'reSignOrganizationsForKeyChange', serverOnly: true },
		{ endpointName: 'setPassword', serverOnly: true },
		{ endpointName: 'signJWT', serverOnly: true },
		{ endpointName: 'signOrganizationStatement', serverOnly: true },
		{ endpointName: 'verifyJWT', serverOnly: true },
		{ endpointName: 'viewBackupCodes', serverOnly: true },
	]);
	const installedKeys = new Set([...inventory.httpRoutes, ...handlerRoutes].map(routeKey));
	const classificationKeys = routeClassification.map(routeKey);
	expect(new Set(classificationKeys).size).toBe(classificationKeys.length);
	expect([...installedKeys].toSorted()).toEqual(classificationKeys.toSorted());
	for (const route of inventory.httpRoutes) {
		const row = routeClassification.find((candidate) => routeKey(candidate) === routeKey(route));
		expect(row?.providerServerOnly).toBe(route.serverOnly);
	}
	const reachableKeys = routeClassification
		.filter((row) => !row.exposure.includes('blocked') && !row.exposure.includes('server-only'))
		.map(routeKey)
		.toSorted();
	const familyKeys = requestFamilies.map((family) => routeKey(family.route));
	expect(new Set(familyKeys).size).toBe(familyKeys.length);
	expect(familyKeys.toSorted()).toEqual(reachableKeys);
});
