import { deviceCode, session, signInConfigurationSchema } from '@agent-collaboration/sign-in-core';
import {
	createSignInProvider,
	machineTokenDecisionSchema,
	machineTokenResponseSchema,
} from '@agent-collaboration/sign-in-core/better-auth';
import { betterAuth } from 'better-auth';
import type { DBAdapter } from 'better-auth/adapters';
import { eq } from 'drizzle-orm';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStorageMembership,
	createStoragePerson,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';

function twoArrivals(): {
	readonly entered: () => Promise<void>;
	readonly bothReached: Promise<void>;
	readonly release: () => void;
	readonly count: () => number;
} {
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let count = 0;
	return {
		async entered(): Promise<void> {
			count += 1;
			if (count === 2) arrived.resolve();
			if (count > 2) throw new Error('Unexpected extra redemption attempt');
			await release.promise;
		},
		bothReached: arrived.promise,
		release: release.resolve,
		count: () => count,
	};
}

/** The storage seam wraps the public provider adapter, then delegates to the stock
 * consumeOne. The read barrier only makes both native poll pacing checks observe
 * the same pre-poll row. The consume barrier witnesses the actual delete boundary.
 */
export async function raceNativeDeviceRedemption(context: StorageCaseContext): Promise<{
	readonly readArrivals: number;
	readonly consumeArrivals: number;
	readonly conditionsMatched: boolean;
	readonly statuses: readonly number[];
	readonly mintCalls: number;
	readonly minted: number;
	readonly codeRemoved: boolean;
	readonly personSessionsUnchanged: boolean;
	readonly noSessionCookies: boolean;
}> {
	const ids = context.platform.ids;
	const ownerId = await createStoragePerson(context, `${ids.nextId()}@example.invalid`);
	const organizationId = await createStorageMembership(context, ownerId);
	const routerClientId = ids.nextId();
	const machineId = ids.nextId();
	const enrollmentId = ids.nextId();
	const recordId = ids.nextId();
	const pollingCode = `fixture-${ids.nextId()}`;
	const now = context.platform.clock.now();
	const database = context.openDatabase();
	// The approval path is covered independently. Start this race at the post-approval row.
	await database.insert(deviceCode).values({
		id: recordId,
		deviceCode: pollingCode,
		userCode: `RACE-${recordId}`,
		userId: ownerId,
		expiresAt: new Date(now + 600_000),
		status: 'approved',
		pollingInterval: 5_000,
		clientId: routerClientId,
		scope: 'offline_access',
		machineId,
		machineLabel: 'Proof Mac',
		organizationId,
		enrollmentId,
	});
	const readBarrier = twoArrivals();
	const consumeBarrier = twoArrivals();
	const consumeConditions: boolean[] = [];
	let mintCalls = 0;
	const properties = storageProviderProperties(context, organizationId);
	const configuration = signInConfigurationSchema.parse({
		...properties.configuration,
		machineLogin: {
			routerClientId,
			machineAudience: 'https://central.example.invalid/machine',
			fleetCentral: { receiver: ids.nextId(), relay: ids.nextId() },
		},
	});
	const base = createSignInProvider({
		...properties,
		configuration,
		authority: { kind: 'public' },
		machineLoginDecisions: {
			async decideDeviceLogin() {
				throw new Error('Redemption must not call approval');
			},
			async decideMachineToken(request) {
				mintCalls += 1;
				if (
					request.enrollmentId !== enrollmentId ||
					request.clientId !== enrollmentId ||
					request.organizationId !== organizationId
				)
					throw new Error('Mint request selected a different enrollment');
				const decidedAt = Math.floor(now / 1000);
				return {
					kind: 'answered',
					decision: machineTokenDecisionSchema.parse({
						result: 'grant',
						machineId,
						enrollmentId,
						decidedAt,
						grantExpiresAt: decidedAt + 3600,
					}),
				};
			},
		},
	});
	const openAdapter = base.options.database;
	if (typeof openAdapter !== 'function')
		throw new Error('Missing the native Drizzle adapter factory');
	const provider = betterAuth({
		...base.options,
		database(options): DBAdapter {
			const stock = openAdapter(options);
			return {
				...stock,
				async findOne<TRow>(input: Parameters<DBAdapter['findOne']>[0]): Promise<TRow | null> {
					const result = await stock.findOne<TRow>(input);
					if (
						input.model === 'deviceCode' &&
						input.where.some(({ field }) => field === 'deviceCode')
					)
						await readBarrier.entered();
					return result;
				},
				async consumeOne<TRow>(
					input: Parameters<DBAdapter['consumeOne']>[0],
				): Promise<TRow | null> {
					if (input.model === 'deviceCode') {
						consumeConditions.push(
							input.where.some(({ field, value }) => field === 'id' && value === recordId) &&
								input.where.some(
									({ field, value }) => field === 'clientId' && value === routerClientId,
								) &&
								input.where.some(({ field, value }) => field === 'status' && value === 'approved'),
						);
						await consumeBarrier.entered();
					}
					return stock.consumeOne<TRow>(input);
				},
			};
		},
	});
	const before = await database.select({ id: session.id }).from(session);
	const redeem = (): Promise<Response> =>
		provider.handler(
			new Request(`${configuration.issuer}/api/auth/oauth2/token`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					client_id: routerClientId,
					device_code: pollingCode,
				}),
			}),
		);
	const requests = [redeem(), redeem()];
	const premature = Promise.race(requests).then((response) => {
		throw new Error(
			`A poll returned ${response.status} before both pollers reached the storage boundary`,
		);
	});
	try {
		await Promise.race([readBarrier.bothReached, premature]);
		readBarrier.release();
		await Promise.race([consumeBarrier.bothReached, premature]);
		consumeBarrier.release();
		const responses = await Promise.all(requests);
		const successes = await Promise.all(
			responses
				.filter((response) => response.ok)
				.map(
					async (response) => machineTokenResponseSchema.safeParse(await response.json()).success,
				),
		);
		const after = await database.select({ id: session.id }).from(session);
		const row = await database
			.select({ id: deviceCode.id })
			.from(deviceCode)
			.where(eq(deviceCode.id, recordId));
		return {
			readArrivals: readBarrier.count(),
			consumeArrivals: consumeBarrier.count(),
			conditionsMatched: consumeConditions.every(Boolean),
			statuses: responses
				.map((response) => response.status)
				.toSorted((left, right) => left - right),
			mintCalls,
			minted: successes.filter(Boolean).length,
			codeRemoved: row.length === 0,
			personSessionsUnchanged: before.length === 0 && after.length === 0,
			noSessionCookies: responses.every((response) => !response.headers.has('set-cookie')),
		};
	} finally {
		readBarrier.release();
		consumeBarrier.release();
		await Promise.allSettled(requests);
	}
}
