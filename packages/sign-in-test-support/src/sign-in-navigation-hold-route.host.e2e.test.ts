import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { withNavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { holdBrowserReply } from '#sign-in-test-support/test-fixtures/sign-in-navigation-layout';

useControlledSignInClock();

it.each(['node', 'cloudflare'] as const)(
	'sign-in navigation held reply keeps its route registered after the first match so no interception teardown races the held document on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: async (browser): Promise<void> => {
					const { harness, proof } = browser;
					const hold = await holdBrowserReply(browser, /\/me\?hold-route-proof=1$/u);
					try {
						hold.release();
						const first = await proof.page.goto(`${harness.issuer}/me?hold-route-proof=1`);
						expect(first?.status()).toBe(200);
						expect(await hold.status).toBe(200);
						expect(hold.matchedRequests()).toBe(1);
						// A spent route that Playwright removes on its own would not see this request.
						// The route that outlives its first match is what keeps Fetch interception from
						// being disabled while the held document's subresources are still being requested.
						const second = await proof.page.goto(`${harness.issuer}/me?hold-route-proof=1`);
						expect(second?.status()).toBe(200);
						expect(hold.matchedRequests()).toBe(2);
					} finally {
						await hold.close();
					}
				},
			}),
		);
	},
);
