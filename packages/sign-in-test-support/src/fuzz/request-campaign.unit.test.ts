import { describe, expect, it } from 'vitest';

import { parseFailureReplay } from '#sign-in-test-support/fuzz/fuzz-settings';
import { assertReplayIsRegistered } from '#sign-in-test-support/fuzz/request-campaign';
import { requestFamilies } from '#sign-in-test-support/fuzz/request-families/index';
import { routeKey } from '#sign-in-test-support/fuzz/route-classification';

const printed = (route: string, caller: string, mode = 'scheduled'): string =>
	`S2 documented-answer: failed\ndraws: []\nS5 seed=20261117+3; route=${route}; caller=${caller}; mode=${mode}; variant=json|-|valid`;

describe('a replay names a route and caller the campaign inventory runs', (): void => {
	const family = requestFamilies[0];
	if (family === undefined) throw new Error('no request families');
	const caller = family.callers[0];
	if (caller === undefined) throw new Error('no caller');

	it('accepts a print for a registered route and caller', (): void => {
		const replay = parseFailureReplay(printed(routeKey(family.route), caller));
		expect(() => {
			assertReplayIsRegistered(replay, requestFamilies);
		}).not.toThrow();
	});

	it('fails loudly for a print whose route is not in the inventory (it would otherwise run nothing)', (): void => {
		const replay = parseFailureReplay(
			printed('POST /api/auth/removed-in-an-older-inventory', caller),
		);
		expect(() => {
			assertReplayIsRegistered(replay, requestFamilies);
		}).toThrow(/does not run: nothing would be replayed/u);
	});

	it('fails loudly for a registered route printed with a caller the route is not run as', (): void => {
		const replay = parseFailureReplay(printed(routeKey(family.route), 'nobody'));
		expect(() => {
			assertReplayIsRegistered(replay, requestFamilies);
		}).toThrow(/does not run/u);
	});

	it('carries the generation mode in the print and refuses a print without it', (): void => {
		expect(parseFailureReplay(printed(routeKey(family.route), caller, 'random')).mode).toBe(
			'random',
		);
		expect(() =>
			parseFailureReplay(
				'failed\ndraws: []\nS5 seed=20261117+3; route=POST /x; caller=owner; variant=json|-|valid',
			),
		).toThrow(/no case identity note/u);
	});
});
