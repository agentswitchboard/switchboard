import {
	createSignInStore,
	epochMillisecondsSchema,
	uuid7Schema,
	type AtomicRunner,
	type AtomicStatement,
	type AtomicStatementGroup,
	type SignInDatabaseFactory,
	type SignInPlatform,
	type SignInStore,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import {
	matchesDatabaseFault,
	type DatabaseFault,
} from '#sign-in-test-support/test-fixtures/database-fault-identity';
import { unreachedDeadline } from '#sign-in-test-support/test-fixtures/manual-deadlines';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

export const storageCaseTime = 2_208_988_800_000;
export const storageCaseOwnerEmail = 'storage-owner@example.invalid';
const builtStatementSchema = z.object({ sql: z.string(), params: z.array(z.unknown()) });

function hasPublicSqlBuilder(
	statement: AtomicStatement,
): statement is AtomicStatement & { toSQL(): unknown } {
	return 'toSQL' in statement && typeof statement.toSQL === 'function';
}

function inspectBuiltStatement(statement: AtomicStatement): z.infer<typeof builtStatementSchema> {
	if (!hasPublicSqlBuilder(statement))
		throw new Error('Storage fixture needs a public Drizzle query builder');
	const built: unknown = statement.toSQL();
	return builtStatementSchema.parse(built);
}
/**
 * A concurrent writer for one read. It runs once, at the first point the database lets another
 * writer in after the named driver read: straight after a standalone read, or only after the
 * snapshot (D1 batch, SQLite transaction) that holds the read has ended.
 */
export interface ReadInterleaving {
	readonly followsRead: (query: string) => boolean;
	readonly write: () => Promise<void>;
}
export type ReadInterleavingOutcome = 'written' | 'read-not-reached';

export interface StorageCaseContext {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: SignInPlatform;
	readonly store: SignInStore;
	readonly issuedIds: readonly string[];
	readonly openCount: () => number;
	readonly clockReadCount: () => number;
	readonly setTime: (milliseconds: number) => void;
	readonly readFault: () => DatabaseFault | null;
	readonly setFault: (fault: DatabaseFault | null) => void;
	readonly beforeAtomic: (observe: ((group: AtomicStatementGroup) => Promise<void>) | null) => void;
	readonly interleaveAfterRead: (interleaving: ReadInterleaving) => void;
	readonly interleavedWrite: () => Promise<ReadInterleavingOutcome>;
	/** Leg wiring: called by each leg's driver hook once that driver read's rows are back. */
	readonly startReadInterleaving: (query: string) => Promise<void> | null;
}

export function createStorageCaseContext(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly runAtomically: AtomicRunner;
	readonly faultInjection?: 'driver' | 'batch';
}): StorageCaseContext {
	let openCount = 0;
	let sequence = 0;
	let clockReads = 0;
	let controlledTime = epochMillisecondsSchema.parse(storageCaseTime);
	let fault: DatabaseFault | null = null;
	let beforeAtomic: ((group: AtomicStatementGroup) => Promise<void>) | null = null;
	let armedInterleaving: ReadInterleaving | null = null;
	let startedInterleaving: Promise<void> | null = null;
	const issuedIds: string[] = [];
	const openDatabase: SignInDatabaseFactory = () => {
		openCount += 1;
		return props.openDatabase();
	};
	const platform: SignInPlatform = {
		// These isolated provider/store cases do not claim the public outer gate.
		requestLimiter: { allow: async () => ({ kind: 'allowed' }) },
		centralClient: {
			readStatementDigest: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
			pushAuthorizationRevision: async () => ({ kind: 'unknown', reason: 'unavailable' }),
			sendFleetAdminRequest: async () => ({
				kind: 'unknown' as const,
				reason: 'unavailable' as const,
			}),
			relayFleetAdminRequest: async () => ({
				kind: 'unknown' as const,
				reason: 'unavailable' as const,
			}),
			sendApprovalPersonRequest: async () => ({
				kind: 'unknown' as const,
				reason: 'unavailable' as const,
			}),
			relayApprovalPersonRequest: async () => ({
				kind: 'unknown' as const,
				reason: 'unavailable' as const,
			}),
			provisionOrganization: async () => ({ kind: 'unknown', reason: 'unavailable' }),
		},
		log: (): void => undefined,
		crypto: webSignInCrypto,
		// No storage case waits on time; D7 cases bring their own manual deadline source.
		deadlines: { start: () => ({ signal: unreachedDeadline(), cancel: (): void => undefined }) },
		clock: {
			now: () => {
				clockReads += 1;
				return controlledTime;
			},
		},
		ids: {
			nextId: () => {
				sequence += 1;
				const timestamp = controlledTime.toString(16).padStart(12, '0');
				const id = uuid7Schema.parse(
					`${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, '0')}`,
				);
				issuedIds.push(id);
				return id;
			},
		},
		runAtomically: async (group) => {
			try {
				if (beforeAtomic !== null) await beforeAtomic(group);
				if (
					props.faultInjection !== 'driver' &&
					fault !== null &&
					group.some((statement) => {
						const built = inspectBuiltStatement(statement);
						return (
							fault !== null &&
							matchesDatabaseFault({ query: built.sql, parameters: built.params }, fault)
						);
					})
				)
					return { kind: 'failed', reason: 'database-error' };
				return await props.runAtomically(group);
			} catch {
				return { kind: 'failed', reason: 'database-error' };
			}
		},
	};
	return {
		openDatabase,
		platform,
		issuedIds,
		store: createSignInStore({ openDatabase, platform, ownerEmail: storageCaseOwnerEmail }),
		openCount: () => openCount,
		clockReadCount: () => clockReads,
		setTime: (milliseconds) => {
			controlledTime = epochMillisecondsSchema.parse(milliseconds);
		},
		readFault: () => fault,
		setFault: (next) => {
			fault = next;
		},
		beforeAtomic: (observe) => {
			beforeAtomic = observe;
		},
		interleaveAfterRead: (interleaving) => {
			armedInterleaving = interleaving;
			startedInterleaving = null;
		},
		interleavedWrite: async () => {
			armedInterleaving = null;
			if (startedInterleaving === null) return 'read-not-reached';
			await startedInterleaving;
			return 'written';
		},
		startReadInterleaving: (query) => {
			const interleaving = armedInterleaving;
			if (interleaving === null || !interleaving.followsRead(query)) return null;
			armedInterleaving = null;
			startedInterleaving = interleaving.write();
			return startedInterleaving;
		},
	};
}
