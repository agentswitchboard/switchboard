import {
	invitation,
	member,
	organization,
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
	session,
	fleetPermissionPolicyDigest,
} from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
	signInPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

function call(
	harness: Harness,
	body: Readonly<Record<string, unknown>>,
	cookie: string,
): Promise<Response> {
	return harness.auth('/__auth-proof/authorization-fence', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify(body),
	});
}
function native(
	harness: Harness,
	path: string,
	body: Readonly<Record<string, unknown>>,
	cookie: string,
): Promise<Response> {
	return call(harness, { kind: 'native', path, body }, cookie);
}
interface Fixture {
	readonly harness: Harness;
	readonly ownerId: string;
	readonly ownerCookie: string;
	readonly organizationId: string;
	readonly personId: string;
	readonly personCookie: string;
	readonly membershipId: string;
}
interface FenceSnapshot {
	readonly members: readonly (typeof member.$inferSelect)[];
	readonly sessions: readonly (typeof session.$inferSelect)[];
	readonly organizations: readonly (typeof organization.$inferSelect)[];
	readonly persons: readonly (typeof personFence.$inferSelect)[];
	readonly organizationsFences: readonly (typeof organizationFence.$inferSelect)[];
}
async function setup(): Promise<Fixture> {
	const harness = await startLocalAuthHarness();
	try {
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const ownerCookie = harness.cookie();
		const created = await native(
			harness,
			'organization/create',
			{ name: 'Atomic fence', slug: 'atomic-fence' },
			ownerCookie,
		);
		expect(created.status).toBe(200);
		const organizationId = z.object({ id: z.uuidv7() }).parse(await created.json()).id;
		const invitation = await native(
			harness,
			'organization/invite-member',
			{ organizationId, email: 'member@example.invalid', role: 'member' },
			ownerCookie,
		);
		expect(invitation.status).toBe(200);
		const personId = await signInPeopleBrowser({ harness, email: 'member@example.invalid' });
		const personCookie = harness.cookie();
		const added = await native(
			harness,
			'organization/add-member',
			{ organizationId, userId: personId, role: 'member' },
			ownerCookie,
		);
		expect(added.status).toBe(200);
		const membershipId = z.object({ id: z.uuidv7() }).parse(await added.json()).id;
		return { harness, ownerId, ownerCookie, organizationId, personId, personCookie, membershipId };
	} catch (error) {
		await harness.close();
		throw error;
	}
}
async function snapshot(harness: Harness): Promise<FenceSnapshot> {
	return {
		members: await harness.database.select().from(member).orderBy(member.id),
		sessions: await harness.database.select().from(session).orderBy(session.id),
		organizations: await harness.database.select().from(organization).orderBy(organization.id),
		persons: await harness.database.select().from(personFence).orderBy(personFence.id),
		organizationsFences: await harness.database
			.select()
			.from(organizationFence)
			.orderBy(organizationFence.id),
	};
}

it('authorization fence: native member add, role update, remove, rejoin and leave retain one subject and pending revisions', async () => {
	const fixture = await setup();
	const { harness, personId, organizationId, ownerCookie, personCookie, membershipId } = fixture;
	try {
		const pair = and(
			eq(personFence.personId, personId),
			eq(personFence.organizationId, organizationId),
		);
		const first = z
			.object({
				id: z.uuidv7(),
				revision: z.literal(1),
				state: z.literal('active'),
				acknowledgedRevision: z.literal(0),
			})
			.parse((await harness.database.select().from(personFence).where(pair))[0]);
		const unrelated = (await snapshot(harness)).persons.filter((row) => row.personId !== personId);
		expect(
			(
				await native(
					harness,
					'organization/update-member-role',
					{ organizationId, memberId: membershipId, role: 'admin' },
					ownerCookie,
				)
			).status,
		).toBe(200);
		expect(
			await harness.database
				.select({ role: member.role })
				.from(member)
				.where(eq(member.id, membershipId)),
		).toEqual([{ role: 'admin' }]);
		expect((await harness.database.select().from(personFence).where(pair))[0]).toMatchObject({
			id: first.id,
			revision: 2,
			state: 'active',
			acknowledgedRevision: 0,
		});
		expect(
			(
				await native(
					harness,
					'organization/remove-member',
					{ organizationId, memberIdOrEmail: membershipId },
					ownerCookie,
				)
			).status,
		).toBe(200);
		expect(await harness.database.select().from(member).where(eq(member.id, membershipId))).toEqual(
			[],
		);
		expect((await harness.database.select().from(personFence).where(pair))[0]).toMatchObject({
			id: first.id,
			revision: 3,
			state: 'inactive',
		});
		const rejoined = await native(
			harness,
			'organization/add-member',
			{ organizationId, userId: personId, role: 'member' },
			ownerCookie,
		);
		expect(rejoined.status).toBe(200);
		expect(z.object({ id: z.uuidv7() }).parse(await rejoined.json()).id).not.toBe(membershipId);
		expect((await harness.database.select().from(personFence).where(pair))[0]).toMatchObject({
			id: first.id,
			revision: 4,
			state: 'active',
		});
		expect(
			(await native(harness, 'organization/leave', { organizationId }, personCookie)).status,
		).toBe(200);
		expect(await harness.database.select().from(member).where(eq(member.userId, personId))).toEqual(
			[],
		);
		expect((await harness.database.select().from(personFence).where(pair))[0]).toMatchObject({
			id: first.id,
			revision: 5,
			state: 'inactive',
			acknowledgedRevision: 0,
		});
		expect((await snapshot(harness)).persons.filter((row) => row.personId !== personId)).toEqual(
			unrelated,
		);
	} finally {
		await harness.close();
	}
});

