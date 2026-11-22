import { uuid7Schema } from '@agent-collaboration/sign-in-core';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
const ownerEmail = 'owner@example.invalid';
const ownerReady = '/owner-ready?device=ABCDEFGH';

it('returns a fresh owner to the checked device continuation after native factor and organization setup', async (): Promise<void> => {
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		machineLogin: {
			routerClientId: uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000a1'),
			machineAudience: 'https://central.example.invalid/machine',
		},
	});
	const enrollmentAction = '/api/auth/two-factor/enable?device=ABCDEFGH';
	const confirmAction = '/api/auth/two-factor/verify-totp?device=ABCDEFGH';
	const submit = (pathname: string, body: Readonly<Record<string, string>>): Promise<Response> =>
		harness.auth(pathname, {
			method: 'POST',
			headers: { accept: 'text/html', 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	try {
		harness.centralProvisioning.replyWith('provisioned');
		await signInPeopleBrowser({ harness, email: ownerEmail });
		const setup = await harness.auth(ownerReady);
		expect(setup.status).toBe(200);
		expect(await setup.text()).toContain(`action="${enrollmentAction}"`);
		const enrollment = await submit(enrollmentAction, { method: 'totp' });
		expect(enrollment.status).toBe(200);
		const html = await enrollment.text();
		expect(html).toContain(`action="${confirmAction}"`);
		const dom = createIsolatedPageDom(html, new URL(enrollmentAction, harness.issuer).href);
		try {
			harness.totpAuthenticator.observeEnrollment(ownerEmail, {
				method: 'totp',
				totpURI: dom.window.document.querySelector('#totp-uri')?.textContent ?? null,
				backupCodes: [...dom.window.document.querySelectorAll('ul code')].map(
					(entry) => entry.textContent,
				),
			});
		} finally {
			dom.window.close();
		}
		const confirmation = await submit(confirmAction, {
			code: await harness.totpAuthenticator.currentCode(ownerEmail),
		});
		expect(confirmation.status).toBe(303);
		expect(confirmation.headers.get('location')).toBe(ownerReady);

		const organizationId = await ensureLocalOwnerOrganization(harness);
		expect((await peoplePost(harness, 'set-active', { organizationId })).status).toBe(200);
		const continued = await harness.auth(ownerReady);
		expect(continued.status).toBe(303);
		expect(continued.headers.get('location')).toBe('/device?user_code=ABCDEFGH');
		expect((await harness.auth('/device?user_code=ABCDEFGH')).status).toBe(200);
	} finally {
		await harness.close();
	}
});
