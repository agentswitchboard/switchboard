import {
	deviceCode,
	session,
	signInConfigurationSchema,
	trustedSignInClientAddressHeader,
} from '@agent-collaboration/sign-in-core';
import {
	createSignInProvider,
	machineTokenDecisionSchema,
	machineTokenResponseSchema,
} from '@agent-collaboration/sign-in-core/better-auth';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import type { DBAdapter } from 'better-auth/adapters';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { StorageCaseContext } from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStorageMembership,
	createStoragePerson,
	resetStorageCase,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';

export const redemptionRaceScheduleSchema = z
	.strictObject({
		pollers: z.number().int().min(2).max(5),
		addressOrdinal: z.number().int().min(0).max(65_535),
		pendingFirst: z.boolean(),
		latePollers: z.number().int().min(0).max(5),
		expiryWins: z.boolean(),
		releaseOrder: z.array(z.number().int().min(0).max(4)).max(5),
	})
	.refine(({ pollers, pendingFirst, latePollers, expiryWins, releaseOrder }) => {
		const contenders = pollers - Number(pendingFirst) - latePollers;
		return (
			contenders >= 0 &&
			releaseOrder.length === contenders &&
			new Set(releaseOrder).size === contenders &&
			releaseOrder.every((position) => position < contenders) &&
			(!expiryWins || latePollers > 0)
		);
	});
type RedemptionRaceSchedule = z.infer<typeof redemptionRaceScheduleSchema>;

function redemptionBarrier(expected: number): {
	readonly entered: () => Promise<void>;
	readonly reached: Promise<void>;
	readonly release: (position: number) => void;
	readonly releaseAll: () => void;
	readonly count: () => number;
} {
	const reached = Promise.withResolvers<void>();
	const arrivals = Array.from({ length: expected }, () => Promise.withResolvers<void>());
	let count = 0;
	if (expected === 0) reached.resolve();
	return {
		async entered(): Promise<void> {
			const arrival = arrivals[count];
			if (arrival === undefined) throw new Error('Unexpected extra redemption attempt');
			count += 1;
			if (count === expected) reached.resolve();
			await arrival.promise;
		},
		reached: reached.promise,
		release(position): void {
			arrivals[position]?.resolve();
		},
		releaseAll(): void {
			for (const arrival of arrivals) arrival.resolve();
		},
		count: () => count,
	};
}

/** The storage seam wraps the public provider adapter, then delegates to the stock
 * consumeOne. The read barrier only makes both native poll pacing checks observe
 * the same pre-poll row. The consume barrier witnesses the actual delete boundary.
 */
