import { and, eq, exists, inArray, ne, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteSelectBase, SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import type { AtomicStatement, SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import { fleetPermissionPolicyDigest } from '#sign-in-core/organizations/fleet-permission-policy-digest';
import { backfillAuthorizationRevisions } from '#sign-in-core/storage/authorization-revision-backfill';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import {
	member,
	organization,
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
	session,
} from '#sign-in-core/storage/sign-in-schema';

export const nativeMemberInput = z.object({
	id: z.uuidv7(),
	organizationId: z.uuidv7(),
	userId: z.uuidv7(),
	role: z.string(),
	createdAt: z.date(),
});
export const nativeOrganizationInput = z.object({
	id: z.uuidv7(),
	name: z.string(),
	slug: z.string(),
	createdAt: z.date(),
	logo: z.string().nullable().optional(),
	metadata: z.string().nullable().optional(),
	fleetState: z.string().optional(),
});

export type FencedModel = 'member' | 'session' | 'organization';

export function fencedTable(
	model: FencedModel,
): typeof member | typeof session | typeof organization {
	switch (model) {
		case 'member':
			return member;
		case 'session':
			return session;
		case 'organization':
			return organization;
	}
}

/** Each method is one fixed batch: the native DML and every fence it moves commit together. */
export interface AuthorizationFenceMutations {
	readonly createMember: (input: unknown) => Promise<Record<string, unknown>>;
	readonly createOrganization: (input: unknown) => Promise<Record<string, unknown>>;
	/** The predicate selects the native rows exactly as the caller's where-clause does. */
	readonly updateMember: (
		predicate: SQL | undefined,
		input: unknown,
	) => Promise<readonly unknown[]>;
	readonly deleteRows: (model: FencedModel, predicate: SQL | undefined) => Promise<number>;
}

/**
 * r3 sections 3 and 6: fences move only inside the batch that commits their native DML,
 * with affected rows selected inside that batch. A missing retained row aborts the batch;
 * it is never reset to revision 1.
 */
export function createAuthorizationFenceMutations(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly platform: Pick<SignInPlatform, 'runAtomically' | 'clock' | 'ids'>;
}): AuthorizationFenceMutations {
	const { platform } = props;
	const database = props.openDatabase();
	/**
	 * WS3 (Lead, 12 Nov): a batch that fails because its organizations predate the fence tables
	 * backfills them (insert-or-ignore) and retries the same statements once. Only a wholly
	 * unfenced organization (no organization fence and no person pair) is backfilled: any partial
	 * state means a retained row was lost, and r3 never resets one, so that still fails closed, as
	 * does a failed backfill or a second failure.
	 */
	async function commit(
		statements: readonly [AtomicStatement, ...AtomicStatement[]],
		organizationsToBackfill: () => Promise<readonly string[]>,
	): Promise<readonly unknown[]> {
		const first = await platform.runAtomically(statements);
		if (first.kind === 'committed') return first.rows.at(-1) ?? [];
		const organizationIds = await whollyUnfenced(await organizationsToBackfill());
		const backfilled =
			organizationIds.length === 0
				? null
				: await backfillAuthorizationRevisions({ ...props, organizationIds });
		if (backfilled === null || backfilled.kind === 'store-unavailable')
			throw new Error('Atomic native and fence mutation failed');
		const retried = await platform.runAtomically(statements);
		if (retried.kind === 'failed') throw new Error('Atomic native and fence mutation failed');
		return retried.rows.at(-1) ?? [];
	}
	/** Organizations with neither an organization fence nor any person pair: they predate the
	 * fence tables, since organization creation and the backfill write fences atomically. */
	async function whollyUnfenced(organizationIds: readonly string[]): Promise<readonly string[]> {
		if (organizationIds.length === 0) return [];
		const rows = await database
			.select({ id: organization.id })
			.from(organization)
			.where(
				and(
					inArray(organization.id, [...organizationIds]),
					notExists(
						database
							.select({ id: organizationFence.id })
							.from(organizationFence)
							.where(eq(organizationFence.id, organization.id)),
					),
					notExists(
						database
							.select({ id: personFence.id })
							.from(personFence)
							.where(eq(personFence.organizationId, organization.id)),
					),
				),
			);
		return z
			.array(z.strictObject({ id: z.string() }))
			.parse(rows)
			.map((row) => row.id);
	}
	/** The organizations a model and predicate reach, read only when a batch failed. */
	async function affectedOrganizations(
		model: FencedModel,
		predicate: SQL | undefined,
	): Promise<readonly string[]> {
		const affected = matchedMembers(model, predicate).as('recovery_members');
		const rows = await database
			.selectDistinct({ organizationId: affected.organizationId })
			.from(affected);
		return z
			.array(z.strictObject({ organizationId: z.string() }))
			.parse(rows)
			.map((row) => row.organizationId);
	}
	function bumpFields(state?: 'active' | 'inactive'): SQLiteUpdateSetSource<typeof personFence> {
		const now = platform.clock.now();
		return {
			revision: sql`${personFence.revision} + ${1}`,
			...(state === undefined ? {} : { state }),
			nextAttemptAt: now,
			updatedAt: now,
		};
	}
	function matchedMembers(
		model: FencedModel,
		predicate: SQL | undefined,
	): SQLiteSelectBase<
		'member',
		'sync' | 'async',
		unknown,
		typeof member._.columns,
		'single',
		Record<'member', 'not-null'>,
		true
	> {
		if (model === 'member') return database.select().from(member).where(predicate).$dynamic();
		if (model === 'organization')
			return database
				.select()
				.from(member)
				.where(
					inArray(
						member.organizationId,
						database.select({ id: organization.id }).from(organization).where(predicate),
					),
				)
				.$dynamic();
		return database
			.select()
			.from(member)
			.where(
				inArray(
					member.userId,
					database.select({ id: session.userId }).from(session).where(predicate),
				),
			)
			.$dynamic();
	}
	function invariantGuard(model: FencedModel, predicate: SQL | undefined): AtomicStatement {
		const affected = matchedMembers(model, predicate).as('affected_members');
		const missing = database
			.select({ organizationId: affected.organizationId })
			.from(affected)
			.where(
				or(
					notExists(
						database
							.select({ id: organizationFence.id })
							.from(organizationFence)
							.where(eq(organizationFence.id, affected.organizationId)),
					),
					notExists(
						database
							.select({ id: personFence.id })
							.from(personFence)
							.where(
								and(
									eq(personFence.organizationId, affected.organizationId),
									eq(personFence.personId, affected.userId),
								),
							),
					),
				),
			);
		// An existing required pair is missing: deliberately violate the approved
		// revision CHECK inside the same batch. There is no reset/upsert repair.
		// A native parent FK guarantees the organization exists; its fence must too.
		return database
			.insert(personFence)
			.select(
				database
					.select({
						id: sql<string>`${platform.ids.nextId()}`.as('id'),
						organizationId: affected.organizationId,
						personId: affected.userId,
						revision: sql<number>`${0}`.as('revision'),
						state: sql<'inactive'>`${'inactive'}`.as('state'),
						acknowledgedRevision: sql<number>`${0}`.as('acknowledged_revision'),
						acknowledgedAt: sql<null>`${null}`.as('acknowledged_at'),
						nextAttemptAt: sql<number>`${platform.clock.now()}`.as('next_attempt_at'),
						createdAt: sql<number>`${platform.clock.now()}`.as('created_at'),
						updatedAt: sql<number>`${platform.clock.now()}`.as('updated_at'),
					})
					.from(affected)
					.where(inArray(affected.organizationId, missing)),
			)
			.returning();
	}
	function bumpTargets(model: FencedModel, predicate: SQL | undefined): AtomicStatement {
		if (model === 'session')
			return database
				.update(personFence)
				.set(bumpFields())
				.where(
					inArray(
						personFence.personId,
						database.select({ personId: session.userId }).from(session).where(predicate),
					),
				)
				.returning();
		const affected = matchedMembers(model, predicate).as('affected_members');
		return database
			.update(personFence)
			.set(bumpFields('inactive'))
			.where(
				exists(
					database
						.select({ id: affected.id })
						.from(affected)
						.where(
							and(
								eq(affected.organizationId, personFence.organizationId),
								eq(affected.userId, personFence.personId),
							),
						),
				),
			)
			.returning();
	}
	return {
		async createMember(input: unknown): Promise<Record<string, unknown>> {
			const data = nativeMemberInput.parse(input);
			const now = platform.clock.now();
			const liveOrganization = database
				.select({ id: organizationFence.id })
				.from(organizationFence)
				.where(
					and(
						eq(organizationFence.id, data.organizationId),
						ne(organizationFence.state, 'deleted'),
					),
				);
			const rows = await commit(
				[
					database
						.insert(personFence)
						.values({
							id: platform.ids.nextId(),
							organizationId: data.organizationId,
							personId: data.userId,
							revision: sql`case when ${exists(liveOrganization)} then ${1} else ${0} end`,
							state: 'active',
							acknowledgedRevision: 0,
							nextAttemptAt: now,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: [personFence.organizationId, personFence.personId],
							set: bumpFields('active'),
						})
						.returning(),
					database.insert(member).values(data).returning(),
				],
				async () => [data.organizationId],
			);
			return z.record(z.string(), z.unknown()).parse(rows[0]);
		},
		async createOrganization(input: unknown): Promise<Record<string, unknown>> {
			const data = nativeOrganizationInput.parse(input);
			const now = platform.clock.now();
			const rows = await commit(
				[
					database
						.insert(organizationFence)
						.values({
							id: data.id,
							revision: 1,
							state: 'active',
							permissionPolicyDigest: fleetPermissionPolicyDigest,
							acknowledgedRevision: 0,
							nextAttemptAt: now,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
					database.insert(organization).values(data).returning(),
				],
				async () => [],
			);
			return z.record(z.string(), z.unknown()).parse(rows[0]);
		},
		async updateMember(predicate: SQL | undefined, input: unknown): Promise<readonly unknown[]> {
			const update = z.strictObject({ role: z.string() }).parse(input);
			const changed = and(predicate, ne(member.role, update.role));
			const affected = database.select().from(member).where(changed).as('changed_members');
			return commit(
				[
					invariantGuard('member', predicate),
					database
						.update(personFence)
						.set(bumpFields('active'))
						.where(
							exists(
								database
									.select({ id: affected.id })
									.from(affected)
									.where(
										and(
											eq(affected.organizationId, personFence.organizationId),
											eq(affected.userId, personFence.personId),
										),
									),
							),
						)
						.returning(),
					database.update(member).set(update).where(predicate).returning(),
				],
				async () => affectedOrganizations('member', predicate),
			);
		},
		async deleteRows(model: FencedModel, predicate: SQL | undefined): Promise<number> {
			const table = fencedTable(model);
			const finalDelete = database.delete(table).where(predicate).returning({ id: table.id });
			if (model === 'session') {
				const missingOrganizations = database
					.select({ id: personFence.organizationId })
					.from(personFence)
					.where(
						and(
							inArray(
								personFence.personId,
								database.select({ id: session.userId }).from(session).where(predicate),
							),
							notExists(
								database
									.select({ id: organizationFence.id })
									.from(organizationFence)
									.where(eq(organizationFence.id, personFence.organizationId)),
							),
						),
					)
					.as('missing_retained_organizations');
				const now = platform.clock.now();
				return (
					await commit(
						[
							invariantGuard(model, predicate),
							database
								.insert(organizationFence)
								.select(
									database
										.select({
											id: missingOrganizations.id,
											revision: sql<number>`${0}`.as('revision'),
											state: sql<'deleted'>`${'deleted'}`.as('state'),
											permissionPolicyDigest: sql<string>`${'0'.repeat(64)}`.as(
												'permission_policy_digest',
											),
											acknowledgedRevision: sql<number>`${0}`.as('acknowledged_revision'),
											acknowledgedAt: sql<null>`${null}`.as('acknowledged_at'),
											nextAttemptAt: sql<number>`${now}`.as('next_attempt_at'),
											createdAt: sql<number>`${now}`.as('created_at'),
											updatedAt: sql<number>`${now}`.as('updated_at'),
										})
										.from(missingOrganizations),
								)
								.returning(),
							bumpTargets(model, predicate),
							finalDelete,
						],
						async () => affectedOrganizations(model, predicate),
					)
				).length;
			}
			if (model === 'member')
				return (
					await commit(
						[
							invariantGuard(model, predicate),
							bumpTargets(model, predicate),
							database
								.update(session)
								.set({ activeOrganizationId: null })
								.where(
									exists(
										database
											.select({ id: member.id })
											.from(member)
											.where(
												and(
													predicate,
													eq(member.userId, session.userId),
													eq(member.organizationId, session.activeOrganizationId),
												),
											),
									),
								)
								.returning({ id: session.id }),
							finalDelete,
						],
						async () => affectedOrganizations(model, predicate),
					)
				).length;
			const now = platform.clock.now();
			// Force missing organization fence to fail inside the batch, including an
			// empty organization with no member rows left after native bulk deletion.
			const missing = database
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						predicate,
						notExists(
							database
								.select({ id: organizationFence.id })
								.from(organizationFence)
								.where(eq(organizationFence.id, organization.id)),
						),
					),
				);
			return (
				await commit(
					[
						invariantGuard(model, predicate),
						bumpTargets(model, predicate),
						database
							.insert(organizationFence)
							.select(
								database
									.select({
										id: organization.id,
										revision: sql<number>`${0}`.as('revision'),
										state: sql<'deleted'>`${'deleted'}`.as('state'),
										permissionPolicyDigest: sql<string>`${'0'.repeat(64)}`.as(
											'permission_policy_digest',
										),
										acknowledgedRevision: sql<number>`${0}`.as('acknowledged_revision'),
										acknowledgedAt: sql<null>`${null}`.as('acknowledged_at'),
										nextAttemptAt: sql<number>`${now}`.as('next_attempt_at'),
										createdAt: sql<number>`${now}`.as('created_at'),
										updatedAt: sql<number>`${now}`.as('updated_at'),
									})
									.from(organization)
									.where(inArray(organization.id, missing)),
							)
							.returning(),
						database
							.update(organizationFence)
							.set({
								revision: sql`${organizationFence.revision} + ${1}`,
								state: 'deleted',
								nextAttemptAt: now,
								updatedAt: now,
							})
							.where(
								inArray(
									organizationFence.id,
									database.select({ id: organization.id }).from(organization).where(predicate),
								),
							)
							.returning(),
						finalDelete,
					],
					async () => affectedOrganizations(model, predicate),
				)
			).length;
		},
	};
}
