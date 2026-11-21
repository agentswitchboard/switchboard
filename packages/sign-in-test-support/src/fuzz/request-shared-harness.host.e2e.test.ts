import { afterAll, expect, it } from 'vitest';

import { createRequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import { createSharedRequestHarness } from '#sign-in-test-support/fuzz/request-shared-harness';
import { readRequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();

const shared = createSharedRequestHarness();
afterAll(async () => shared.close());

async function spendSignInQuota(
	fixture: Awaited<ReturnType<typeof createRequestCaseFixture>>,
): Promise<number> {
	fixture.harness.useBrowser('quota-spender');
	let limited = 0;
	for (let attempt = 0; attempt < 40 && limited === 0; attempt += 1) {
		const response = await fixture.harness.auth('/api/auth/sign-in/social', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		});
		if (response.status === 429) limited = attempt + 1;
	}
	return limited;
}

it('S2 shared host: a spent request quota, stored rows and cookies do not reach the next case', async (): Promise<void> => {
	const host = await shared.acquire();
	const first = await createRequestCaseFixture({
		caller: 'owner',
		path: '/api/auth/get-session',
		existingHarness: host,
	});
	// The limiter is live and stateful on this host: the spender's address is eventually limited.
	expect(await spendSignInQuota(first)).toBeGreaterThan(0);
	expect((await readRequestStorageSnapshot(host.database)).user?.length ?? 0).toBeGreaterThan(0);
	await shared.release('passed');

	const second = await createRequestCaseFixture({
		caller: 'member',
		path: '/api/auth/get-session',
		existingHarness: host,
	});
	// Fresh storage: only this case's people exist, none of the first case's rows.
	const users = (await readRequestStorageSnapshot(host.database)).user ?? [];
	expect(
		users.map((row) => String(row.email)).toSorted((left, right) => left.localeCompare(right)),
	).toEqual(['fuzz-member@example.invalid', 'owner@example.invalid']);
	expect(second.context.personId).not.toBe(first.context.personId);
	// A fresh case has a fresh address, so it is not limited by the previous case's spent quota.
	second.harness.useBrowser('after-spend');
	const answer = await second.harness.auth('/api/auth/sign-in/social', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
	});
	expect(answer.status).not.toBe(429);
	await shared.release('passed');
});

it('S2 shared host: a failed group discards the host and the next group starts a fresh one', async (): Promise<void> => {
	const before = await shared.acquire();
	await shared.release('failed');
	const after = await shared.acquire();
	expect(after).not.toBe(before);
	await shared.release('passed');
});
