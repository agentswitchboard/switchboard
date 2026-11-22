import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it, vi } from 'vitest';

import { boundShrinking, fuzzSeed, fuzzSettings } from '#sign-in-test-support/fuzz/fuzz-settings';
import { assertOrganizationInvariants } from '#sign-in-test-support/fuzz/organization-invariants';
import {
	applyOrganizationOperation,
	canonicalOrganizationProjection,
	type OrganizationModel,
	type OrganizationOperation,
	type OrganizationProjection,
} from '#sign-in-test-support/fuzz/organization-model';
import {
	createOrganizationSequenceHost,
	type OrganizationSequenceHost,
} from '#sign-in-test-support/fuzz/organization-sequence-host';
import { storageCaseOwnerEmail } from '#sign-in-test-support/storage-cases/storage-case-context';
import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';

interface SequenceState {
	readonly testCase: hegel.TestCase;
	readonly host: OrganizationSequenceHost;
	readonly model: OrganizationModel;
	readonly people: hegel.stateful.Pool<string>;
	readonly organizations: hegel.stateful.Pool<string>;
	readonly sessions: hegel.stateful.Pool<string>;
	stored: OrganizationProjection;
	previous: OrganizationProjection;
	lastOutcome: 'matched' | 'mismatched';
}

async function performOperation(
	state: SequenceState,
	operation: OrganizationOperation,
): Promise<void> {
	state.testCase.note(JSON.stringify({ seed: fuzzSeed, operation }));
	const receipt = await state.host.execute(operation);
	state.testCase.note(
		JSON.stringify({ status: receipt.status, created: receipt.created, now: receipt.now }),
	);
	state.previous = state.stored;
	state.stored = receipt.projection;
	// Keep the named storage properties ahead of the policy/model checks on wrong builds.
	assertOrganizationInvariants({
		projection: state.stored,
		previous: state.previous,
		now: receipt.now,
	});
	const expected = applyOrganizationOperation({
		model: state.model,
		operation,
		created: receipt.created,
	});
	state.lastOutcome =
		(receipt.status >= 200 && receipt.status < 300) === (expected === 'accepted')
			? 'matched'
			: 'mismatched';
	expect(receipt.status, 'S3-no-storage-faults: provider must not crash').toBeLessThan(500);
	expect(receipt.now, 'S3-controlled-clock').toBe(state.model.now);
	switch (receipt.created.kind) {
		case 'organization':
			state.organizations.add(receipt.created.id);
			break;
		case 'session':
			state.sessions.add(receipt.created.id);
			break;
		case 'invitation':
		case 'none':
			break;
		default:
			receipt.created satisfies never;
	}
}

function drawInvitation(
	testCase: hegel.TestCase,
	state: SequenceState,
): OrganizationProjection['invitations'][number] {
	testCase.assume(state.model.projection.invitations.length > 0);
	return testCase.draw(generators.sampledFrom(state.model.projection.invitations));
}
function drawActor(testCase: hegel.TestCase, state: SequenceState): string {
	return testCase.draw(state.sessions.valuesReusable());
}
function drawOrganization(testCase: hegel.TestCase, state: SequenceState): string {
	return testCase.draw(state.organizations.valuesReusable());
}
function drawPerson(testCase: hegel.TestCase, state: SequenceState): string {
	return testCase.draw(state.people.valuesReusable());
}

