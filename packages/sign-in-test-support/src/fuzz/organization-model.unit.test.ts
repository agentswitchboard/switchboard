import { expect, it } from 'vitest';

import { assertOrganizationInvariants } from '#sign-in-test-support/fuzz/organization-invariants';
import {
	applyOrganizationOperation,
	type OrganizationModel,
	type OrganizationOperation,
	type OrganizationReceipt,
} from '#sign-in-test-support/fuzz/organization-model';

const ownerId = '019a3dce-2000-7000-8000-000000000001';
const memberId = '019a3dce-2000-7000-8000-000000000002';
const outsiderId = '019a3dce-2000-7000-8000-000000000003';
const firstOrganization = '019a3dce-2000-7000-8000-000000000011';
const secondOrganization = '019a3dce-2000-7000-8000-000000000012';
const retainedOrganization = '019a3dce-2000-7000-8000-000000000013';
const ownerSession = '019a3dce-2000-7000-8000-000000000021';
const memberSession = '019a3dce-2000-7000-8000-000000000022';
const invitationId = '019a3dce-2000-7000-8000-000000000031';
const createdSession = '019a3dce-2000-7000-8000-000000000023';

function fixtureModel(): OrganizationModel {
	return {
		ownerPersonId: ownerId,
		now: 100,
		projection: {
			people: [
				{ id: ownerId, email: 'owner@example.invalid' },
				{ id: memberId, email: 'member@example.invalid' },
				{ id: outsiderId, email: 'outsider@example.invalid' },
			],
			organizations: [firstOrganization, secondOrganization, retainedOrganization].map((id) => ({
				id,
			})),
			memberships: [firstOrganization, secondOrganization, retainedOrganization].map(
				(organizationId) => ({ organizationId, personId: ownerId, role: 'owner' }),
			),
			invitations: [],
			sessions: [
				{
					id: ownerSession,
					personId: ownerId,
					organizationId: firstOrganization,
					expiresAt: 1_000,
				},
			],
			fences: [firstOrganization, secondOrganization, retainedOrganization].map(
				(organizationId) => ({ organizationId, personId: ownerId, revision: 1, state: 'active' }),
			),
		},
	};
}
function apply(
	model: OrganizationModel,
	operation: OrganizationOperation,
	created: OrganizationReceipt['created'] = { kind: 'none' },
): 'accepted' | 'refused' {
	return applyOrganizationOperation({ model, operation, created });
}
function addMemberFixture(model: OrganizationModel): void {
	for (const organizationId of [firstOrganization, secondOrganization])
		model.projection.memberships.push({ organizationId, personId: memberId, role: 'member' });
	model.projection.fences.push(
		{ organizationId: firstOrganization, personId: memberId, revision: 4, state: 'active' },
		{ organizationId: secondOrganization, personId: memberId, revision: 7, state: 'active' },
		{ organizationId: retainedOrganization, personId: memberId, revision: 9, state: 'inactive' },
	);
	model.projection.sessions.push({
		id: memberSession,
		personId: memberId,
		organizationId: firstOrganization,
		expiresAt: 1_000,
	});
}

