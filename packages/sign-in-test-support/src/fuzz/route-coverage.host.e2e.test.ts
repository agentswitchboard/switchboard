import { afterAll, beforeAll, expect, it } from 'vitest';

import {
	actualOuterRoutes,
	ambiguousMethodMismatches,
	servedOuterRoutes,
} from '#sign-in-test-support/fuzz/outer-handler-routes';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { routeClassification, routeKey } from '#sign-in-test-support/fuzz/route-classification';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { installedProviderEndpointInventory } from '#sign-in-test-support/test-fixtures/provider-endpoint-inventory';

useControlledSignInClock();

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
	const classificationKeys = routeClassification.map(routeKey);
	expect(new Set(classificationKeys).size).toBe(classificationKeys.length);
	const classified = new Set(classificationKeys);
	const providerKeys = new Set(inventory.httpRoutes.map(routeKey));
	// Every installed provider route is classified, and every classified route is installed or an
	// outer pair the real route predicate admits (no stale row).
	expect([...providerKeys].filter((key) => !classified.has(key))).toEqual([]);
	const predicateAdmitted = new Set(
		actualOuterRoutes(routeClassification.map((row) => row.path)).map(routeKey),
	);
	expect(
		classificationKeys.filter((key) => !providerKeys.has(key) && !predicateAdmitted.has(key)),
	).toEqual([]);
	// Every pair the live outer handler serves is classified, and every classified method of a path
	// admitted under every method is served: a new page, a new method on a known path, a stale method
	// or a method the plain probe cannot tell from a refusal all fail here. Each probe is a well-formed
	// request of its kind from a fresh browser address, so no quota skews an answer.
	let probe = 0;
	const classifiedPaths = routeClassification.map((row) => row.path);
	const served = await servedOuterRoutes({
		classifiedPaths,
		issuerOrigin: new URL(harness.issuer).origin,
		answer: async (route, init) => {
			probe += 1;
			harness.useBrowser(`route-probe-${probe}`);
			// No cookie from an earlier probe (the relay refuses any cookie), and a fresh captcha token for
			// the routes that demand one before they look at the method.
			harness.clearBrowserSession();
			const response = await harness.auth(route.path, {
				...init,
				headers: {
					...Object.fromEntries(new Headers(init.headers)),
					'x-captcha-response': harness.turnstile.issueToken({
						action: 'sign_in_social',
						hostname: new URL(harness.issuer).hostname,
						verdict: 'accepted',
					}),
				},
				redirect: 'manual',
			});
			return `${response.status} ${await response.text()}`;
		},
	});
	expect(served.map(routeKey).filter((key) => !classified.has(key))).toEqual([]);
	expect(
		ambiguousMethodMismatches({
			served,
			classification: routeClassification,
			admitted: actualOuterRoutes(classifiedPaths),
		}),
	).toEqual([]);
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
