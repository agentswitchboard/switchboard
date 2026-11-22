import { afterAll, expect, it } from 'vitest';

import { parseFailureReplay } from '#sign-in-test-support/fuzz/fuzz-settings';
import { runRequestGroup } from '#sign-in-test-support/fuzz/request-campaign';
import type { ObservedRequestAnswer } from '#sign-in-test-support/fuzz/request-disclosure';
import {
	requestFamilies,
	type GeneratedRequest,
} from '#sign-in-test-support/fuzz/request-families/index';
import { createCallerHarnessLanes } from '#sign-in-test-support/fuzz/request-shared-harness';
import { routeClassification, routeKey } from '#sign-in-test-support/fuzz/route-classification';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();

const lanes = createCallerHarnessLanes(['signed-out'] as const, { concurrent: false });
afterAll(async () => lanes.close());

const namedProperty = 'S2 no-server-error: generated input without injected storage faults';

/**
 * A planted failure, in this test-support stub and not in product code: the host answers every
 * request, and for the callback URL boundary request (whose length the generator draws, so the print carries
 * draws and the request depends on them) the stub reports a server error, which the campaign's no-server-error property
 * refuses. Deterministic, so the printed evidence of the failed run must fail the same way.
 */
const plantedMinimumLength = 5;

function plantServerError(bodies: string[]) {
	return (answer: ObservedRequestAnswer, request: GeneratedRequest): ObservedRequestAnswer => {
		if (request.variant.field !== 'callbackURL' || request.variant.mutation !== 'boundary')
			return answer;
		// The issuer port differs between hosts; the drawn content is what a replay must reproduce.
		const body = (typeof request.init.body === 'string' ? request.init.body : '').replaceAll(
			/127\.0\.0\.1:\d+/gu,
			'host',
		);
		// Fails only for a long enough value: only a replay of the printed draw sends that many characters.
		if ((/x+/u.exec(body)?.[0].length ?? 0) <= plantedMinimumLength) return answer;
		bodies.push(body);
		return { ...answer, status: 500 };
	};
}

const family = requestFamilies.find(
	(candidate) =>
		candidate.route.path === '/api/auth/sign-in/social' && candidate.callers.includes('signed-out'),
);
const classification = routeClassification.find(
	(row) => family !== undefined && routeKey(row) === routeKey(family.route),
);

it('replays a failed host case from its printed evidence and fails the same named property', async () => {
	if (family === undefined || classification === undefined)
		throw new Error('the social sign-in family is missing');
	const group = {
		family,
		caller: 'signed-out',
		classification,
	} as const;
	const failedBodies: string[] = [];
	const replayedBodies: string[] = [];
	// 1. The failing run: the campaign group with the planted failure. Its error message is the print.
	const printed = await lanes
		.run('signed-out', async (harness) =>
			runRequestGroup({ ...group, harness, observeAnswer: plantServerError(failedBodies) }),
		)
		.then(
			() => {
				throw new Error('the planted failure did not fail the campaign group');
			},
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	expect(printed).toContain(namedProperty);
	// The print carries the whole identity: seed, offset, route, caller, variant and the draws.
	const replay = parseFailureReplay(printed);
	expect(replay.seed).toBeTypeOf('number');
	// The coverage pass runs variant family n at seed offset n: the first boundary variant is not the first.
	expect(replay.offset).toBeGreaterThan(0);
	expect(replay.route).toBe(routeKey(family.route));
	expect(replay.caller).toBe('signed-out');
	expect(replay.variant.endsWith('|callbackURL|boundary')).toBe(true);
	expect(replay.evidence.complete).toBe(true);
	// One draw, the drawn length: the latest executed failure (the shrink is bounded, so not the minimum).
	expect(replay.evidence.draws).toHaveLength(1);
	expect(replay.evidence.draws[0]).toBeGreaterThan(plantedMinimumLength);
	// 2. The replay, from that print alone, with the same stub: the same named property fails.
	const replayed = await lanes
		.run('signed-out', async (harness) =>
			runRequestGroup({
				...group,
				harness,
				observeAnswer: plantServerError(replayedBodies),
				replay,
			}),
		)
		.then(
			() => {
				throw new Error('the replay of the printed failure did not fail');
			},
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
	expect(replayed).toContain(namedProperty);
	// The replay sent exactly the request of the latest executed failure: the printed draws, not new ones.
	expect(replayedBodies).toEqual([failedBodies.at(-1)]);
	expect(failedBodies.at(-1)).toBeDefined();
	// 3. Without the planted failure the same printed case passes: the failure was the plant's, and the
	// replay really ran the printed case against the real host.
	await lanes.run('signed-out', async (harness) => runRequestGroup({ ...group, harness, replay }));
}, 600_000);
