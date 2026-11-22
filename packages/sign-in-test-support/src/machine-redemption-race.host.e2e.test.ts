import { expect, it } from 'vitest';

import { createStorageTestHost } from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();
it.each(['better-sqlite3', 'd1-workerd'] as const)(
	'holds both machine pollers at the native conditional consume on %s and releases one token',
	async (leg): Promise<void> => {
		const host = await createStorageTestHost(leg);
		try {
			expect(await host.runCommand({ kind: 'device-redemption-race' })).toEqual({
				readArrivals: 2,
				consumeArrivals: 2,
				conditionsMatched: true,
				statuses: [200, 400],
				mintCalls: 1,
				minted: 1,
				codeRemoved: true,
				personSessionsUnchanged: true,
				noSessionCookies: true,
				pendingError: null,
				lateErrors: [],
			});
		} finally {
			await host.close();
		}
	},
);
