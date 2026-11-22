import { afterAll, it } from 'vitest';

import { failureReplayFromEnvironment } from '#sign-in-test-support/fuzz/fuzz-settings';
import { runRequestGroup } from '#sign-in-test-support/fuzz/request-campaign';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { createCallerHarnessLanes } from '#sign-in-test-support/fuzz/request-shared-harness';
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

/**
 * One group (a route as a caller): the coverage pass visits every variant family of the route once,
 * each as its own Hegel run whose variant is fixed by the step it is closed over (so a replay or a
 * shrink candidate is always the same variant family, a function of the draw alone), then any extra
 * cases (a deep `SIGN_IN_FUZZ_CASES`) draw their variant family from the same list. The plan comes
 * from the real fixture context of the group's first case, and every later case must see the same
 * field inventory.
 */ for (const family of requestFamilies) {
	for (const caller of family.callers) {
		it.concurrent(`S2 ${routeKey(family.route)} as ${caller}: documented-answer, credential-disclosure, identity-disclosure, refusal-effects`, async () => {
			// With printed evidence (SIGN_IN_FUZZ_REPLAY), only the group it names runs.
			if (
				failureReplayFromEnvironment !== undefined &&
				(failureReplayFromEnvironment.route !== routeKey(family.route) ||
					failureReplayFromEnvironment.caller !== caller)
			)
				return;
			const classification = routeClassification.find(
				(row) => routeKey(row) === routeKey(family.route),
			);
			if (classification === undefined)
				throw new Error('S1 classification missing for request family');
			await lanes.run(caller, async (harness) =>
				runRequestGroup({
					harness,
					family,
					caller,
					classification,
					replay: failureReplayFromEnvironment,
				}),
			);
		});
	}
}