it('authorization fence: public bulk member delete and native organization delete retain inactive pairs and terminal org fences', async () => {
	const { harness, personId, organizationId, ownerCookie, ownerId } = await setup();
	try {
		const deleted = await call(
			harness,
			{
				kind: 'deleteMany',
				model: 'member',
				where: [
					{ field: 'organizationId', value: organizationId },
					{ field: 'userId', value: personId },
				],
			},
			ownerCookie,
		);
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ count: 1 });
		expect(
			(
				await harness.database.select().from(personFence).where(eq(personFence.personId, personId))
			)[0],
		).toMatchObject({ revision: 2, state: 'inactive' });
		const removed = await native(harness, 'organization/delete', { organizationId }, ownerCookie);
		expect(removed.status).toBe(200);
		expect(
			await harness.database.select().from(organization).where(eq(organization.id, organizationId)),
		).toEqual([]);
		expect(
			await harness.database.select().from(member).where(eq(member.organizationId, organizationId)),
		).toEqual([]);
		expect(
			(
				await harness.database.select().from(personFence).where(eq(personFence.personId, ownerId))
			)[0],
		).toMatchObject({ revision: 2, state: 'inactive' });
		expect(
			(
				await harness.database.select().from(personFence).where(eq(personFence.personId, personId))
			)[0],
		).toMatchObject({ revision: 2, state: 'inactive' });
		expect((await harness.database.select().from(organizationFence))[0]).toMatchObject({
			revision: 2,
			state: 'deleted',
			acknowledgedRevision: 0,
		});
	} finally {
		await harness.close();
	}
});

