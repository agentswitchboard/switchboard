import { expect, it } from 'vitest';

import { AuthProofCloseError } from '#sign-in-test-support/test-fixtures/auth-proof-forwarder-lifecycle';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { holdMePasskeyListDuring } from '#sign-in-test-support/test-fixtures/me-passkey-list-hold';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { withNavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import {
	followReadyLinkToMe,
	observeNavigationReadiness,
} from '#sign-in-test-support/test-fixtures/sign-in-navigation-setup';

useControlledSignInClock();

const hosts = ['node', 'cloudflare'] as const;

it.each(hosts)(
	'sign-in navigation N7 does not return while the Me page passkey list is held, and returns once it is released on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: (browser) =>
					holdMePasskeyListDuring(browser, {
						afterReadyPageVisits: 0,
						journey: async (events): Promise<void> => {
							await observeNavigationReadiness(browser);
							events.push('flow-returned');
						},
						exercise: async (held): Promise<void> => {
							await held.sessionSettled;
							// Only the held list is open: a wait that ignores it has already returned by now.
							expect(held.events).toEqual(['held']);
							held.events.push('released');
							held.release();
							await held.flow;
							expect(held.events).toEqual(['held', 'released', 'flow-returned']);
						},
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
						holdMePasskeyListDuring(browser, {
							afterReadyPageVisits: 0,
							journey: (): Promise<void> => observeNavigationReadiness(browser),
							exercise: async (held): Promise<void> => {
								await held.sessionSettled;
								const closed = await browser.closeHarness().then(
									() => null,
									(error: unknown) => error,
								);
								expect(closed).toBeInstanceOf(AuthProofCloseError);
								expect(closed).toMatchObject({ state: { kind: 'pendingAtClose' } });
							},
						}),
				}),
			),
		).rejects.toMatchObject({ state: { kind: 'pendingAtClose' } });
	},
);

it.each(hosts)(
	'sign-in navigation Me wait ends as failed, and does not hang, when the held passkey list fails after its headers on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: (browser) =>
					holdMePasskeyListDuring(browser, {
						afterReadyPageVisits: 1,
						journey: async (events): Promise<void> => {
							await browser.proof.navigate(`${browser.harness.issuer}/owner-ready`);
							const outcomes = await followReadyLinkToMe(browser);
							events.push(`flow-returned:${outcomes.get('/api/auth/passkey/list-user-passkeys')}`);
						},
						exercise: async (held): Promise<void> => {
							await held.sessionSettled;
							expect(held.events).toEqual(['held']);
							held.events.push('failed');
							held.fail();
							await held.flow;
							expect(held.events).toEqual(['held', 'failed', 'flow-returned:failed']);
						},
					}),
			}),
		);
	},
);
