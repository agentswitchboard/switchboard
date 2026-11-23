import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { withNavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { observeCancelledHoldProof } from '#sign-in-test-support/test-fixtures/sign-in-navigation-layout';

useControlledSignInClock();

const hosts = ['node', 'cloudflare'] as const;

it.each(hosts)(
	'sign-in navigation N8 ends its cancelled-hold navigation only after the Me page session request is over on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: async (browser): Promise<void> => {
					const { harness, proof } = browser;
					const events: string[] = [];
					// The next session request the proof server sees is the Me island's, issued after the
					// document's DOMContentLoaded; holding its response keeps that request open.
					const sessionHold = harness.httpResponseHolds.armNextGetResponse(
						'/api/auth/get-session',
						browser.signal,
					);
					try {
						const tail = observeCancelledHoldProof(browser).then((): void => {
							events.push('tail-returned');
						});
						void tail.catch(() => undefined);
						await Promise.race([
							sessionHold.entered,
							tail.then(() => new Promise<never>(() => {})),
						]);
						// The session request is open at the server. Make sure the document has also reached
						// DOMContentLoaded, the event the old ending returned on, and let every waiter on that
						// one event run, so a tail that ignores the open request has already returned.
						await proof.page.waitForLoadState('domcontentloaded');
						await new Promise<void>((resolve) => setImmediate(resolve));
						expect(events).toEqual([]);
						events.push('released');
						sessionHold.release();
						await tail;
						expect(events).toEqual(['released', 'tail-returned']);
					} finally {
						sessionHold.release();
					}
				},
			}),
		);
	},
);
