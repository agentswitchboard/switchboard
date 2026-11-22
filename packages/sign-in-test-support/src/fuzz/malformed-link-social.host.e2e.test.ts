import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

it('S2 no-server-error: a minimal malformed link-social body is a client refusal', async () => {
	// Arrange: no storage fault or external-provider call is involved.
	const harness = await startLocalAuthHarness();
	try {
		// Act: pass the malformed bytes through the real host entry.
		const response = await harness.auth('/api/auth/link-social', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		});
		const body = await response.text();
		// Assert: keep the original response in the failure without printing credentials.
		expect(response.status, `S2 no-server-error; body=${body}`).toBeLessThan(500);
		expect(response.status).toBeGreaterThanOrEqual(400);
	} finally {
		await harness.close();
	}
});
