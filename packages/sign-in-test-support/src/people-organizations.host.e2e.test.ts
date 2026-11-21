import {
	account,
	invitation,
	member,
	organization,
	session,
	signInAudit,
	user,
} from '@agent-collaboration/sign-in-core';
import { getSessionCookie } from 'better-auth/cookies';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { readCaptchaState } from '#sign-in-test-support/test-fixtures/captcha-state-readback';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
	signInPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

async function peopleRecords(harness: Harness): Promise<readonly unknown[]> {
	return harness.database
		.select()
		.from(signInAudit)
		.where(eq(signInAudit.kind, 'organization-people-changed'))
		.orderBy(signInAudit.at, signInAudit.id);
}

it.each(['google', 'github'] as const)(
	'people: %s sign-in precedes first native organization creation and the caller cannot set fleetState',
	async (provider) => {
		const harness = await startLocalAuthHarness();
		try {
			expect(await harness.database.select().from(organization)).toEqual([]);
			const ownerId = await signInConfirmedPeopleBrowser({
				harness,
				email: 'owner@example.invalid',
				provider,
			});
			expect(await harness.database.select().from(organization)).toEqual([]);
			expect(await harness.database.select().from(member)).toEqual([]);
			const page = await harness.auth('/owner-ready');
			expect(page.status).toBe(200);
			expect(await page.text()).toContain('/api/auth/organization/create');
			const created = await peoplePost(harness, 'create', {
				name: 'Owner organization',
				slug: 'owner',
				fleetState: 'ready',
			});
			expect(created.status).toBe(200);
			const createdOrganization = z.object({ id: z.uuidv7() }).parse(await created.json());
			expect(
				await harness.database
					.select({ id: organization.id, fleetState: organization.fleetState })
					.from(organization),
			).toEqual([{ id: createdOrganization.id, fleetState: 'settingUp' }]);
			expect(
				await harness.database
					.select({
						organizationId: member.organizationId,
						userId: member.userId,
						role: member.role,
					})
					.from(member),
			).toEqual([{ organizationId: createdOrganization.id, userId: ownerId, role: 'owner' }]);
			expect(
				await harness.database
					.select({ activeOrganizationId: session.activeOrganizationId })
					.from(session)
					.where(eq(session.userId, ownerId)),
			).toEqual([{ activeOrganizationId: createdOrganization.id }]);
		} finally {
			await harness.close();
		}
	},
);

it('people: native invite, accept, cancel and remove write matching records with the authenticated actor', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const ownerCookie = harness.cookie();
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
		const accepted = await peoplePost(harness, 'accept-invitation', { invitationId });
		expect(accepted.status).toBe(200);
		const acceptance = await accepted.json();
		expect(acceptance).toMatchObject({
			invitation: { id: invitationId, organizationId, status: 'accepted' },
			member: { userId: memberId, organizationId, role: 'member' },
		});
		expect(acceptance).not.toHaveProperty('invitation.inviterId');
		expect(
			await harness.database
				.select({ role: member.role })
				.from(member)
				.where(and(eq(member.userId, memberId), eq(member.organizationId, organizationId))),
		).toEqual([{ role: 'member' }]);
		const pending = await peoplePost(
			harness,
			'invite-member',
			{ organizationId, email: 'pending@example.invalid', role: 'member' },
			ownerCookie,
		);
		expect(pending.status).toBe(200);
		const pendingId = z.object({ id: z.uuidv7() }).parse(await pending.json()).id;
		expect(
			(await peoplePost(harness, 'cancel-invitation', { invitationId: pendingId }, ownerCookie))
				.status,
		).toBe(200);
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
		expect(await harness.database.select().from(member).where(eq(member.userId, memberId))).toEqual(
			[],
		);
		const records = z
			.array(
				z.object({
					id: z.string(),
					requestId: z.uuidv7(),
					organizationId: z.literal(organizationId),
					actorUserId: z.string(),
					phase: z.enum(['intent', 'outcome']),
					changeKind: z.enum([
						'invited',
						'invitation-accepted',
						'invitation-cancelled',
						'member-removed',
					]),
					targetId: z.string(),
				}),
			)
			.parse(await peopleRecords(harness));
		expect(records).toHaveLength(10);
		const expected = [
			{ changeKind: 'invited', actorUserId: ownerId, targetId: 'member@example.invalid' },
			{ changeKind: 'invitation-accepted', actorUserId: memberId, targetId: invitationId },
			{ changeKind: 'invited', actorUserId: ownerId, targetId: 'pending@example.invalid' },
			{ changeKind: 'invitation-cancelled', actorUserId: ownerId, targetId: pendingId },
			{ changeKind: 'member-removed', actorUserId: ownerId, targetId: memberId },
		];
		for (const effect of expected) {
			const pair = records.filter(
				(record) => record.changeKind === effect.changeKind && record.targetId === effect.targetId,
			);
			expect(pair.map((record) => record.phase).toSorted()).toEqual(['intent', 'outcome']);
			expect(new Set(pair.map((record) => record.requestId)).size).toBe(1);
			for (const record of pair) {
				expect(record.actorUserId).toBe(effect.actorUserId);
				expect(record.id).toBe(`${record.requestId}:${record.changeKind}:${record.phase}`);
			}
		}
		expect(
			await harness.database
				.select({ status: invitation.status })
				.from(invitation)
				.where(eq(invitation.id, pendingId)),
		).toEqual([{ status: 'canceled' }]);
	} finally {
		await harness.close();
	}
});

