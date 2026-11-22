import * as hegel from '@hegeldev/hegel';
import { afterAll, expect, it } from 'vitest';

import { readCentralAcknowledgements } from '#sign-in-test-support/fuzz/central-acknowledgements';
import {
	boundShrinking,
	fuzzCasesOverride,
	fuzzSeed,
	fuzzSettingsExact,
} from '#sign-in-test-support/fuzz/fuzz-settings';
import { createRequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import {
	assertDocumentedErrorBody,
	assertGenericRefusalBody,
	assertRequestDisclosure,
	observeRequestAnswer,
} from '#sign-in-test-support/fuzz/request-disclosure';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { variantKey } from '#sign-in-test-support/fuzz/request-families/request-family';
import { syntheticRequestFamilyContext } from '#sign-in-test-support/fuzz/request-families/synthetic-context';
import { assertRequestRefusalEffects } from '#sign-in-test-support/fuzz/request-refusal-effects';
import { createCallerHarnessLanes } from '#sign-in-test-support/fuzz/request-shared-harness';
import { readRequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import {
	documentedAnswersFor,
	routeClassification,
	routeKey,
} from '#sign-in-test-support/fuzz/route-classification';
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

/**
 * One group (a route as a caller): the coverage pass visits every variant family of the route once,
 * each as its own Hegel run whose variant is fixed by the step it is closed over (so a replay or a
 * shrink candidate is always the same variant family, a function of the draw alone), then any extra
 * cases (a deep `SIGN_IN_FUZZ_CASES`) draw their variant family from the same list. The plan comes
 * from the real fixture context of the group's first case, and every later case must see the same
 * field inventory.
 */
for (const family of requestFamilies) {
	for (const caller of family.callers) {
		it.concurrent(`S2 ${routeKey(family.route)} as ${caller}: documented-answer, credential-disclosure, identity-disclosure, refusal-effects`, async () => {
			const classification = routeClassification.find(
				(row) => routeKey(row) === routeKey(family.route),
			);
			if (classification === undefined)
				throw new Error('S1 classification missing for request family');
			await lanes.run(caller, async (harness) => {
				let caseNumber = 0;
				let planKeys: readonly string[] | undefined;
				const runCases = async (props: {
					readonly stepIndex: number | undefined;
					readonly cases: number;
					readonly seedOffset: number;
				}): Promise<void> => {
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
							const steps = family.variantSteps(fixture.context);
							const keys = steps.map(variantKey);
							planKeys ??= keys;
							expect(keys, 'S2 live field inventory changed between cases').toEqual(planKeys);
							// The unit proofs (request-budget.unit.test.ts) use the synthetic context: it must carry the live field inventory.
							expect(keys, 'S2 live field inventory differs from the proved one').toEqual(
								family.variantSteps(syntheticRequestFamilyContext).map(variantKey),
							);
							const generated = family.generate(
								testCase,
								fixture.context,
								props.stepIndex === undefined ? undefined : steps[props.stepIndex],
							);
							note(
								`S5 seed=${fuzzSeed}+${props.seedOffset}; route=${routeKey(family.route)}; caller=${caller}; variant=${variantKey(generated.variant)}`,
							);
							const before = await readRequestStorageSnapshot(fixture.harness.database);
							const exchangesBefore = fixture.harness.centralProvisioning.exchanges.length;
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
							expect(
								documentedAnswersFor(classification, caller),
								'S2 documented-answer',
							).toContain(answer.status);
							assertDocumentedErrorBody({
								documentedErrorBodies: classification.documentedErrorBodies,
								answer,
								caller,
								request: generated,
							});
							assertGenericRefusalBody(answer, {
								htmlRefusalDocumented:
									classification.htmlRefusals?.includes(answer.status) === true,
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
									// Central's actual replies during this request: the only acknowledgement evidence.
									central: {
										acknowledgements: readCentralAcknowledgements(
											fixture.harness.centralProvisioning.exchanges.slice(exchangesBefore),
										),
									},
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
						fuzzSettingsExact(props.cases, props.seedOffset),
					);
				};
				// The first case also reads the plan from the real context; it is the first variant family.
				await runCases({ stepIndex: 0, cases: 1, seedOffset: 0 });
				const planLength = planKeys?.length ?? 1;
				const budget = fuzzCasesOverride ?? planLength;
				if (budget < planLength)
					process.stdout.write(
						JSON.stringify({
							event: 'F1-reduced-run',
							route: routeKey(family.route),
							caller,
							budget,
							variantFamilies: planLength,
						}) + '\n',
					);
				for (let stepIndex = 1; stepIndex < Math.min(budget, planLength); stepIndex += 1)
					await runCases({ stepIndex, cases: 1, seedOffset: stepIndex });
				if (budget > planLength)
					await runCases({
						stepIndex: undefined,
						cases: budget - planLength,
						seedOffset: planLength,
					});
			});
		});
	}
}
