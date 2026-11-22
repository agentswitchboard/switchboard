import {
	resetRequestHarness,
	type RequestHarness,
} from '#sign-in-test-support/fuzz/request-case-fixture';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

/**
 * One host serves every route/caller group of a file, so the per-group host start (about 3.4 s
 * on both hosts) is paid once. Isolation stays per case: each case resets storage, asserts an
 * empty baseline and cookie jar, and uses its own browser address (`createRequestCaseFixture`).
 *
 * Reset between groups (what the shared host carries over, and why each item is safe):
 * - storage: every table is emptied and the baseline re-read (`resetRequestHarness`);
 * - browser cookie jar: cleared with the same call;
 * - deferred work: settled before the reset so no write lands in the next group;
 * - request limiters: keyed by `class:address`, and each case's browser has a fresh address, so
 *   a spent quota cannot reach the next case (proved in request-shared-harness.host.e2e.test.ts);
 * - id source, clock: monotonic / fixed for the file; this file never moves the clock (the
 *   clock-moving permitted-refusals test keeps its own host);
 * - TOTP/passkey/OAuth state: stored rows (wiped) or created per case (fresh authenticators).
 * A group that throws, or a failed reset or health probe, closes this host; the next group
 * starts a fresh one.
 */
export interface SharedRequestHarness {
	readonly acquire: () => Promise<RequestHarness>;
	/** Call after each group: resets storage, or discards the host when the group failed. */
	readonly release: (outcome: 'passed' | 'failed') => Promise<void>;
	readonly close: () => Promise<void>;
}

export function createSharedRequestHarness(): SharedRequestHarness {
	let current: RequestHarness | undefined;
	async function discard(): Promise<void> {
		const harness = current;
		current = undefined;
		await harness?.close();
	}
	return {
		async acquire(): Promise<RequestHarness> {
			if (current === undefined) {
				current = await startLocalAuthHarness();
				// A central that confirms organization setup, as the permanent provisioning tests use
				// (controlled-central-provisioning.ts), so no answer is 503 "setting up".
				current.centralProvisioning.replyWith('provisioned');
			}
			return current;
		},
		async release(outcome): Promise<void> {
			if (current === undefined) return;
			if (outcome === 'failed') {
				await discard();
				return;
			}
			try {
				await resetRequestHarness(current);
				const probe = await current.auth('/__auth-proof/deferred-work');
				if (!probe.ok) throw new Error('S2 shared-host health probe failed');
			} catch (error) {
				await discard();
				throw error;
			}
		},
		close: discard,
	};
}

/**
 * Design B: one shared host per caller. Groups of different callers run on different hosts at the
 * same time; groups of one caller queue on its host, so a host never serves two groups at once.
 * With `concurrent: false` every caller queues on one host (Design A).
 */
export interface CallerHarnessLanes<Caller extends string> {
	readonly run: <Result>(
		caller: Caller,
		work: (harness: RequestHarness) => Promise<Result>,
	) => Promise<Result>;
	readonly close: () => Promise<void>;
}

export function createCallerHarnessLanes<Caller extends string>(
	callers: readonly Caller[],
	options: { readonly concurrent: boolean },
): CallerHarnessLanes<Caller> {
	const laneFor = (caller: Caller): string => (options.concurrent ? caller : 'one-host');
	const lanes = new Map(
		callers.map((caller) => [
			laneFor(caller),
			{ host: createSharedRequestHarness(), queue: Promise.resolve() as Promise<unknown> },
		]),
	);
	return {
		run(caller, work) {
			const lane = lanes.get(laneFor(caller));
			if (lane === undefined) throw new Error(`No host lane for caller ${caller}`);
			const turn = lane.queue.then(async () => {
				const harness = await lane.host.acquire();
				let outcome: 'passed' | 'failed' = 'failed';
				try {
					const result = await work(harness);
					outcome = 'passed';
					return result;
				} finally {
					await lane.host.release(outcome);
				}
			});
			lane.queue = turn.catch(() => undefined);
			return turn;
		},
		async close(): Promise<void> {
			await Promise.all([...lanes.values()].map(async (lane) => lane.host.close()));
		},
	};
}