it('people: an authenticated owner cannot invite another owner and no invitation or intent is written', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const before = await peopleRecords(harness);
		const response = await peoplePost(harness, 'invite-member', {
			organizationId,
			email: 'owner-target@example.invalid',
			role: 'owner',
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ message: 'owner-invitation-not-allowed' });
		expect(
			await harness.database
				.select({ id: invitation.id })
				.from(invitation)
				.where(eq(invitation.email, 'owner-target@example.invalid')),
		).toEqual([]);
		expect(await peopleRecords(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('people: a fresh social session selects the persons one existing membership without native create or set-active', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInConfirmedPeopleBrowser({
			harness,
			email: 'owner@example.invalid',
		});
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const before = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		// A new social callback has neither the old browser cookie nor a native
		// create/set-active call to select the organization on this new session.
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const after = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect(after.id).not.toBe(before.id);
		expect(after.personId).toBe(personId);
		expect(after.secondFactorAt).toBeNull();
		expect(
			await harness.database
				.select({ activeOrganizationId: session.activeOrganizationId })
				.from(session)
				.where(eq(session.id, after.id)),
		).toEqual([{ activeOrganizationId: organizationId }]);
	} finally {
		await harness.close();
	}
});

it.each(['google', 'github'] as const)(
	'people: an unverified %s email for the configured owner gets no identity, session or organization and one failed sign-in record',
	async (provider) => {
		const harness = await startLocalAuthHarness();
		try {
			// Establish real JWKS fetch/import readiness without admitting a Person.
			expect((await harness.auth('/api/auth/jwks')).status).toBe(200);
			const started = await harness.auth('/api/auth/sign-in/social', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-captcha-response': harness.turnstile.issueToken({
						action: 'sign_in_social',
						hostname: new URL(harness.issuer).hostname,
						verdict: 'accepted',
					}),
				},
				body: JSON.stringify({
					provider,
					callbackURL: new URL('/owner-ready', harness.issuer).toString(),
				}),
			});
			expect(started.status).toBe(200);
			const providerUrl = z.object({ url: z.url() }).parse(await started.json()).url;
			const callback = harness.providerCallback(
				provider,
				new URL(providerUrl),
				'owner@example.invalid',
				false,
			);
			const refused = await harness.auth(callback.toString(), {
				headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' },
			});
			expect(refused.status).toBe(302);
			expect(new URL(refused.headers.get('location') ?? 'invalid:').searchParams.has('error')).toBe(
				true,
			);
			const callbackCookie = refused.headers
				.getSetCookie()
				.map((value) => value.split(';')[0])
				.join('; ');
			expect(getSessionCookie(new Headers({ cookie: callbackCookie }))).toBeNull();
			expect(getSessionCookie(new Headers({ cookie: harness.cookie() }))).toBeNull();
			const rows = await Promise.all([
				harness.database.select({ id: user.id }).from(user),
				harness.database.select({ id: account.id }).from(account),
				harness.database.select({ id: session.id }).from(session),
				harness.database.select({ id: organization.id }).from(organization),
				harness.database.select({ id: member.id }).from(member),
				harness.database.select({ id: invitation.id }).from(invitation),
			]);
			expect(rows).toEqual([[], [], [], [], [], []]);
			// The failed callback remains attributable without creating a person or
			// a people/identity change record.
			expect(
				await harness.database
					.select({
						kind: signInAudit.kind,
						actor: signInAudit.actorUserId,
						change: signInAudit.changeKind,
						target: signInAudit.targetId,
						phase: signInAudit.phase,
						organizationId: signInAudit.organizationId,
					})
					.from(signInAudit),
			).toEqual([
				{
					kind: 'sign-in',
					actor: 'anonymous',
					change: 'failed',
					target: provider,
					phase: 'outcome',
					organizationId: null,
				},
			]);
		} finally {
			await harness.close();
		}
	},
);