it('authorization fence: single and bulk native session deletion fan out across every retained pair without changing membership state', async () => {
	const { harness, ownerId, ownerCookie } = await setup();
	try {
		const second = await native(
			harness,
			'organization/create',
			{ name: 'Second', slug: 'second' },
			ownerCookie,
		);
		expect(second.status).toBe(200);
		const secondId = z.object({ id: z.uuidv7() }).parse(await second.json()).id;
		expect(
			(
				await call(
					harness,
					{
						kind: 'deleteMany',
						model: 'member',
						where: [{ field: 'organizationId', value: secondId }],
					},
					ownerCookie,
				)
			).status,
		).toBe(200);
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const before = await snapshot(harness);
		const selected = before.sessions.find((row) => row.userId === ownerId);
		if (selected === undefined) throw new Error('Native owner session missing');
		const retainedOrganization = before.organizationsFences.find((row) => row.id === secondId);
		if (retainedOrganization === undefined) throw new Error('Retained organization fence missing');
		await harness.database.delete(organizationFence).where(eq(organizationFence.id, secondId));
		const missingRetainedOrganization = await snapshot(harness);
		expect(
			(
				await call(
					harness,
					{ kind: 'delete', model: 'session', where: [{ field: 'id', value: selected.id }] },
					ownerCookie,
				)
			).status,
		).toBe(503);
		expect(await snapshot(harness)).toEqual(missingRetainedOrganization);
		// Restore the test fixture's exact row to exercise the successful path.
		await harness.database.insert(organizationFence).values(retainedOrganization);
		const single = await call(
			harness,
			{ kind: 'delete', model: 'session', where: [{ field: 'id', value: selected.id }] },
			ownerCookie,
		);
		expect(single.status).toBe(200);
		expect(
			await harness.database.select().from(session).where(eq(session.id, selected.id)),
		).toEqual([]);
		for (const row of (await snapshot(harness)).persons.filter(
			(entry) => entry.personId === ownerId,
		)) {
			expect(row).toMatchObject({
				revision: row.organizationId === secondId ? 3 : 2,
				state: row.organizationId === secondId ? 'inactive' : 'active',
			});
		}
		const bulk = await call(
			harness,
			{ kind: 'deleteMany', model: 'session', where: [{ field: 'userId', value: ownerId }] },
			ownerCookie,
		);
		expect(bulk.status).toBe(200);
		expect(await bulk.json()).toEqual({
			count: before.sessions.filter((row) => row.userId === ownerId).length - 1,
		});
		const after = await snapshot(harness);
		expect(after.sessions.filter((row) => row.userId === ownerId)).toEqual([]);
		for (const row of after.persons.filter((entry) => entry.personId === ownerId)) {
			expect(row).toMatchObject({
				revision: row.organizationId === secondId ? 4 : 3,
				state: row.organizationId === secondId ? 'inactive' : 'active',
			});
		}
		expect(after.members).toEqual(before.members);
		expect(after.organizationsFences.find((row) => row.id === secondId)?.revision).toBe(1);
	} finally {
		await harness.close();
	}
});

it('authorization fence: zero rows, equal roles and concurrent guarded role predicates produce no invented revisions', async () => {
	const { harness, membershipId, personId, ownerCookie } = await setup();
	try {
		const before = await snapshot(harness);
		await Promise.all(
			['member', 'session', 'organization'].map(async (model): Promise<void> => {
				const zero = await call(
					harness,
					{
						kind: 'deleteMany',
						model,
						where: [{ field: 'id', value: controlledSignInIds.nextId() }],
					},
					ownerCookie,
				);
				expect(zero.status).toBe(200);
				expect(await zero.json()).toEqual({ count: 0 });
			}),
		);
		expect(
			(
				await call(
					harness,
					{
						kind: 'update',
						model: 'member',
						where: [{ field: 'id', value: membershipId }],
						update: { role: 'member' },
					},
					ownerCookie,
				)
			).status,
		).toBe(200);
		expect(await snapshot(harness)).toEqual(before);
		const guarded = {
			kind: 'update',
			model: 'member',
			where: [
				{ field: 'id', value: membershipId },
				{ field: 'role', value: 'member' },
			],
			update: { role: 'admin' },
		};
		const firstKey = controlledSignInIds.nextId();
		const secondKey = controlledSignInIds.nextId();
		await Promise.all(
			[firstKey, secondKey].map(async (key): Promise<void> => {
				expect(
					(await harness.auth(`/__auth-proof/hold/arm?key=${key}`, { method: 'POST' })).status,
				).toBe(200);
			}),
		);
		const first = call(harness, { ...guarded, holdBeforeBatch: firstKey }, ownerCookie);
		const second = call(harness, { ...guarded, holdBeforeBatch: secondKey }, ownerCookie);
		await Promise.all(
			[firstKey, secondKey].map(async (key): Promise<void> => {
				const entered = await harness.auth(`/__auth-proof/hold/entered?key=${key}`);
				expect(await entered.json()).toEqual({ point: 'before-authorization-fence-batch' });
			}),
		);
		// Both fixed batches were built before either dispatches. Release in a
		// known order: the second must re-evaluate the native role predicate.
		expect(
			(await harness.auth(`/__auth-proof/hold/release?key=${firstKey}`, { method: 'POST' })).status,
		).toBe(200);
		const firstResponse = await first;
		expect(
			(await harness.auth(`/__auth-proof/hold/release?key=${secondKey}`, { method: 'POST' }))
				.status,
		).toBe(200);
		const raced = [firstResponse, await second];
		expect(raced.map((response) => response.status)).toEqual([200, 200]);
		const outcomes = await Promise.all(raced.map((response) => response.json()));
		expect(
			outcomes.filter((result) => z.object({ row: z.null() }).safeParse(result).success),
		).toHaveLength(1);
		expect(
			(
				await harness.database.select().from(personFence).where(eq(personFence.personId, personId))
			)[0],
		).toMatchObject({ revision: 2, state: 'active' });
		expect(
			(await harness.database.select().from(member).where(eq(member.id, membershipId)))[0],
		).toMatchObject({ role: 'admin' });
	} finally {
		await harness.close();
	}
});

