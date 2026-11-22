import { expect, it } from 'vitest';

import { assertRequestRefusalEffects } from '#sign-in-test-support/fuzz/request-refusal-effects';
import type { RequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import type { RouteClassification } from '#sign-in-test-support/fuzz/route-classification';

type EffectsFixture = Parameters<typeof assertRequestRefusalEffects>[0]['fixture'];
const personId = '019a3dce-2000-7000-8000-000000000001';
const sessionId = '019a3dce-2000-7000-8000-000000000002';
const challengeId = '019a3dce-2000-7000-8000-000000000003';
const passkeyId = '019a3dce-2000-7000-8000-000000000004';
const fixture: EffectsFixture = { sessionId, context: { personId, challengeId, passkeyId } };
const classification: RouteClassification = {
	method: 'POST',
	path: '/api/auth/passkey/confirm',
	exposure: ['owner'],
	requestParts: ['json'],
	documentedAnswers: [403],
	disclosure: 'caller only',
	permittedRefusalEffects: ['consume-passkey-challenge', 'factor-intent'],
	evidence: 'test fixture',
};
const challenge = {
	identifier: `passkey-confirm:${sessionId}:${challengeId}`,
	value: 'challenge-value',
};
const unrelated = { identifier: 'other-verification', value: 'other-value' };
const before: RequestStorageSnapshot = {
	verification: [challenge, unrelated],
	user: [{ id: personId, name: 'Original' }],
	signInAudit: [],
};
function check(after: RequestStorageSnapshot): void {
	assertRequestRefusalEffects({ classification, fixture, before, after });
}

it('allows only consumption of the exact passkey challenge', (): void => {
	expect(() => check({ ...before, verification: [unrelated] })).not.toThrow();
	expect(() => check({ ...before, verification: [challenge] })).toThrow('verification');
	expect(() =>
		check({ ...before, verification: [unrelated, { identifier: 'new', value: 'new' }] }),
	).toThrow('verification');
	expect(() =>
		check({ ...before, verification: [unrelated], user: [{ id: personId, name: 'Changed' }] }),
	).toThrow('user');
});

it('permits only the exact factor intent and rejects another actor, action, target, phase or added row', (): void => {
	const intent = {
		kind: 'second-factor-changed',
		actor_user_id: personId,
		phase: 'intent',
		change_kind: 'passkey-confirmed',
		target_id: passkeyId,
	};
	expect(() => check({ ...before, signInAudit: [intent] })).not.toThrow();
	for (const invalid of [
		{ ...intent, actor_user_id: 'other' },
		{ ...intent, change_kind: 'passkey-removed' },
		{ ...intent, target_id: personId },
		{ ...intent, target_id: 'other' },
		{ ...intent, phase: 'outcome' },
	])
		expect(() => check({ ...before, signInAudit: [invalid] })).toThrow('signInAudit');
	expect(() =>
		check({ ...before, signInAudit: [intent, { ...intent, target_id: 'other' }] }),
	).toThrow('signInAudit');
});

it('permits an expired-session read only to advance (and drain-acknowledge) the expired person’s own pairs', (): void => {
	const expiredAt = 1_000;
	const now = expiredAt + 1;
	const otherPersonId = '019a3dce-2000-7000-8000-000000000009';
	const pair = (
		id: string,
		person: string,
		extra: Record<string, unknown> = {},
	): StoredRowForTest => ({
		id,
		person_id: person,
		organization_id: 'org',
		revision: 1,
		acknowledged_revision: 1,
		acknowledged_at: 0,
		next_attempt_at: 0,
		updated_at: 0,
		...extra,
	});
	const cleanup: RouteClassification = {
		...classification,
		path: '/api/auth/owner/bootstrap',
		permittedRefusalEffects: ['expired-session-cleanup'],
	};
	const base: RequestStorageSnapshot = {
		session: [{ id: sessionId, userId: personId, expiresAt: expiredAt }],
		personOrganizationAuthorizationRevisions: [pair('own', personId), pair('other', otherPersonId)],
	};
	const centralFor = (
		revision: number,
		overrides: Record<string, unknown> = {},
	): CentralEvidence => ({
		pushReply: 'acknowledge',
		pushes: [{ kind: 'person', organizationId: 'org', personId, revision, ...overrides }],
	});
	function run(
		pairs: readonly StoredRowForTest[],
		options: {
			readonly sessionsAfter?: readonly StoredRowForTest[];
			readonly central?: CentralEvidence;
		} = {},
	): void {
		assertRequestRefusalEffects({
			classification: cleanup,
			fixture,
			before: base,
			after: {
				...base,
				session: options.sessionsAfter ?? [],
				personOrganizationAuthorizationRevisions: pairs,
			},
			now,
			...(options.central === undefined ? {} : { central: options.central }),
		});
	}
	const advanced = { revision: 2, next_attempt_at: now, updated_at: now };
	const drained = { ...advanced, acknowledged_revision: 2, acknowledged_at: now };
	const effects = 'personOrganizationAuthorizationRevisions';
	expect(() => run([pair('own', personId, advanced), pair('other', otherPersonId)])).not.toThrow();
	// An acknowledgement needs Central to have received that pair's new revision and to answer with one.
	expect(() =>
		run([pair('own', personId, drained), pair('other', otherPersonId)], { central: centralFor(2) }),
	).not.toThrow();
	// Wrong builds: another person's pair moves, a pair is acknowledged ahead of its revision, a
	// pair is advanced twice.
	expect(() =>
		run([pair('own', personId, advanced), pair('other', otherPersonId, advanced)]),
	).toThrow(effects);
	expect(() =>
		run(
			[
				pair('own', personId, { ...advanced, acknowledged_revision: 3, acknowledged_at: now }),
				pair('other', otherPersonId),
			],
			{ central: centralFor(2) },
		),
	).toThrow(effects);
	expect(() =>
		run([pair('own', personId, { ...advanced, revision: 3 }), pair('other', otherPersonId)]),
	).toThrow('did not advance every retained pair');
	// An acknowledgement with no Central evidence, evidence for another revision, person or
	// organization, or a Central that does not acknowledge.
	for (const central of [
		undefined,
		centralFor(3),
		centralFor(2, { personId: otherPersonId }),
		centralFor(2, { organizationId: 'another-org' }),
		{ ...centralFor(2), pushReply: 'unavailable' },
	])
		expect(() =>
			run(
				[pair('own', personId, drained), pair('other', otherPersonId)],
				central === undefined ? {} : { central },
			),
		).toThrow(effects);
	// The pair advances only with the exact deletion: a bump while the session survives is refused.
	expect(() =>
		run([pair('own', personId, advanced), pair('other', otherPersonId)], {
			sessionsAfter: base.session ?? [],
		}),
	).toThrow(effects);
	// And a deletion with the fence table unchanged did not do what a refused expired read must do.
	expect(() => run([pair('own', personId), pair('other', otherPersonId)])).toThrow(
		'did not advance every retained pair',
	);
});

type StoredRowForTest = Record<string, unknown>;
interface CentralEvidence {
	readonly pushReply: string;
	readonly pushes: readonly {
		readonly kind: string;
		readonly organizationId: string;
		readonly personId?: string;
		readonly revision: number;
	}[];
}
