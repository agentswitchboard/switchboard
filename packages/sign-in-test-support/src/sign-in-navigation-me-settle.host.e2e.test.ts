import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import { withNavigationBrowser } from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { awaitMePageSettled } from '#sign-in-test-support/test-fixtures/sign-in-navigation-setup';

useControlledSignInClock();

it.each(['node', 'cloudflare'] as const)(
	'sign-in navigation Me settle waits for the page-issued passkey list while the server still holds its response on %s',
	async (host): Promise<void> => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({
				host,
				signal,
				exercise: async (browser): Promise<void> => {
					const { harness, proof } = browser;
					const hold = harness.httpResponseHolds.armNextGetResponse(
						'/api/auth/passkey/list-user-passkeys',
					);
					await proof.page.goto(`${harness.issuer}/me`, { waitUntil: 'commit' });
					const settled = awaitMePageSettled(browser).then(() => 'settled' as const);
					// The island's own list request is now mid-response inside the proof server.
					await hold.entered;
					const headingThenRoundTrip = proof.page
						.getByRole('heading', { name: 'Me', exact: true })
						.waitFor()
						.then(() => proof.page.evaluate('0'))
						.then(() => 'heading-seen' as const);
					// Both waits watch the same server-rendered heading; the settle wait asked first, so
					// it only loses this race if it still owes the held request.
					expect(await Promise.race([settled, headingThenRoundTrip])).toBe('heading-seen');
					hold.release();
					expect(await settled).toBe('settled');
				},
			}),
		);
	},
);