it('authorization fence: missing retained rows and forced revision overflow roll back native rows and every other fence', async () => {
	const { harness, membershipId, personId, organizationId, ownerId, ownerCookie } = await setup();
	try {
		const valid = await snapshot(harness);
		// The fence UPSERT runs before the native INSERT. A duplicate native PK
		// must roll that already-executed fence change back too.
		expect(
			(
				await call(
					harness,
					{ kind: 'createMember', id: membershipId, organizationId, userId: personId },
					ownerCookie,
				)
			).status,
		).toBe(503);
		expect(await snapshot(harness)).toEqual(valid);
		await harness.database
			.delete(organizationFence)
			.where(eq(organizationFence.id, organizationId));
		const missingOrganization = await snapshot(harness);
		expect(
			(
				await call(
					harness,
					{
						kind: 'update',
						model: 'member',
						where: [{ field: 'id', value: membershipId }],
						update: { role: 'admin' },
					},
					ownerCookie,
				)
			).status,
		).toBe(503);
		expect(await snapshot(harness)).toEqual(missingOrganization);
		await harness.database.insert(organizationFence).values([...valid.organizationsFences]);
		await harness.database
			.update(personFence)
			.set({ revision: Number.MAX_SAFE_INTEGER })
			.where(eq(personFence.personId, personId));
		const saturated = await snapshot(harness);
		const overflow = await call(
			harness,
			{ kind: 'deleteMany', model: 'member', where: [] },
			ownerCookie,
		);
		expect(overflow.status).toBe(503);
		expect(await snapshot(harness)).toEqual(saturated);
		const sessionOverflow = await call(
			harness,
			{ kind: 'deleteMany', model: 'session', where: [{ field: 'userId', value: personId }] },
			ownerCookie,
		);
		expect(sessionOverflow.status).toBe(503);
		expect(await snapshot(harness)).toEqual(saturated);
		await harness.database.delete(personFence).where(eq(personFence.personId, personId));
		const missing = await snapshot(harness);
		const refused = await call(
			harness,
			{ kind: 'delete', model: 'member', where: [{ field: 'id', value: membershipId }] },
			ownerCookie,
		);
		expect(refused.status).toBe(503);
		expect(await snapshot(harness)).toEqual(missing);
		expect(
			(
				await call(
					harness,
					{
						kind: 'update',
						model: 'member',
						where: [{ field: 'id', value: membershipId }],
						update: { role: 'admin' },
					},
					ownerCookie,
				)
			).status,
		).toBe(503);
		expect(await snapshot(harness)).toEqual(missing);
		await harness.database
			.update(personFence)
			.set({ revision: Number.MAX_SAFE_INTEGER })
			.where(eq(personFence.personId, ownerId));
		const beforeSignOut = await snapshot(harness);
		// Native sign-out catches deletion errors. Cookie/HTTP success is not a
		// committed session deletion; the original native row must survive.
		expect((await native(harness, 'sign-out', {}, ownerCookie)).status).toBe(200);
		expect(await snapshot(harness)).toEqual(beforeSignOut);
	} finally {
		await harness.close();
	}
});

interface PopulatedFixture {
	readonly harness: Harness;
	readonly ownerId: string;
	readonly personId: string;
	readonly personCookie: string;
	readonly organizationId: string;
	readonly personMembershipId: string;
}

/** A store populated before the fence tables existed: raw native rows, no fences. */
async function populatedSetup(): Promise<PopulatedFixture> {
	const harness = await startLocalAuthHarness();
	try {
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = controlledSignInIds.nextId();
		const personMembershipId = controlledSignInIds.nextId();
		await harness.database.insert(organization).values({
			id: organizationId,
			name: 'Populated before fences',
			slug: 'populated-before-fences',
			createdAt: new Date(controlledSignInClock.now()),
			fleetState: 'ready',
		});
		// A pending invitation is what admits the member's first sign-in.
		await harness.database.insert(invitation).values({
			id: controlledSignInIds.nextId(),
			organizationId,
			email: 'member@example.invalid',
			role: 'member',
			status: 'pending',
			expiresAt: new Date(controlledSignInClock.now() + 86_400_000),
			createdAt: new Date(controlledSignInClock.now()),
			inviterId: ownerId,
		});
		const personId = await signInPeopleBrowser({ harness, email: 'member@example.invalid' });
		const personCookie = harness.cookie();
		await harness.database.insert(member).values([
			{
				id: controlledSignInIds.nextId(),
				organizationId,
				userId: ownerId,
				role: 'owner',
				createdAt: new Date(controlledSignInClock.now()),
			},
			{
				id: personMembershipId,
				organizationId,
				userId: personId,
				role: 'member',
				createdAt: new Date(controlledSignInClock.now()),
			},
		]);
		return { harness, ownerId, personId, personCookie, organizationId, personMembershipId };
	} catch (error) {
		await harness.close();
		throw error;
	}
}