it('models create, invite, session admission, accept, choice and terminal cancellation independently', (): void => {
	// Arrange
	const model = fixtureModel();
	const thirdOrganization = '019a3dce-2000-7000-8000-000000000014';
	// Act / Assert
	expect(
		apply(
			model,
			{ kind: 'create-organization', actorSessionId: ownerSession },
			{ kind: 'organization', id: thirdOrganization },
		),
	).toBe('accepted');
	expect(model.projection.sessions[0]?.organizationId).toBe(thirdOrganization);
	expect(apply(model, { kind: 'create-session', personId: outsiderId })).toBe('refused');
	expect(
		apply(
			model,
			{
				kind: 'invite',
				actorSessionId: ownerSession,
				organizationId: firstOrganization,
				personId: outsiderId,
			},
			{ kind: 'invitation', id: invitationId, expiresAt: 900 },
		),
	).toBe('accepted');
	expect(
		apply(
			model,
			{ kind: 'create-session', personId: outsiderId },
			{ kind: 'session', id: createdSession, expiresAt: 1_000 },
		),
	).toBe('accepted');
	expect(model.projection.sessions.at(-1)?.organizationId).toBeNull();
	expect(apply(model, { kind: 'accept', actorSessionId: ownerSession, invitationId })).toBe(
		'refused',
	);
	expect(apply(model, { kind: 'accept', actorSessionId: createdSession, invitationId })).toBe(
		'accepted',
	);
	expect(model.projection.invitations[0]?.state).toBe('accepted');
	expect(model.projection.sessions.at(-1)?.organizationId).toBe(firstOrganization);
	expect(
		apply(model, {
			kind: 'choose-organization',
			actorSessionId: createdSession,
			organizationId: secondOrganization,
		}),
	).toBe('refused');
	expect(apply(model, { kind: 'cancel', actorSessionId: ownerSession, invitationId })).toBe(
		'accepted',
	);
	expect(model.projection.invitations[0]?.state).toBe('canceled');
});

it('refuses owner removal and last-owner demotion without changing the model', (): void => {
	const model = fixtureModel();
	const before = structuredClone(model.projection);
	expect(
		apply(model, {
			kind: 'remove-member',
			actorSessionId: ownerSession,
			organizationId: firstOrganization,
			personId: ownerId,
		}),
	).toBe('refused');
	expect(
		apply(model, {
			kind: 'change-role',
			actorSessionId: ownerSession,
			organizationId: firstOrganization,
			personId: ownerId,
			role: 'member',
		}),
	).toBe('refused');
	expect(model.projection).toEqual(before);
});

it('bumps the exact role pair once for a change and never for an unchanged role', (): void => {
	const model = fixtureModel();
	addMemberFixture(model);
	const operation = {
		kind: 'change-role',
		actorSessionId: ownerSession,
		organizationId: firstOrganization,
		personId: memberId,
		role: 'owner',
	} as const;
	expect(apply(model, operation)).toBe('accepted');
	expect(apply(model, operation)).toBe('accepted');
	expect(
		model.projection.fences
			.filter((pair) => pair.personId === memberId)
			.map((pair) => pair.revision),
	).toEqual([5, 7, 9]);
});

it('retains and advances a removed pair on rejoin, clearing every choice for the removed membership', (): void => {
	const model = fixtureModel();
	addMemberFixture(model);
	expect(
		apply(model, {
			kind: 'remove-member',
			actorSessionId: ownerSession,
			organizationId: firstOrganization,
			personId: memberId,
		}),
	).toBe('accepted');
	expect(
		model.projection.sessions.find((current) => current.id === memberSession)?.organizationId,
	).toBeNull();
	expect(
		model.projection.fences.find(
			(pair) => pair.personId === memberId && pair.organizationId === firstOrganization,
		),
	).toMatchObject({ revision: 5, state: 'inactive' });
	apply(
		model,
		{
			kind: 'invite',
			actorSessionId: ownerSession,
			organizationId: firstOrganization,
			personId: memberId,
		},
		{ kind: 'invitation', id: invitationId, expiresAt: 900 },
	);
	expect(apply(model, { kind: 'accept', actorSessionId: memberSession, invitationId })).toBe(
		'accepted',
	);
	expect(
		model.projection.fences
			.filter((pair) => pair.personId === memberId)
			.map((pair) => ({ revision: pair.revision, state: pair.state })),
	).toEqual([
		{ revision: 6, state: 'active' },
		{ revision: 7, state: 'active' },
		{ revision: 9, state: 'inactive' },
	]);
});

it('expiration cleanup bumps all retained person pairs, including the inactive third organization', (): void => {
	const model = fixtureModel();
	addMemberFixture(model);
	expect(apply(model, { kind: 'expire-session', sessionId: memberSession })).toBe('accepted');
	expect(model.now).toBe(1_001);
	expect(model.projection.sessions.map((current) => current.id)).toEqual([ownerSession]);
	expect(
		model.projection.fences
			.filter((pair) => pair.personId === memberId)
			.map((pair) => pair.revision),
	).toEqual([5, 8, 10]);
});

