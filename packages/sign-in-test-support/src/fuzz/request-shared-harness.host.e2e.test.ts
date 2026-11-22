import { afterAll, expect, it } from 'vitest';

import {
	createRequestCaseFixture,
	type RequestHarness,
} from '#sign-in-test-support/fuzz/request-case-fixture';
import {
	createCallerHarnessLanes,
	createSharedRequestHarness,
} from '#sign-in-test-support/fuzz/request-shared-harness';
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

type Lane = 'owner' | 'member';

/** Both lanes are inside their work at once before either proceeds: the overlap is coordinated, not hoped for. */
function createBarrier(parties: number): () => Promise<void> {
	const arrived = Promise.withResolvers<void>();
	let count = 0;
	return async (): Promise<void> => {
		count += 1;
		if (count === parties) arrived.resolve();
		await arrived.promise;
	};
}

it('S2 caller lanes: overlapping lanes keep their own database, sessions and request quota', async (): Promise<void> => {
	const lanes = createCallerHarnessLanes(['owner', 'member'] as const, { concurrent: true });
	const bothInside = createBarrier(2);
	const ownerSpentQuota = Promise.withResolvers<number>();
	try {
		const observe = async (
			lane: Lane,
			host: RequestHarness,
		): Promise<{
			readonly host: RequestHarness;
			readonly people: readonly string[];
			readonly sessions: readonly string[];
			readonly limited: number;
			readonly firstAnswer: number;
		}> => {
			const fixture = await createRequestCaseFixture({
				caller: lane,
				path: '/api/auth/get-session',
				existingHarness: host,
			});
			await bothInside();
			const snapshot = await readRequestStorageSnapshot(host.database);
			const people = (snapshot.user ?? []).map((row) => String(row.id));
			const sessions = (snapshot.session ?? []).map((row) => String(row.id));
			let limited = 0;
			let firstAnswer = 0;
			if (lane === 'owner') {
				// The owner lane spends its sign-in quota on a browser name the member lane also uses.
				limited = await spendSignInQuota(fixture);
				ownerSpentQuota.resolve(limited);
			} else {
				await ownerSpentQuota.promise;
				fixture.harness.useBrowser('quota-spender');
				firstAnswer = (
					await fixture.harness.auth('/api/auth/sign-in/social', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: '{}',
					})
				).status;
			}
			return { host, people, sessions, limited, firstAnswer };
		};
		const [owner, member] = await Promise.all([
			lanes.run('owner', async (host) => observe('owner', host)),
			lanes.run('member', async (host) => observe('member', host)),
		]);
		// Two hosts and two databases: no person or session of one lane is in the other.
		expect(owner.host).not.toBe(member.host);
		expect(Object.is(owner.host.database, member.host.database)).toBe(false);
		expect(owner.people.length).toBeGreaterThan(0);
		expect(member.people.length).toBeGreaterThan(0);
		expect(owner.people.filter((id) => member.people.includes(id))).toEqual([]);
		expect(owner.sessions.filter((id) => member.sessions.includes(id))).toEqual([]);
		// The owner lane spent a quota to a 429; the member lane's same browser name is not limited.
		expect(owner.limited).toBeGreaterThan(0);
		expect(member.firstAnswer).not.toBe(429);
	} finally {
		await lanes.close();
	}
});

it('S2 caller lanes: a failed lane is replaced while the other lane keeps its host', async (): Promise<void> => {
	const lanes = createCallerHarnessLanes(['owner', 'member'] as const, { concurrent: true });
	try {
		const hostOf = async (lane: Lane): Promise<RequestHarness> =>
			lanes.run(lane, async (host) => host);
		const [firstOwner, firstMember] = await Promise.all([hostOf('owner'), hostOf('member')]);
		// The owner lane's work throws; the member lane's succeeds at the same time.
		const [failed, kept] = await Promise.allSettled([
			lanes.run('owner', async () => {
				throw new Error('owner lane work failed');
			}),
			lanes.run('member', async (host) => host),
		]);
		expect(failed.status).toBe('rejected');
		expect(kept.status === 'fulfilled' ? kept.value : undefined).toBe(firstMember);
		// Next turn: the failed lane starts a fresh host; the other still has the same one, usable.
		const [secondOwner, secondMember] = await Promise.all([hostOf('owner'), hostOf('member')]);
		expect(secondOwner).not.toBe(firstOwner);
		expect(secondMember).toBe(firstMember);
		const fixture = await createRequestCaseFixture({
			caller: 'member',
			path: '/api/auth/get-session',
			existingHarness: secondMember,
		});
		expect(fixture.sessionId).not.toBeNull();
	} finally {
		await lanes.close();
	}
});