const backfillResultSchema = z.object({
	kind: z.literal('available'),
	value: z.object({
		organizationFencesAdded: z.number(),
		personPairsAdded: z.number(),
	}),
});

it('authorization backfill: rows that predate the fence tables are backfilled for their own organization on first use; sign-out and member removal then move exactly their fences', async () => {
	// Arrange: every native row predates the fence tables.
	const { harness, ownerId, personId, personCookie, organizationId, personMembershipId } =
		await populatedSetup();
	try {
		const unfenced = await snapshot(harness);
		expect(unfenced.persons.filter((row) => row.organizationId === organizationId)).toEqual([]);
		expect(unfenced.organizationsFences.filter((row) => row.id === organizationId)).toEqual([]);
		// Act: native sign-out meets the missing fences; WS3 recovery backfills this wholly
		// unfenced organization (insert-or-ignore) and retries the same batch once.
		expect((await native(harness, 'sign-out', {}, personCookie)).status).toBe(200);
		const fenced = await snapshot(harness);
		const pairsOf = (rows: FenceSnapshot['persons']): FenceSnapshot['persons'] =>
			rows.filter((row) => row.organizationId === organizationId);
		expect(fenced.organizationsFences.filter((row) => row.id === organizationId)).toEqual([
			expect.objectContaining({
				id: organizationId,
				revision: 1,
				state: 'active',
				permissionPolicyDigest: fleetPermissionPolicyDigest,
				acknowledgedRevision: 0,
			}),
		]);
		expect(
			pairsOf(fenced.persons).map(
				({ personId: person, revision, state, acknowledgedRevision }) => ({
					person,
					revision,
					state,
					acknowledgedRevision,
				}),
			),
		).toEqual(
			expect.arrayContaining([
				{ person: ownerId, revision: 1, state: 'active', acknowledgedRevision: 0 },
				// Backfilled at revision 1, then bumped by the retried sign-out batch itself.
				{ person: personId, revision: 2, state: 'active', acknowledgedRevision: 0 },
			]),
		);
		for (const row of pairsOf(fenced.persons))
			expect(z.uuidv7().safeParse(row.id).success).toBe(true);
		// Assert: the sign-out committed with its coupled bump, and removal now commits too.
		const signedOut = fenced;
		expect(signedOut.sessions.filter((row) => row.userId === personId)).toEqual([]);
		expect(pairsOf(signedOut.persons).find((row) => row.personId === personId)).toMatchObject({
			revision: 2,
			state: 'active',
		});
		expect(
			(
				await call(
					harness,
					{ kind: 'delete', model: 'member', where: [{ field: 'id', value: personMembershipId }] },
					personCookie,
				)
			).status,
		).toBe(200);
		const removed = await snapshot(harness);
		expect(removed.members.some((row) => row.id === personMembershipId)).toBe(false);
		expect(pairsOf(removed.persons).find((row) => row.personId === personId)).toMatchObject({
			revision: 3,
			state: 'inactive',
		});
		expect(pairsOf(removed.persons).find((row) => row.personId === ownerId)).toMatchObject({
			revision: 1,
			state: 'active',
		});
	} finally {
		await harness.close();
	}
});

