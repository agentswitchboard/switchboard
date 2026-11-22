import { expect, it } from 'vitest';

import { AuthProofCloseError } from '#sign-in-test-support/test-fixtures/auth-proof-forwarder-lifecycle';
import { authProofHoldTokenHeader } from '#sign-in-test-support/test-fixtures/auth-proof-http-response-holds';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import {
	withNavigationBrowser,
	type NavigationBrowser,
} from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { observeNavigationReadiness } from '#sign-in-test-support/test-fixtures/sign-in-navigation-setup';

useControlledSignInClock();

const hosts = ['node', 'cloudflare'] as const;
const passkeyListPath = '/api/auth/passkey/list-user-passkeys';

const meHoldToken = 'me-passkey-list';

/**
 * Runs N7's real path and holds, inside the proof server, the passkey-list response requested by
 * the Me page. The ready page requests the same list, and the pages set no-referrer, so the
 * browser marks only requests issued from the Me document with a hold token and the server holds
 * only a marked response. Returns once the hold is entered. Every path out of the exercise aborts
 * the hold signal, which rejects a hold nothing reached and releases one that is holding.
 */
async function holdMePasskeyListDuringReadiness(
	browser: NavigationBrowser,
	exercise: (held: {
		readonly events: string[];
		readonly readiness: Promise<void>;
		/** The Me page's session request is over, so only the held list is still open. */
		readonly sessionSettled: Promise<void>;
		readonly release: () => void;
	}) => Promise<void>,
): Promise<void> {
	const cleanup = new AbortController();
	const scenarioEnded = (): void => cleanup.abort(browser.signal.reason);
	browser.signal.addEventListener('abort', scenarioEnded, { once: true });
	const events: string[] = [];
	const hold = browser.harness.httpResponseHolds.armNextGetResponse(
		passkeyListPath,
		cleanup.signal,
		meHoldToken,
	);
	const passkeyListRequests = (url: URL): boolean => url.pathname === passkeyListPath;
	await browser.proof.page.route(passkeyListRequests, async (route): Promise<void> => {
		const fromMe = new URL(route.request().frame().url()).pathname === '/me';
		await route.continue(
			fromMe
				? { headers: { ...route.request().headers(), [authProofHoldTokenHeader]: meHoldToken } }
				: {},
		);
	});
	const sessionSettled = browser.proof.page
		.waitForResponse(
			(candidate) =>
				candidate.request().method() === 'GET' &&
				new URL(candidate.url()).pathname === '/api/auth/get-session' &&
				new URL(candidate.request().frame().url()).pathname === '/me',
			{ timeout: 0 },
		)
		.then(async (response): Promise<void> => {
			await response.finished();
			// One macrotask lets every waiter on that same response run before the caller looks.
			await new Promise<void>((resolve) => setImmediate(resolve));
		});
	void sessionSettled.catch(() => undefined);
	try {
		const readiness = observeNavigationReadiness(browser).then((): void => {
			events.push('readiness-returned');
		});
		void readiness.catch(() => undefined);
		// Readiness failing settles the wait; returning early must not, so that is recorded in events.
		const readinessFailed = readiness.then(() => new Promise<never>(() => {}));
		await Promise.race([hold.entered, readinessFailed]);
		events.push('held');
		await exercise({ events, readiness, sessionSettled, release: hold.release });
	} finally {
		if (!browser.proof.page.isClosed()) await browser.proof.page.unroute(passkeyListRequests);
		browser.signal.removeEventListener('abort', scenarioEnded);
		cleanup.abort(new Error('Me passkey-list witness ended'));
	}
}

it.each(hosts)(
	'sign-in navigation N7 does not return while the Me page passkey list is held, and returns once it is released on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: (browser) =>
					holdMePasskeyListDuringReadiness(browser, async (held): Promise<void> => {
						await held.sessionSettled;
						// Only the held list is open: a wait that ignores it has already returned by now.
						expect(held.events).toEqual(['held']);
						held.events.push('released');
						held.release();
						await held.readiness;
						expect(held.events).toEqual(['held', 'released', 'readiness-returned']);
					}),
			}),
		);
	},
);

it.each(hosts)(
	'sign-in navigation closing the harness while the Me page passkey list is held reports pendingAtClose on %s',
	async (host): Promise<void> => {
		await expect(
			runProofBrowserScenario((signal) =>
				withNavigationBrowser({
					host,
					signal,
					exercise: (browser) =>
						holdMePasskeyListDuringReadiness(browser, async (held): Promise<void> => {
							await held.sessionSettled;
							const closed = await browser.closeHarness().then(
								() => null,
								(error: unknown) => error,
							);
							expect(closed).toBeInstanceOf(AuthProofCloseError);
							expect(closed).toMatchObject({ state: { kind: 'pendingAtClose' } });
						}),
				}),
			),
		).rejects.toMatchObject({ state: { kind: 'pendingAtClose' } });
	},
);