it('an expired actor refusal cleans up its session and advances all retained pairs', (): void => {
	const model = fixtureModel();
	addMemberFixture(model);
	model.now = 1_001;
	expect(
		apply(model, {
			kind: 'choose-organization',
			actorSessionId: memberSession,
			organizationId: firstOrganization,
		}),
	).toBe('refused');
	expect(
		model.projection.fences
			.filter((pair) => pair.personId === memberId)
			.map((pair) => pair.revision),
	).toEqual([5, 8, 10]);
	expect(model.projection.sessions.some((current) => current.id === memberSession)).toBe(false);
});

it('person cleanup is conditional and bumps every retained pair only when the person is deleted', (): void => {
	const model = fixtureModel();
	addMemberFixture(model);
	const before = structuredClone(model.projection);
	apply(model, { kind: 'delete-person', personId: memberId });
	expect(model.projection).toEqual(before);
	apply(model, {
		kind: 'remove-member',
		actorSessionId: ownerSession,
		organizationId: firstOrganization,
		personId: memberId,
	});
	apply(model, {
		kind: 'remove-member',
		actorSessionId: ownerSession,
		organizationId: secondOrganization,
		personId: memberId,
	});
	apply(model, { kind: 'expire-session', sessionId: memberSession });
	apply(model, { kind: 'delete-person', personId: memberId });
	expect(model.projection.people.some((person) => person.id === memberId)).toBe(false);
	expect(
		model.projection.fences
			.filter((pair) => pair.personId === memberId)
			.map((pair) => ({ revision: pair.revision, state: pair.state })),
	).toEqual([
		{ revision: 7, state: 'inactive' },
		{ revision: 10, state: 'inactive' },
		{ revision: 11, state: 'inactive' },
	]);
});

it('names wrong owner, choice, removed-session, fence and invitation invariants rather than hiding them in a deep diff', (): void => {
	const model = fixtureModel();
	const previous = structuredClone(model.projection);
	model.projection.memberships = model.projection.memberships.filter(
		(membership) => membership.organizationId !== firstOrganization,
	);
	expect(() =>
		assertOrganizationInvariants({ projection: model.projection, previous, now: model.now }),
	).toThrow('R-owner');
	const choice = fixtureModel();
	choice.projection.sessions.push({
		id: memberSession,
		personId: memberId,
		organizationId: firstOrganization,
		expiresAt: 1_000,
	});
	expect(() =>
		assertOrganizationInvariants({ projection: choice.projection, previous, now: model.now }),
	).toThrow('R-choice');
	const removed = fixtureModel();
	addMemberFixture(removed);
	const removedPair = removed.projection.fences.find(
		(pair) => pair.personId === memberId && pair.organizationId === firstOrganization,
	);
	if (removedPair === undefined) throw new Error('Removed pair fixture absent');
	removedPair.state = 'inactive';
	expect(() =>
		assertOrganizationInvariants({ projection: removed.projection, previous, now: removed.now }),
	).toThrow('R-removed');
	const fence = fixtureModel();
	fence.projection.fences = [];
	expect(() =>
		assertOrganizationInvariants({ projection: fence.projection, previous, now: model.now }),
	).toThrow('R-fence');
	const invitations = fixtureModel();
	invitations.projection.invitations.push({
		id: invitationId,
		personId: memberId,
		organizationId: firstOrganization,
		state: 'accepted',
		expiresAt: 900,
	});
	const accepted = structuredClone(invitations.projection);
	const invitation = invitations.projection.invitations[0];
	if (invitation === undefined) throw new Error('Invitation fixture absent');
	invitation.state = 'pending';
	expect(() =>
		assertOrganizationInvariants({
			projection: invitations.projection,
			previous: accepted,
			now: model.now,
		}),
	).toThrow('R-invite');
});