export async function raceNativeDeviceRedemption(
	context: StorageCaseContext,
	schedule: RedemptionRaceSchedule = {
		pollers: 2,
		addressOrdinal: 0,
		pendingFirst: false,
		latePollers: 0,
		expiryWins: false,
		releaseOrder: [0, 1],
	},
): Promise<{
	readonly readArrivals: number;
	readonly consumeArrivals: number;
	readonly conditionsMatched: boolean;
	readonly statuses: readonly number[];
	readonly mintCalls: number;
	readonly minted: number;
	readonly codeRemoved: boolean;
	readonly personSessionsUnchanged: boolean;
	readonly noSessionCookies: boolean;
	readonly pendingError: string | null;
	readonly lateErrors: readonly string[];
}> {
	await resetStorageCase(context);
	const ids = context.platform.ids;
	const ownerId = await createStoragePerson(context, `${ids.nextId()}@example.invalid`);
	const organizationId = await createStorageMembership(context, ownerId);
	const routerClientId = ids.nextId();
	const machineId = ids.nextId();
	const enrollmentId = ids.nextId();
	const recordId = ids.nextId();
	const pollingCode = `fixture-${ids.nextId()}`;
	const now = context.platform.clock.now();
	const deadline = now + 30_000;
	const contenders = schedule.releaseOrder.length;
	const database = context.openDatabase();
	// Setup uses the fixture row. The endpoint recovery test owns approval itself.
	await database.insert(deviceCode).values({
		id: recordId,
		deviceCode: pollingCode,
		userCode: `RACE-${recordId}`,
		userId: ownerId,
		expiresAt: new Date(deadline),
		status: schedule.pendingFirst ? 'pending' : 'approved',
		pollingInterval: 5_000,
		clientId: routerClientId,
		scope: 'offline_access',
		machineId,
		machineLabel: 'Proof Mac',
		organizationId,
		enrollmentId,
	});
	const readBarrier = redemptionBarrier(contenders);
	const consumeBarrier = redemptionBarrier(contenders);
	let concurrencyWindow = false;
	const consumeConditions: boolean[] = [];
	let mintCalls = 0;
	const properties = storageProviderProperties(context, organizationId);
	const configuration = signInConfigurationSchema.parse({
		...properties.configuration,
		machineLogin: {
			routerClientId,
			machineAudience: 'https://central.example.invalid/machine',
			linkUrlTemplate: 'https://central.example.invalid/v1/organizations/{organization_id}/link',
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
		database(options: BetterAuthOptions): DBAdapter {
			const stock = openAdapter(options);
			return {
				...stock,
				async findOne<TRow>(input: Parameters<DBAdapter['findOne']>[0]): Promise<TRow | null> {
					const result = await stock.findOne<TRow>(input);
					if (
						concurrencyWindow &&
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
						if (concurrencyWindow) await consumeBarrier.entered();
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
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					[trustedSignInClientAddressHeader]: `2001:db8:${schedule.addressOrdinal.toString(16)}::1`,
				},
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					client_id: routerClientId,
					device_code: pollingCode,
				}),
			}),
		);
	const requests: Promise<Response>[] = [];
	const nativeDate = Date;
	let nativeTime: number = now;
	function moveTime(milliseconds: number): void {
		nativeTime = milliseconds;
		context.setTime(milliseconds);
	}
	globalThis.Date = new Proxy(nativeDate, {
		construct(target, args: unknown[]): Date {
			if (args.length === 0) return new nativeDate(nativeTime);
			const value: unknown = Reflect.construct(target, args);
			if (!(value instanceof nativeDate)) throw new Error('Expected a native Date');
			return value;
		},
		get(target, key, receiver: unknown): unknown {
			return key === 'now' ? () => nativeTime : Reflect.get(target, key, receiver);
		},
	});
	const errorReply = z.object({ error: z.string() });
	let pendingError: string | null = null;
	const lateErrors: string[] = [];
	try {
		if (schedule.pendingFirst) {
			const pending = redeem();
			requests.push(pending);
			pendingError = errorReply.parse(await (await pending).clone().json()).error;
			await database
				.update(deviceCode)
				.set({ status: 'approved' })
				.where(eq(deviceCode.id, recordId));
			moveTime(now + 5_001);
		}
		concurrencyWindow = true;
		const racing = Array.from({ length: contenders }, redeem);
		requests.push(...racing);
		if (contenders > 0) {
			const premature = Promise.race(racing).then((response) => {
				throw new Error(
					`A poll returned ${response.status} before all pollers reached the storage boundary`,
				);
			});
			await Promise.race([readBarrier.reached, premature]);
			readBarrier.releaseAll();
			await Promise.race([consumeBarrier.reached, premature]);
		}
		concurrencyWindow = false;
		async function pollAfterExpiry(): Promise<void> {
			if (schedule.latePollers === 0) return;
			moveTime(deadline + 1);
			for (let poller = 0; poller < schedule.latePollers; poller += 1) {
				const poll = redeem();
				requests.push(poll);
				const response = await poll;
				lateErrors.push(
					response.ok ? 'unexpected-token' : errorReply.parse(await response.clone().json()).error,
				);
			}
		}
		if (schedule.expiryWins) await pollAfterExpiry();
		for (const position of schedule.releaseOrder) consumeBarrier.release(position);
		await Promise.all(racing);
		if (!schedule.expiryWins) await pollAfterExpiry();
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
			pendingError,
			lateErrors,
		};
	} finally {
		readBarrier.releaseAll();
		consumeBarrier.releaseAll();
		try {
			await Promise.allSettled(requests);
		} finally {
			globalThis.Date = nativeDate;
			context.setTime(now);
		}
	}
}
