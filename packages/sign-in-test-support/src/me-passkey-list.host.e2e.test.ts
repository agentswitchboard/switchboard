import { signInRequestPolicies } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { registerBrowserPasskey } from '#sign-in-test-support/test-fixtures/passkey-browser-ceremonies';
import { runProofBrowserScenario } from '#sign-in-test-support/test-fixtures/playwright-browser';
import {
	runNavigationSteps,
	visitNavigation,
	withNavigationBrowser,
	type NavigationBrowser,
} from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';
import { createSoftwarePasskeyAuthenticator } from '#sign-in-test-support/test-fixtures/software-passkey-authenticator';

useControlledSignInClock();

const passkeyListPath = '/api/auth/passkey/list-user-passkeys';

async function setHostClock(
	harness: NavigationBrowser['harness'],
	milliseconds: number,
): Promise<void> {
	const response = await harness.auth('/__auth-proof/set-clock', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ milliseconds }),
	});
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ controlledMilliseconds: milliseconds });
}

async function observeListRecovery(browser: NavigationBrowser): Promise<void> {
	const { harness, proof } = browser;
	const registration = await registerBrowserPasskey({
		harness,
		authenticator: await createSoftwarePasskeyAuthenticator(),
	});
	expect(registration.status).toBe(200);
	await harness.useControlledPasskeyWindow();
	const policy = signInRequestPolicies['callback-passkey'].outer;
	const windowMilliseconds = policy.windowSeconds * 1000;
	const windowStart = controlledSignInClock.now() + windowMilliseconds;
	await setHostClock(harness, windowStart);
	await runNavigationSteps(
		Array.from({ length: policy.max }, (_, index) => index + 1),
		async (readNumber): Promise<void> => {
			const response = await harness.auth(passkeyListPath);
			expect(response.status, `list read ${readNumber} inside the window`).toBe(200);
		},
	);

	const limited = await proof.responseTo(passkeyListPath, () => visitNavigation(browser, '/me'));
	expect(limited.response.status).toBe(429);
	const passkeyList = proof.page.getByRole('region', { name: 'Passkey list' });
	const alert = passkeyList.getByRole('alert');
	const errorOrAutomaticRequest = await Promise.race([
		alert.waitFor().then(() => 'error displayed'),
		proof.page
			.waitForRequest((request) => new URL(request.url()).pathname === passkeyListPath)
			.then(() => 'list requested again before Retry'),
	]);
	expect(errorOrAutomaticRequest).toBe('error displayed');
	expect(await passkeyList.locator('[data-slot="skeleton"]').count()).toBe(0);
	expect(await alert.textContent()).toContain('Passkeys are unavailable.');
	const retry = alert.getByRole('button', { name: 'Retry', exact: true });

	await setHostClock(harness, windowStart + windowMilliseconds);
	const recovered = await proof.responseTo(passkeyListPath, () => retry.click());
	expect(recovered.response.status).toBe(200);
	const passkey = passkeyList
		.getByRole('listitem')
		.getByText('Controlled test passkey', { exact: true });
	await passkey.waitFor();
	expect(await alert.count()).toBe(0);
}

it.each(['node', 'cloudflare'] as const)(
	'Me retries a rate-limited passkey list on %s',
	async (host) => {
		await runProofBrowserScenario((signal) =>
			withNavigationBrowser({ host, signal, exercise: observeListRecovery }),
		);
	},
);

async function observeUnavailableList(browser: NavigationBrowser): Promise<void> {
	const { proof } = browser;
	const passkeyList = proof.page.getByRole('region', { name: 'Passkey list' });
	const alert = passkeyList.getByRole('alert');
	const retry = alert.getByRole('button', { name: 'Retry', exact: true });
	await runNavigationSteps(['http-503', 'connection-failed'] as const, async (failure) => {
		let refused = false;
		await proof.page.route(
			(url) => url.pathname === passkeyListPath,
			async (route): Promise<void> => {
				refused = true;
				if (failure === 'http-503') {
					await route.fulfill({ status: 503, json: { message: 'Service unavailable' } });
				} else {
					await route.abort('connectionfailed');
				}
			},
			{ times: 1 },
		);
		await visitNavigation(browser, '/me');
		await alert.waitFor();
		expect(refused, failure).toBe(true);
		expect(await passkeyList.locator('[data-slot="skeleton"]').count(), failure).toBe(0);
		expect(await alert.textContent(), failure).toContain('Passkeys are unavailable.');
		const recovered = await proof.responseTo(passkeyListPath, () => retry.click());
		expect(recovered.response.status, failure).toBe(200);
		await passkeyList.getByText('No passkeys yet.', { exact: true }).waitFor();
		expect(await alert.count(), failure).toBe(0);
	});
}

it.each(['node', 'cloudflare'] as const)('Me retries a failed passkey list on %s', async (host) => {
	await runProofBrowserScenario((signal) =>
		withNavigationBrowser({ host, signal, exercise: observeUnavailableList }),
	);
});