const machine: hegel.stateful.StateMachine<SequenceState> = {
	rules: {
		'create-organization': async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'create-organization',
				actorSessionId: drawActor(testCase, state),
			}),
		invite: async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'invite',
				actorSessionId: drawActor(testCase, state),
				organizationId: drawOrganization(testCase, state),
				personId: drawPerson(testCase, state),
			}),
		accept: async (testCase, state): Promise<void> => {
			const invitation = drawInvitation(testCase, state);
			const recipientSessions = state.model.projection.sessions.filter(
				(session) =>
					session.personId === invitation.personId && session.expiresAt > state.model.now,
			);
			const actorSessionId =
				recipientSessions.length > 0 && testCase.draw(generators.booleans())
					? testCase.draw(generators.sampledFrom(recipientSessions)).id
					: drawActor(testCase, state);
			await performOperation(state, {
				kind: 'accept',
				actorSessionId,
				invitationId: invitation.id,
			});
		},
		cancel: async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'cancel',
				actorSessionId: drawActor(testCase, state),
				invitationId: drawInvitation(testCase, state).id,
			}),
		'remove-member': async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'remove-member',
				actorSessionId: drawActor(testCase, state),
				organizationId: drawOrganization(testCase, state),
				personId: drawPerson(testCase, state),
			}),
		'change-role': async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'change-role',
				actorSessionId: drawActor(testCase, state),
				organizationId: drawOrganization(testCase, state),
				personId: drawPerson(testCase, state),
				role: testCase.draw(generators.sampledFrom(['owner', 'member'] as const)),
			}),
		'choose-organization': async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'choose-organization',
				actorSessionId: drawActor(testCase, state),
				organizationId: drawOrganization(testCase, state),
			}),
		'create-session': async (testCase, state): Promise<void> =>
			performOperation(state, { kind: 'create-session', personId: drawPerson(testCase, state) }),
		'expire-session': async (testCase, state): Promise<void> =>
			performOperation(state, {
				kind: 'expire-session',
				sessionId: testCase.draw(state.sessions.valuesReusable()),
			}),
		'delete-person': async (testCase, state): Promise<void> =>
			performOperation(state, { kind: 'delete-person', personId: drawPerson(testCase, state) }),
	},
	invariants: {
		'S3-stored-invariants': {
			alwaysCheck: true,
			check: (_testCase, state): void =>
				assertOrganizationInvariants({
					projection: state.stored,
					previous: state.previous,
					now: state.model.now,
				}),
		},
		'R-fence': {
			alwaysCheck: true,
			check: (_testCase, state): void =>
				expect(
					state.stored.fences,
					'R-fence: exact revisions and active states for every retained organization/person pair',
				).toEqual(canonicalOrganizationProjection(state.model.projection).fences),
		},
		'S3-model-equals-stored-projection': {
			alwaysCheck: true,
			check: (_testCase, state): void => {
				expect(state.lastOutcome, 'S3-provider-policy: refusals match independent model').toBe(
					'matched',
				);
				expect(
					canonicalOrganizationProjection(state.stored),
					'S3-model-equals-stored-projection; refused operations permit only modeled native cleanup or choice clearing',
				).toEqual(canonicalOrganizationProjection(state.model.projection));
			},
		},
	},
};

async function initializeSequence(
	testCase: hegel.TestCase,
	host: OrganizationSequenceHost,
): Promise<SequenceState> {
	const stored = await host.reset();
	const ownerPersonId = stored.people.find((person) => person.email === storageCaseOwnerEmail)?.id;
	if (ownerPersonId === undefined) throw new Error('Sequence owner seed absent');
	const state: SequenceState = {
		testCase,
		host,
		stored,
		previous: stored,
		lastOutcome: 'matched',
		model: { projection: structuredClone(stored), now: initialSignInTestTime, ownerPersonId },
		people: new hegel.stateful.Pool<string>(testCase),
		organizations: new hegel.stateful.Pool<string>(testCase),
		sessions: new hegel.stateful.Pool<string>(testCase),
	};
	for (const person of stored.people) state.people.add(person.id);
	await performOperation(state, { kind: 'create-session', personId: ownerPersonId });
	return state;
}

for (const leg of ['better-sqlite3', 'd1-workerd'] as const) {
	it(`S3 organization sequences preserve provider policy and stored invariants on ${leg}`, async (): Promise<void> => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(initialSignInTestTime);
		let host: OrganizationSequenceHost | undefined;
		try {
			host = await createOrganizationSequenceHost({
				leg,
				setNativeTime: (milliseconds): void => {
					vi.setSystemTime(milliseconds);
				},
			});
			const currentHost = host;
			await hegel.testAsync(
				boundShrinking(async (testCase): Promise<void> => {
					const state = await initializeSequence(testCase, currentHost);
					await hegel.stateful.runAsync(testCase, machine, state, { stepCount: 50 });
				}),
				fuzzSettings(100),
			);
		} finally {
			try {
				await host?.close();
			} finally {
				vi.useRealTimers();
			}
		}
	});
}

function ownerSessionId(state: SequenceState): string {
	const current = state.model.projection.sessions.find(
		(session) =>
			session.personId === state.model.ownerPersonId && session.expiresAt > state.model.now,
	);
	if (current === undefined) throw new Error('Witness requires a live owner session');
	return current.id;
}
function memberPersonId(state: SequenceState): string {
	const person = state.model.projection.people.find(
		(candidate) => candidate.id !== state.model.ownerPersonId,
	);
	if (person === undefined) throw new Error('Witness member seed absent');
	return person.id;
}
async function createWitnessOrganization(state: SequenceState): Promise<string> {
	await performOperation(state, {
		kind: 'create-organization',
		actorSessionId: ownerSessionId(state),
	});
	const organization = state.model.projection.organizations.at(-1);
	if (organization === undefined) throw new Error('Witness organization creation failed');
	return organization.id;
}
async function joinWitnessOrganization(
	state: SequenceState,
	organizationId: string,
): Promise<string> {
	const personId = memberPersonId(state);
	await performOperation(state, {
		kind: 'invite',
		actorSessionId: ownerSessionId(state),
		organizationId,
		personId,
	});
	const invitation = state.model.projection.invitations.at(-1);
	if (invitation === undefined) throw new Error('Witness invitation creation failed');
	let current = state.model.projection.sessions.find(
		(session) => session.personId === personId && session.expiresAt > state.model.now,
	);
	if (current === undefined) {
		await performOperation(state, { kind: 'create-session', personId });
		current = state.model.projection.sessions.find(
			(session) => session.personId === personId && session.expiresAt > state.model.now,
		);
	}
	if (current === undefined) throw new Error('Witness native member session failed');
	await performOperation(state, {
		kind: 'accept',
		actorSessionId: current.id,
		invitationId: invitation.id,
	});
	return current.id;
}
function assertWitnessModel(state: SequenceState): void {
	// Use the same exact model projection as the generated sequences.
	expect(state.lastOutcome, 'S3-provider-policy').toBe('matched');
	expect(state.stored.fences, 'R-fence').toEqual(
		canonicalOrganizationProjection(state.model.projection).fences,
	);
	expect(
		canonicalOrganizationProjection(state.stored),
		'S3-model-equals-stored-projection',
	).toEqual(canonicalOrganizationProjection(state.model.projection));
}