it('people: member permissions, owner removal and unoffered routes refuse without changing authority', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const ownerCookie = harness.cookie();
		const pending = await peoplePost(harness, 'invite-member', {
			organizationId,
			email: 'member@example.invalid',
			role: 'member',
		});
		const invitationId = z.object({ id: z.uuidv7() }).parse(await pending.json()).id;
		const memberId = await signInConfirmedPeopleBrowser({
			harness,
			email: 'member@example.invalid',
		});
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		async function snapshot(): Promise<unknown> {
			return {
				organizations: await harness.database.select().from(organization),
				members: await harness.database.select().from(member),
				invitations: await harness.database.select().from(invitation),
				audit: await peopleRecords(harness),
			};
		}
		const beforeMember = await snapshot();
		expect(
			(
				await peoplePost(harness, 'invite-member', {
					organizationId,
					email: 'forbidden@example.invalid',
					role: 'member',
				})
			).status,
		).toBe(403);
		expect(
			(await peoplePost(harness, 'create', { name: 'Forbidden', slug: 'forbidden' })).status,
		).toBe(403);
		expect(await snapshot()).toEqual(beforeMember);
		// Even a native owner who is not the config-named creator cannot create an organization.
		await harness.database.update(member).set({ role: 'owner' }).where(eq(member.userId, memberId));
		const beforeOtherOwner = await snapshot();
		expect(
			(await peoplePost(harness, 'create', { name: 'Forbidden owner', slug: 'forbidden-owner' }))
				.status,
		).toBe(403);
		expect(await snapshot()).toEqual(beforeOtherOwner);
		const removal = await Promise.all([
			peoplePost(
				harness,
				'remove-member',
				{ organizationId, memberIdOrEmail: 'owner@example.invalid' },
				ownerCookie,
			),
			peoplePost(
				harness,
				'remove-member',
				{ organizationId, memberIdOrEmail: 'owner@example.invalid' },
				ownerCookie,
			),
		]);
		expect(removal.map((response) => response.status)).toEqual([403, 403]);
		expect(await snapshot()).toEqual(beforeOtherOwner);
		const unoffered = await Promise.all(
			[
				'leave',
				'update-member-role',
				'delete',
				'list',
				'get-full-organization',
				'has-permission',
				'add-member',
				'reject-invitation',
			].map((route) =>
				peoplePost(harness, route, { organizationId, userId: memberId }, ownerCookie),
			),
		);
		expect(unoffered.map((response) => response.status)).toEqual([
			404, 404, 404, 404, 404, 404, 404, 404,
		]);
		expect(await snapshot()).toEqual(beforeOtherOwner);
	} finally {
		await harness.close();
	}
});

it('people: native last-owner protection refuses a single-owner removal before the production hook', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const before = await harness.database.select().from(member);
		expect(before).toHaveLength(1);
		const response = await peoplePost(harness, 'remove-member', {
			organizationId,
			memberIdOrEmail: 'owner@example.invalid',
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: 'YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER',
		});
		expect(await harness.database.select().from(member)).toEqual(before);
		expect(await peopleRecords(harness)).toEqual([]);
	} finally {
		await harness.close();
	}
});

it('people: the session selects its only organization and leaves multiple memberships unselected until native set-active', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const firstOrganizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const second = await peoplePost(harness, 'create', {
			name: 'Second organization',
			slug: 'second',
		});
		expect(second.status).toBe(200);
		const secondOrganizationId = z.object({ id: z.uuidv7() }).parse(await second.json()).id;
		expect(secondOrganizationId).not.toBe(firstOrganizationId);
		await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const current = await harness.database
			.select({ id: session.id, activeOrganizationId: session.activeOrganizationId })
			.from(session)
			.where(eq(session.userId, ownerId));
		expect(current).toHaveLength(2);
		const unselected = current.filter((row) => row.activeOrganizationId === null);
		expect(unselected).toHaveLength(1);
		const unselectedSession = unselected[0];
		if (unselectedSession === undefined) throw new Error('New native session absent');
		expect(
			(await peoplePost(harness, 'set-active', { organizationId: firstOrganizationId })).status,
		).toBe(200);
		expect(
			await harness.database
				.select({ activeOrganizationId: session.activeOrganizationId })
				.from(session)
				.where(eq(session.id, unselectedSession.id)),
		).toEqual([{ activeOrganizationId: firstOrganizationId }]);
	} finally {
		await harness.close();
	}
});

it.each([
	'create',
	'invite-member',
	'cancel-invitation',
	'accept-invitation',
	'remove-member',
	'set-active',
] as const)(
	'people: %s refuses without a valid session and preserves all identity and organization rows',
	async (route) => {
		const harness = await startLocalAuthHarness();
		try {
			const ownerId = await signInConfirmedPeopleBrowser({
				harness,
				email: 'owner@example.invalid',
			});
			const organizationId = await ensureLocalOwnerOrganization({
				auth: harness.auth,
				database: harness.database,
			});
			const pending = await peoplePost(harness, 'invite-member', {
				organizationId,
				email: 'pending@example.invalid',
				role: 'member',
			});
			expect(pending.status).toBe(200);
			const invitationId = z.object({ id: z.uuidv7() }).parse(await pending.json()).id;
			const before = await readCaptchaState(harness);
			const body =
				route === 'create'
					? { name: 'Refused organization', slug: 'signed-out' }
					: route === 'invite-member'
						? { organizationId, email: 'refused@example.invalid', role: 'member' }
						: route === 'cancel-invitation' || route === 'accept-invitation'
							? { invitationId }
							: route === 'remove-member'
								? { organizationId, memberIdOrEmail: 'owner@example.invalid' }
								: { organizationId };
			expect((await peoplePost(harness, route, body, '')).status).toBe(401);
			expect(await readCaptchaState(harness)).toEqual(before);
			expect(
				await harness.database
					.select({ userId: member.userId })
					.from(member)
					.where(eq(member.role, 'owner')),
			).toEqual([{ userId: ownerId }]);
		} finally {
			await harness.close();
		}
	},
);