it('authorization backfill: a rerun adds nothing and never resets an advanced, inactive, stopped or deleted fence', async () => {
	const { harness, personId, personCookie, organizationId } = await populatedSetup();
	try {
		// Arrange: backfill, then advance the fences past their initial values.
		backfillResultSchema.parse(
			await (await call(harness, { kind: 'backfill' }, personCookie)).json(),
		);
		await harness.database
			.update(personFence)
			.set({ revision: 7, state: 'inactive', acknowledgedRevision: 5 })
			.where(eq(personFence.personId, personId));
		await harness.database
			.update(organizationFence)
			.set({ revision: 4, state: 'stopped', acknowledgedRevision: 3 })
			.where(eq(organizationFence.id, organizationId));
		// A second organization whose fence is terminal must not be revived either.
		const deletedOrganizationId = controlledSignInIds.nextId();
		await harness.database.insert(organization).values({
			id: deletedOrganizationId,
			name: 'Deleted fence',
			slug: 'deleted-fence',
			createdAt: new Date(controlledSignInClock.now()),
			fleetState: 'ready',
		});
		await harness.database.insert(organizationFence).values({
			id: deletedOrganizationId,
			revision: 2,
			state: 'deleted',
			permissionPolicyDigest: fleetPermissionPolicyDigest,
			acknowledgedRevision: 1,
			nextAttemptAt: 0,
			createdAt: 0,
			updatedAt: 0,
		});
		const advanced = await snapshot(harness);
		// Act
		const rerun = backfillResultSchema.parse(
			await (await call(harness, { kind: 'backfill' }, personCookie)).json(),
		);
		// Assert
		expect(rerun.value).toEqual({ organizationFencesAdded: 0, personPairsAdded: 0 });
		expect(await snapshot(harness)).toEqual(advanced);
	} finally {
		await harness.close();
	}
});

it('authorization backfill: two runs held after reading the same candidates converge on one row per pair', async () => {
	const { harness, personCookie, organizationId } = await populatedSetup();
	try {
		// Arrange: both runs read their candidates, then wait before their batch.
		const keys = [controlledSignInIds.nextId(), controlledSignInIds.nextId()] as const;
		for (const key of keys)
			expect(
				(await harness.auth(`/__auth-proof/hold/arm?key=${key}`, { method: 'POST' })).status,
			).toBe(200);
		const [firstRun, secondRun] = [
			call(harness, { kind: 'backfill', holdBeforeBatch: keys[0] }, personCookie),
			call(harness, { kind: 'backfill', holdBeforeBatch: keys[1] }, personCookie),
		];
		for (const key of keys) {
			const entered = await harness.auth(`/__auth-proof/hold/entered?key=${key}`);
			expect(await entered.json()).toEqual({ point: 'before-authorization-fence-batch' });
		}
		// Act: release in a known order.
		expect(
			(await harness.auth(`/__auth-proof/hold/release?key=${keys[0]}`, { method: 'POST' })).status,
		).toBe(200);
		const first = backfillResultSchema.parse(await (await firstRun).json());
		expect(
			(await harness.auth(`/__auth-proof/hold/release?key=${keys[1]}`, { method: 'POST' })).status,
		).toBe(200);
		const second = backfillResultSchema.parse(await (await secondRun).json());
		// Assert: the first run's injected IDs win; the second run's are discarded.
		expect(first.value).toEqual({ organizationFencesAdded: 1, personPairsAdded: 2 });
		expect(second.value).toEqual({ organizationFencesAdded: 0, personPairsAdded: 0 });
		const after = await snapshot(harness);
		const pairs = after.persons.filter((row) => row.organizationId === organizationId);
		expect(pairs).toHaveLength(2);
		expect(new Set(pairs.map((row) => row.personId)).size).toBe(2);
		expect(after.organizationsFences.filter((row) => row.id === organizationId)).toHaveLength(1);
	} finally {
		await harness.close();
	}
});

