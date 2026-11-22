import { expect, it, vi } from 'vitest';

import { createAuthProofHttpResponseHolds } from '#sign-in-test-support/test-fixtures/auth-proof-http-response-holds';
import {
	holdMePasskeyListDuring,
	type HoldablePage,
	type MePasskeyListHoldBrowser,
} from '#sign-in-test-support/test-fixtures/me-passkey-list-hold';

function browserWith(props: {
	readonly signal: AbortSignal;
	readonly page?: Partial<HoldablePage>;
}): MePasskeyListHoldBrowser & {
	readonly holds: ReturnType<typeof createAuthProofHttpResponseHolds>;
} {
	const holds = createAuthProofHttpResponseHolds();
	const page: HoldablePage = {
		route: async () => undefined,
		unroute: async () => undefined,
		on: () => undefined,
		off: () => undefined,
		waitForResponse: () => new Promise(() => {}),
		isClosed: () => false,
		...props.page,
	};
	return { signal: props.signal, harness: { httpResponseHolds: holds }, proof: { page }, holds };
}

const neverReached = (): Promise<void> => Promise.reject(new Error('journey must not run'));

it('rejects with the abort reason before arming, routing or running anything when the signal has already aborted', async () => {
	const reason = new Error('scenario already over');
	const browser = browserWith({ signal: AbortSignal.abort(reason) });
	const route = vi.spyOn(browser.proof.page, 'route');
	const journey = vi.fn(neverReached);
	await expect(
		holdMePasskeyListDuring(browser, {
			afterReadyPageVisits: 0,
			journey,
			exercise: neverReached,
		}),
	).rejects.toBe(reason);
	expect(route).not.toHaveBeenCalled();
	expect(journey).not.toHaveBeenCalled();
	expect(() =>
		browser.holds.armNextGetResponse('/api/auth/passkey/list-user-passkeys'),
	).not.toThrow();
});

it('disarms the hold when the browser route cannot be installed', async () => {
	const routeFailure = new Error('route refused');
	const browser = browserWith({
		signal: new AbortController().signal,
		page: { route: () => Promise.reject(routeFailure) },
	});
	await expect(
		holdMePasskeyListDuring(browser, {
			afterReadyPageVisits: 0,
			journey: neverReached,
			exercise: neverReached,
		}),
	).rejects.toBe(routeFailure);
	expect(() =>
		browser.holds.armNextGetResponse('/api/auth/passkey/list-user-passkeys'),
	).not.toThrow();
});

it('aborts the hold and keeps the journey failure when the route cannot be removed', async () => {
	const journeyFailure = new Error('journey failed');
	const unrouteFailure = new Error('unroute refused');
	const browser = browserWith({
		signal: new AbortController().signal,
		page: { unroute: () => Promise.reject(unrouteFailure) },
	});
	const outcome = await holdMePasskeyListDuring(browser, {
		afterReadyPageVisits: 0,
		journey: () => Promise.reject(journeyFailure),
		exercise: neverReached,
	}).then(
		() => null,
		(error: unknown) => error,
	);
	expect(outcome).toBeInstanceOf(AggregateError);
	expect(outcome).toMatchObject({ errors: [journeyFailure, unrouteFailure] });
	expect(() =>
		browser.holds.armNextGetResponse('/api/auth/passkey/list-user-passkeys'),
	).not.toThrow();
});