for (const leg of ['better-sqlite3', 'd1-workerd'] as const) {
	const witnesses = {
		'R-owner: both sole-owner and multi-owner removal are refused': async (
			state: SequenceState,
		): Promise<void> => {
			const organizationId = await createWitnessOrganization(state);
			await performOperation(state, {
				kind: 'remove-member',
				actorSessionId: ownerSessionId(state),
				organizationId,
				personId: state.model.ownerPersonId,
			});
			assertWitnessModel(state);
			await joinWitnessOrganization(state, organizationId);
			await performOperation(state, {
				kind: 'change-role',
				actorSessionId: ownerSessionId(state),
				organizationId,
				personId: memberPersonId(state),
				role: 'owner',
			});
			await performOperation(state, {
				kind: 'remove-member',
				actorSessionId: ownerSessionId(state),
				organizationId,
				personId: memberPersonId(state),
			});
			assertWitnessModel(state);
		},
		'R-choice: removing another member clears their stored organization choice': async (
			state: SequenceState,
		): Promise<void> => {
			const organizationId = await createWitnessOrganization(state);
			await joinWitnessOrganization(state, organizationId);
			await performOperation(state, {
				kind: 'remove-member',
				actorSessionId: ownerSessionId(state),
				organizationId,
				personId: memberPersonId(state),
			});
			assertWitnessModel(state);
		},
		'R-fence: role change advances only its affected pair': async (
			state: SequenceState,
		): Promise<void> => {
			const organizationId = await createWitnessOrganization(state);
			await joinWitnessOrganization(state, organizationId);
			await performOperation(state, {
				kind: 'change-role',
				actorSessionId: ownerSessionId(state),
				organizationId,
				personId: memberPersonId(state),
				role: 'owner',
			});
			assertWitnessModel(state);
		},
		'R-fence: expiry and person cleanup advance every retained active and inactive pair': async (
			state: SequenceState,
		): Promise<void> => {
			const firstOrganizationId = await createWitnessOrganization(state);
			await joinWitnessOrganization(state, firstOrganizationId);
			const secondOrganizationId = await createWitnessOrganization(state);
			const sessionId = await joinWitnessOrganization(state, secondOrganizationId);
			// The member now selects the second organization, so removing their first
			// membership leaves a retained inactive pair without a scoped session there.
			await performOperation(state, {
				kind: 'remove-member',
				actorSessionId: ownerSessionId(state),
				organizationId: firstOrganizationId,
				personId: memberPersonId(state),
			});
			assertWitnessModel(state);
			await performOperation(state, { kind: 'expire-session', sessionId });
			assertWitnessModel(state);
			await performOperation(state, {
				kind: 'create-session',
				personId: state.model.ownerPersonId,
			});
			await performOperation(state, {
				kind: 'remove-member',
				actorSessionId: ownerSessionId(state),
				organizationId: secondOrganizationId,
				personId: memberPersonId(state),
			});
			await performOperation(state, { kind: 'delete-person', personId: memberPersonId(state) });
			assertWitnessModel(state);
		},
	};
	for (const [name, witness] of Object.entries(witnesses)) {
		it(`S3 ${name} on ${leg}`, async (): Promise<void> => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(initialSignInTestTime);
			let host: OrganizationSequenceHost | undefined;
			try {
				host = await createOrganizationSequenceHost({
					leg,
					setNativeTime: (milliseconds): void => {
						vi.setSystemTime(milliseconds);
					},
				});
				const currentHost = host;
				await hegel.testAsync(async (testCase): Promise<void> => {
					const state = await initializeSequence(testCase, currentHost);
					await witness(state);
				}, fuzzSettings(1));
			} finally {
				try {
					await host?.close();
				} finally {
					vi.useRealTimers();
				}
			}
		});
	}
}