it('authorization fence: the production organization routes create and move fences in the batches that write the native rows', async () => {
	// Arrange: the delivered owner flow, served by the production provider and its adapter.
	const harness = await startLocalAuthHarness();
	try {
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const ownerCookie = harness.cookie();
		const pairOf = async (personId: string): Promise<unknown> =>
			(
				await harness.database
					.select({ revision: personFence.revision, state: personFence.state })
					.from(personFence)
					.where(
						and(eq(personFence.organizationId, organizationId), eq(personFence.personId, personId)),
					)
			)[0];
		// Assert: creation wrote the org fence and the creator's pair with the native rows.
		expect(
			(
				await harness.database
					.select()
					.from(organizationFence)
					.where(eq(organizationFence.id, organizationId))
			)[0],
		).toMatchObject({
			// Its ACK is the drain's (slice 4's cases): a hinted drain may already have run.
			revision: 1,
			state: 'active',
			permissionPolicyDigest: fleetPermissionPolicyDigest,
		});
		expect(await pairOf(ownerId)).toEqual({ revision: 1, state: 'active' });
		// Act: invite and accept through the production routes.
		const invited = await peoplePost(harness, 'invite-member', {
			organizationId,
			email: 'member@example.invalid',
			role: 'member',
		});
		expect(invited.status).toBe(200);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		const memberId = await signInConfirmedPeopleBrowser({
			harness,
			email: 'member@example.invalid',
		});
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		expect(await pairOf(memberId)).toEqual({ revision: 1, state: 'active' });
		await signInConfirmedPeopleBrowser({ harness, email: 'member@example.invalid' });
		const memberSessions = async (): Promise<
			readonly { id: string; activeOrganizationId: string | null }[]
		> =>
			harness.database
				.select({ id: session.id, activeOrganizationId: session.activeOrganizationId })
				.from(session)
				.where(eq(session.userId, memberId))
				.orderBy(session.id);
		const selected = await memberSessions();
		expect(selected).toHaveLength(2);
		expect(selected.map((row) => row.activeOrganizationId)).toEqual([
			organizationId,
			organizationId,
		]);
		const ownerSessionChoices = async (): Promise<
			readonly { activeOrganizationId: string | null }[]
		> =>
			harness.database
				.select({ activeOrganizationId: session.activeOrganizationId })
				.from(session)
				.where(eq(session.userId, ownerId))
				.orderBy(session.id);
		const ownerChoices = await ownerSessionChoices();

		// Act: the owner removes the member through the production route.
		expect(
			(
				await peoplePost(
					harness,
					'remove-member',
					{ organizationId, memberIdOrEmail: 'member@example.invalid' },
					ownerCookie,
				)
			).status,
		).toBe(200);
		// Assert: the removed pair is retained, bumped and inactive; the owner's pair is untouched.
		expect(await pairOf(memberId)).toEqual({ revision: 2, state: 'inactive' });
		expect(await pairOf(ownerId)).toEqual({ revision: 1, state: 'active' });
		expect(await memberSessions()).toEqual(
			selected.map(({ id }) => ({ id, activeOrganizationId: null })),
		);
		expect(await ownerSessionChoices()).toEqual(ownerChoices);
	} finally {
		await harness.close();
	}
});

// Cloudflare's deploy step is a server-only management method (Lead, 8 Nov); the Node host's
// equivalent is its startup caller, proven in sign-in-node-host.integration.test.ts.
it.runIf((process.env.SIGN_IN_TEST_HOST ?? 'cloudflare') === 'cloudflare')(
	'authorization backfill: the workerd deploy step is a server-only management method and idempotent',
	async () => {
		const { harness, organizationId } = await populatedSetup();
		try {
			const binding = (
				await harness.miniflare.getBindings<{
					readonly SIGN_IN: { readonly backfillAuthorizationRevisions: () => Promise<unknown> };
				}>('gateway-one')
			).SIGN_IN;
			// Act: the deploy step twice.
			const first = backfillResultSchema.parse(await binding.backfillAuthorizationRevisions());
			const afterFirst = await snapshot(harness);
			const second = backfillResultSchema.parse(await binding.backfillAuthorizationRevisions());
			// Assert
			expect(first.value).toEqual({ organizationFencesAdded: 1, personPairsAdded: 2 });
			expect(second.value).toEqual({ organizationFencesAdded: 0, personPairsAdded: 0 });
			expect(
				afterFirst.persons.filter((row) => row.organizationId === organizationId),
			).toHaveLength(2);
			const afterSecond = await snapshot(harness);
			expect(afterSecond.persons).toEqual(afterFirst.persons);
			expect(afterSecond.organizationsFences).toEqual(afterFirst.organizationsFences);
			// No public path reaches it.
			const publicStatuses = await Promise.all(
				[
					'/backfillAuthorizationRevisions',
					'/api/auth/backfillAuthorizationRevisions',
					'/api/auth/backfill-authorization-revisions',
					'/rpc/backfillAuthorizationRevisions',
				].map(
					async (pathname): Promise<number> =>
						(
							await harness.auth(pathname, {
								method: 'POST',
								headers: { 'content-type': 'application/json' },
								body: '{}',
							})
						).status,
				),
			);
			expect(publicStatuses).toEqual([404, 404, 404, 404]);
		} finally {
			await harness.close();
		}
	},
);
