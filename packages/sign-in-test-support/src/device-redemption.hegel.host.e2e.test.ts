import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { createStorageTestHost } from '#sign-in-test-support/storage-cases/dual-storage-test-host';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';

useControlledSignInClock();

const raceResultSchema = z.object({ lateErrors: z.array(z.string()) });

it.each(['better-sqlite3', 'd1-workerd'] as const)(
	'R33 checks 100 generated device redemption schedules through native consume on %s',
	async (leg): Promise<void> => {
		const host = await createStorageTestHost(leg);
		let addressOrdinal = 0;
		try {
			await hegel.testAsync(
				async (testCase) => {
					const pollers = testCase.draw(generators.integers({ minValue: 2, maxValue: 5 }));
					const pendingFirst = testCase.draw(generators.sampledFrom([false, true]));
					const available = pollers - Number(pendingFirst);
					const latePollers = testCase.draw(
						generators.integers({ minValue: 0, maxValue: available }),
					);
					const contenders = available - latePollers;
					const expiryWins =
						latePollers > 0 &&
						(contenders === 0 || testCase.draw(generators.sampledFrom([false, true])));
					const remaining = Array.from({ length: contenders }, (_unused, index) => index);
					const releaseOrder: number[] = [];
					while (remaining.length > 0) {
						const arrival = testCase.draw(generators.sampledFrom(remaining));
						releaseOrder.push(arrival);
						remaining.splice(remaining.indexOf(arrival), 1);
					}
					const result = await host.runCommand({
						kind: 'device-redemption-race',
						schedule: {
							pollers,
							addressOrdinal: ++addressOrdinal,
							pendingFirst,
							latePollers,
							expiryWins,
							releaseOrder,
						},
					});
					const minted = expiryWins ? 0 : 1;
					expect(result).toMatchObject({
						readArrivals: contenders,
						consumeArrivals: contenders,
						conditionsMatched: true,
						statuses: [
							...Array<number>(minted).fill(200),
							...Array<number>(pollers - minted).fill(400),
						],
						mintCalls: minted,
						minted,
						codeRemoved: true,
						personSessionsUnchanged: true,
						noSessionCookies: true,
						pendingError: pendingFirst ? 'authorization_pending' : null,
					});
					const { lateErrors } = raceResultSchema.parse(result);
					expect(lateErrors).toHaveLength(latePollers);
					if (expiryWins) expect(lateErrors[0]).toBe('expired_token');
					expect(
						lateErrors.every((error) => error === 'expired_token' || error === 'invalid_grant'),
					).toBe(true);
				},
				{
					testCases: 100,
					derandomize: true,
					database: hegel.Database.disabled,
					suppressHealthCheck: [hegel.HealthCheck.TooSlow],
				},
			);
		} finally {
			await host.close();
		}
	},
);
