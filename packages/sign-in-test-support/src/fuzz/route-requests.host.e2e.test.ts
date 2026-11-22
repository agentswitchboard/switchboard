import * as hegel from '@hegeldev/hegel';
import { afterAll, expect, it } from 'vitest';

import { boundShrinking, fuzzSeed, fuzzSettings } from '#sign-in-test-support/fuzz/fuzz-settings';
import { createRequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import {
	assertDocumentedErrorBody,
	assertRequestDisclosure,
	observeRequestAnswer,
} from '#sign-in-test-support/fuzz/request-disclosure';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { syntheticRequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/synthetic-context';
import { assertRequestRefusalEffects } from '#sign-in-test-support/fuzz/request-refusal-effects';
import { createCallerHarnessLanes } from '#sign-in-test-support/fuzz/request-shared-harness';
import { readRequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import { routeClassification, routeKey } from '#sign-in-test-support/fuzz/route-classification';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();

// Design B on the Node host: one host per caller, the callers running at the same time. On the
// workerd host the three runtimes plus the sequence file oversubscribe the CPU (measured: slower
// than one host, and two extra unreproducible failures), so every caller shares one host there.
// Every case still resets storage and uses a fresh browser address on its host.
const lanes = createCallerHarnessLanes(['signed-out', 'member', 'owner'] as const, {
	concurrent: process.env.SIGN_IN_TEST_HOST === 'node',
});
afterAll(async () => lanes.close());

for (const family of requestFamilies) {
	for (const caller of family.callers) {
		it.concurrent(`S2 ${routeKey(family.route)} as ${caller}: documented-answer, credential-disclosure, identity-disclosure, refusal-effects`, async () => {
			const classification = routeClassification.find(
				(row) => routeKey(row) === routeKey(family.route),
			);
			if (classification === undefined)
				throw new Error('S1 classification missing for request family');
			let caseNumber = 0;
			await lanes.run(caller, async (harness) => {
				await hegel.testAsync(
					boundShrinking(async (testCase, note): Promise<void> => {
						caseNumber += 1;
						process.stdout.write(
							JSON.stringify({
								event: 'F1-case-start',
								route: routeKey(family.route),
								caller,
								caseNumber,
							}) + '\n',
						);
						const fixture = await createRequestCaseFixture({
							caller,
							path: family.route.path,
							existingHarness: harness,
						});
						const generated = family.generate(testCase, fixture.context, caseNumber - 1);
						note(
							`S5 seed=${fuzzSeed}; route=${routeKey(family.route)}; caller=${caller}; variant=${generated.label}`,
						);
						const before = await readRequestStorageSnapshot(fixture.harness.database);
						const response = await fixture.harness.auth(generated.pathname, {
							...generated.init,
							headers: {
								...Object.fromEntries(new Headers(generated.init.headers)),
								cookie: fixture.cookie,
							},
						});
						const answer = await observeRequestAnswer(response);
						await fixture.harness.settleDeferredWork();
						const after = await readRequestStorageSnapshot(fixture.harness.database);
						expect(
							answer.status,
							'S2 no-server-error: generated input without injected storage faults',
						).toBeLessThan(500);
						expect(classification.documentedAnswers, 'S2 documented-answer').toContain(
							answer.status,
						);
						assertDocumentedErrorBody({
							documentedErrorBodies: classification.documentedErrorBodies,
							answer,
						});
						assertRequestDisclosure({
							fixture,
							path: family.route.path,
							request: generated,
							answer,
							before,
							after,
						});
						if (answer.status >= 400 || answer.headers.get('location')?.includes('error='))
							assertRequestRefusalEffects({
								classification,
								fixture,
								before,
								after,
								request: generated,
							});
						process.stdout.write(
							JSON.stringify({
								event: 'F1-case-end',
								route: routeKey(family.route),
								caller,
								caseNumber,
							}) + '\n',
						);
					}),
					fuzzSettings(family.coverageCases(syntheticRequestFamilyContext)),
				);
			});
		});
	}
}
