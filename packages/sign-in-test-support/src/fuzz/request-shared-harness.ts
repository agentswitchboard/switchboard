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
			current ??= await startLocalAuthHarness();
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
