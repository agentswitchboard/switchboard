import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { holdMePasskeyListDuring } from '#sign-in-test-support/test-fixtures/me-passkey-list-hold';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { withNavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { observeNavigationFactors } from '#sign-in-test-support/test-fixtures/sign-in-navigation-setup';

useControlledSignInClock();

const hosts = ['node', 'cloudflare'] as const;
/**
 * N4 reaches the Me page from the ready page three times. Holding the list that the Nth arrival
 * requests must stop N4 there: the second by the request its next step makes, the last by N4
 * returning, because nothing follows it. The first arrival is not witnessed: its next step clicks
 * Add passkey, which Playwright holds until the list has loaded, so a heading-only wait there
 * cannot be told apart from the full wait.
 */
const arrivals = [
	{ readyPageVisits: 2, nextStep: '/api/auth/two-factor/enable' },
	{ readyPageVisits: 3, nextStep: null },
] as const;

it.each(hosts.flatMap((host) => arrivals.map((arrival) => [host, arrival] as const)))(
	'sign-in navigation N4 waits for the held Me page passkey list before going on, on %s after ready-page arrival %j',
	async (host, arrival): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: (browser) =>
					holdMePasskeyListDuring(browser, {
						afterReadyPageVisits: arrival.readyPageVisits,
						journey: async (events): Promise<void> => {
							const nextStepStarted = (request: { url: () => string }): void => {
								if (new URL(request.url()).pathname !== arrival.nextStep) return;
								browser.proof.page.off('request', nextStepStarted);
								events.push('next-step-started');
							};
							if (arrival.nextStep !== null) browser.proof.page.on('request', nextStepStarted);
							await observeNavigationFactors(browser);
							events.push('flow-returned');
						},
						exercise: async (held): Promise<void> => {
							await held.sessionSettled;
							// The page's commands are ordered: once this round trip returns, anything the
							// journey's earlier click started has already been reported.
							await browser.proof.page.evaluate('0');
							expect(held.events).toEqual(['held']);
							held.events.push('released');
							held.release();
							await held.flow;
							expect(held.events).toEqual([
								'held',
								'released',
								...(arrival.nextStep === null ? [] : ['next-step-started']),
								'flow-returned',
							]);
						},
					}),
			}),
		);
	},
);
