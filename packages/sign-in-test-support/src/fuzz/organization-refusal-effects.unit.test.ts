import { expect, it } from 'vitest';

import { assertOrganizationRefusalEffects } from '#sign-in-test-support/fuzz/organization-refusal-effects';
import type { RequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';

const sessionId = '019a3dce-2000-7000-8000-000000000001';
const personId = '019a3dce-2000-7000-8000-000000000002';
const firstOrganization = '019a3dce-2000-7000-8000-000000000011';
const secondOrganization = '019a3dce-2000-7000-8000-000000000012';
const operation = {
	kind: 'choose-organization',
	actorSessionId: sessionId,
	organizationId: firstOrganization,
} as const;

function fixtureSnapshot(): RequestStorageSnapshot {
	return {
		session: [
			{ id: sessionId, userId: personId, expiresAt: 100, activeOrganizationId: firstOrganization },
		],
		member: [{ organizationId: firstOrganization, userId: personId }],
		personOrganizationAuthorizationRevisions: [
			{
				organization_id: firstOrganization,
				person_id: personId,
				revision: 3,
				state: 'active',
				next_attempt_at: 50,
				updated_at: 50,
			},
			{
				organization_id: secondOrganization,
				person_id: personId,
				revision: 7,
				state: 'inactive',
				next_attempt_at: 50,
				updated_at: 50,
			},
		],
		account: [{ id: 'unrelated-account', providerId: 'google' }],
	};
}

it('permits exactly the expired actor session deletion and all retained pair bumps, including inactive pairs', (): void => {
	const before = fixtureSnapshot();
	const after = {
		...before,
		session: [],
		personOrganizationAuthorizationRevisions: [
			{
				organization_id: firstOrganization,
				person_id: personId,
				revision: 4,
				state: 'active',
				next_attempt_at: 101,
				updated_at: 101,
			},
			{
				organization_id: secondOrganization,
				person_id: personId,
				revision: 8,
				state: 'inactive',
				next_attempt_at: 101,
				updated_at: 101,
			},
		],
	};
	expect(() =>
		assertOrganizationRefusalEffects({ operation, before, after, now: 101 }),
	).not.toThrow();
	expect(() =>
		assertOrganizationRefusalEffects({
			operation,
			before,
			after: { ...after, account: [] },
			now: 101,
		}),
	).toThrow('unauthorized stored transition in account');
	expect(() =>
		assertOrganizationRefusalEffects({
			operation,
			before,
			after: {
				...after,
				personOrganizationAuthorizationRevisions:
					before.personOrganizationAuthorizationRevisions ?? [],
			},
			now: 101,
		}),
	).toThrow('personOrganizationAuthorizationRevisions');
});

it('a refusal with a live session cannot delete it or mutate any stored row', (): void => {
	const before = fixtureSnapshot();
	expect(() =>
		assertOrganizationRefusalEffects({ operation, before, after: before, now: 99 }),
	).not.toThrow();
	expect(() =>
		assertOrganizationRefusalEffects({
			operation,
			before,
			after: { ...before, session: [] },
			now: 99,
		}),
	).toThrow('unauthorized stored transition in session');
});

it('a refused session creation cannot use expiry cleanup as permission to delete another session', (): void => {
	const before = fixtureSnapshot();
	expect(() =>
		assertOrganizationRefusalEffects({
			operation: { kind: 'create-session', personId },
			before,
			after: { ...before, session: [] },
			now: 101,
		}),
	).toThrow('unauthorized stored transition in session');
});

it('permits native set-active nonmembership refusal to clear only its own previous choice', (): void => {
	const before = fixtureSnapshot();
	const chooseNonmembership = {
		kind: 'choose-organization',
		actorSessionId: sessionId,
		organizationId: secondOrganization,
	} as const;
	const after = {
		...before,
		session: [{ id: sessionId, userId: personId, expiresAt: 100, activeOrganizationId: null }],
	};
	expect(() =>
		assertOrganizationRefusalEffects({ operation: chooseNonmembership, before, after, now: 99 }),
	).not.toThrow();
	expect(() =>
		assertOrganizationRefusalEffects({
			operation: chooseNonmembership,
			before,
			after: { ...after, member: [] },
			now: 99,
		}),
	).toThrow('member');
	expect(() => assertOrganizationRefusalEffects({ operation, before, after, now: 99 })).toThrow(
		'session',
	);
});
