import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { withNavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { holdBrowserReply } from '#sign-in-test-support/test-fixtures/sign-in-navigation-layout';
import { awaitMePageRequestsAfter } from '#sign-in-test-support/test-fixtures/sign-in-navigation-setup';

useControlledSignInClock();

const hosts = ['node', 'cloudflare'] as const;
const heldMePath = /\/me\?hold-route-proof=1$/u;
const passkeyListPath = '/api/auth/passkey/list-user-passkeys';

it.each(hosts)(
	'sign-in navigation held reply keeps its route registered after the first match so no interception teardown races the held document on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: async (browser): Promise<void> => {
					const { harness, proof } = browser;
					const hold = await holdBrowserReply(browser, heldMePath);
					try {
						hold.release();
						// Each navigation ends only when its own page's requests have, so nothing the page
						// started is still in the proof server when the harness closes.
						await awaitMePageRequestsAfter(browser, async (): Promise<void> => {
							const first = await proof.page.goto(`${harness.issuer}/me?hold-route-proof=1`);
							expect(first?.status()).toBe(200);
						});
						expect(await hold.status).toBe(200);
						expect(hold.matchedRequests()).toBe(1);
						// A spent route that Playwright removes on its own would not see this request.
						// The route that outlives its first match is what keeps Fetch interception from
						// being disabled while the held document's subresources are still being requested.
						await awaitMePageRequestsAfter(browser, async (): Promise<void> => {
							const second = await proof.page.goto(`${harness.issuer}/me?hold-route-proof=1`);
							expect(second?.status()).toBe(200);
						});
						expect(hold.matchedRequests()).toBe(2);
					} finally {
						await hold.close();
					}
				},
			}),
		);
	},
);

it.each(hosts)(
	'sign-in navigation the second held-route navigation is not over while its passkey list is held in the proof server on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: async (browser): Promise<void> => {
					const { harness, proof } = browser;
					const hold = await holdBrowserReply(browser, heldMePath);
					const events: string[] = [];
					try {
						hold.release();
						await awaitMePageRequestsAfter(browser, async (): Promise<void> => {
							await proof.page.goto(`${harness.issuer}/me?hold-route-proof=1`);
						});
						// The next passkey list the proof server sees is the second navigation's.
						const listHold = harness.httpResponseHolds.armNextGetResponse(
							passkeyListPath,
							browser.signal,
						);
						try {
							const second = awaitMePageRequestsAfter(browser, async (): Promise<void> => {
								await proof.page.goto(`${harness.issuer}/me?hold-route-proof=1`);
							}).then((): void => {
								events.push('second-navigation-over');
							});
							void second.catch(() => undefined);
							const secondFailed = second.then(() => new Promise<never>(() => {}));
							await Promise.race([listHold.entered, secondFailed]);
							events.push('list-held');
							expect(events).toEqual(['list-held']);
							events.push('list-released');
							listHold.release();
							await second;
							expect(events).toEqual(['list-held', 'list-released', 'second-navigation-over']);
						} finally {
							listHold.release();
						}
					} finally {
						await hold.close();
					}
				},
			}),
		);
	},
);
