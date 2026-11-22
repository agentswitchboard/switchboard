import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';
import type { z } from 'zod';

import { uuid7Schema, type Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import {
	deviceApprovalClaimSchema,
	transitionDeviceApproval,
	type DeviceApprovalAction,
	type DeviceApprovalCompletion,
	type DeviceApprovalState,
} from '#sign-in-core/machine-login/device-approval-claim';
import type { deviceLoginRefusalSchema } from '#sign-in-core/machine-login/machine-login-contracts';

const firstAttempt = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000081');
const retryAttempt = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000082');
const enrollmentId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000083');
const workspace = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000084');
const selection = { label: 'Proof Mac', allowedWorkspaces: [workspace] };
const unclaimed = { kind: 'unclaimed' } as const;
const approved = {
	kind: 'answered',
	decision: { result: 'approved', enrollmentId, ...selection },
} as const;
const refused = {
	kind: 'answered',
	decision: { result: 'refused', reason: { kind: 'notPermitted' } },
} as const;
const unanswered = { kind: 'unanswered' } as const;
const notSent = { kind: 'not-sent' } as const;
const definitiveRefusals = [
	{ kind: 'notPermitted' },
	{ kind: 'secondFactorRequired', withinSeconds: 900 },
	{ kind: 'unknownWorkspace' },
	{ kind: 'machineInAnotherOrganization' },
] as const satisfies readonly z.infer<typeof deviceLoginRefusalSchema>[];

function begin(attempt: Uuid7, validated: boolean): DeviceApprovalAction {
	return { kind: 'begin', selection, validated, attempt };
}
function finish(attempt: Uuid7, completion: DeviceApprovalCompletion): DeviceApprovalAction {
	return { kind: 'settle', attempt, completion };
}

it('starts only a validated selection and clears an attempt that failed before sending', (): void => {
	expect(transitionDeviceApproval(unclaimed, begin(firstAttempt, false))).toEqual({
		next: unclaimed,
		outcome: { kind: 'validate-selection' },
	});
	const claim = transitionDeviceApproval(unclaimed, begin(firstAttempt, true)).next;
	expect(deviceApprovalClaimSchema.parse(claim)).toEqual({
		kind: 'claimed',
		selection,
		attempts: { [firstAttempt]: 'outstanding' },
	});
	for (const attempts of [{}, { [firstAttempt]: 'refused' }]) {
		expect(
			deviceApprovalClaimSchema.safeParse({ kind: 'claimed', selection, attempts }).success,
		).toBe(false);
	}
	expect(transitionDeviceApproval(claim, finish(firstAttempt, notSent))).toEqual({
		next: unclaimed,
		outcome: { kind: 'settled' },
	});
	expect(transitionDeviceApproval(unclaimed, { kind: 'deny' }).outcome).toEqual({ kind: 'denied' });
});

it('recovers the saved selection and refuses changed inputs without changing the claim', (): void => {
	const claim = transitionDeviceApproval(unclaimed, begin(firstAttempt, true)).next;
	const conflict = transitionDeviceApproval(claim, {
		kind: 'begin',
		attempt: retryAttempt,
		validated: false,
		selection: { ...selection, allowedWorkspaces: [] },
	});
	expect(conflict).toEqual({ next: claim, outcome: { kind: 'selection-conflict' } });
	expect(transitionDeviceApproval(claim, begin(firstAttempt, false)).next).toBe(claim);
	const recovered = transitionDeviceApproval(claim, begin(retryAttempt, false));
	expect(recovered.outcome).toEqual({ kind: 'send', selection });
	const finished = transitionDeviceApproval(recovered.next, finish(retryAttempt, refused));
	expect(finished.next).toMatchObject({
		kind: 'claimed',
		attempts: { [firstAttempt]: 'outstanding', [retryAttempt]: 'refused' },
	});
	expect(transitionDeviceApproval(finished.next, { kind: 'deny' }).outcome).toEqual({
		kind: 'already-deciding',
	});
});

it('retains repeated uncertainty across a definitive refusal and accepts a confirmed approval', (): void => {
	const attempts = [firstAttempt, retryAttempt, enrollmentId];
	let state: DeviceApprovalState = unclaimed;
	for (const [index, attempt] of attempts.entries()) {
		state = transitionDeviceApproval(state, begin(attempt, index === 0)).next;
		state = transitionDeviceApproval(state, finish(attempt, index < 2 ? unanswered : refused)).next;
	}
	expect(state).toMatchObject({
		kind: 'claimed',
		attempts: {
			[firstAttempt]: 'uncertain',
			[retryAttempt]: 'uncertain',
			[enrollmentId]: 'refused',
		},
	});
	const finalAttempt = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000085');
	const recovery = transitionDeviceApproval(state, begin(finalAttempt, false));
	expect(transitionDeviceApproval(recovery.next, finish(finalAttempt, approved)).next).toEqual({
		kind: 'approved',
		enrollmentId,
	});
	const expired: DeviceApprovalState = { kind: 'closed' };
	expect(transitionDeviceApproval(expired, finish(finalAttempt, approved))).toEqual({
		next: expired,
		outcome: { kind: 'not-settled' },
	});
});

it.each(definitiveRefusals)(
	'releases a lone attempt when Central answers $kind',
	(reason): void => {
		const claim = transitionDeviceApproval(unclaimed, begin(firstAttempt, true)).next;
		expect(
			transitionDeviceApproval(
				claim,
				finish(firstAttempt, {
					kind: 'answered',
					decision: { result: 'refused', reason },
				}),
			).next,
		).toEqual(unclaimed);
	},
);

it('holds a claim when Central reports a request conflict', (): void => {
	const claim = transitionDeviceApproval(unclaimed, begin(firstAttempt, true)).next;
	const finishConflict = finish(firstAttempt, {
		kind: 'answered',
		decision: { result: 'refused', reason: { kind: 'requestConflict' } },
	});
	expect(transitionDeviceApproval(claim, finishConflict).next).toMatchObject({
		kind: 'claimed',
		attempts: { [firstAttempt]: 'uncertain' },
	});
});

it('keeps a successful denial exclusive of a Central approval across generated attempts', (): void => {
	hegel.test(
		(testCase) => {
			const commands = testCase.draw(
				generators.arrays(
					generators.sampledFrom([
						'begin',
						'commit',
						'lose-reply',
						'refused',
						'not-sent',
						'deny',
						'expire',
					] as const),
					{ minSize: 2, maxSize: 24 },
				),
			);
			let state: DeviceApprovalState = unclaimed;
			let hasCentralApproval = false;
			let denied = false;
			for (const command of commands) {
				const attempt = testCase.draw(
					generators.sampledFrom([firstAttempt, retryAttempt, enrollmentId]),
				);
				if (command === 'expire') {
					state = { kind: 'closed' };
					continue;
				}
				if (command === 'begin') {
					state = transitionDeviceApproval(state, begin(attempt, true)).next;
				} else if (command === 'deny') {
					const result = transitionDeviceApproval(state, { kind: 'deny' });
					denied ||= result.outcome.kind === 'denied';
					state = result.next;
				} else if (state.kind === 'claimed' && state.attempts[attempt] === 'outstanding') {
					hasCentralApproval ||= command === 'commit' || command === 'lose-reply';
					const completion =
						command === 'commit'
							? approved
							: command === 'lose-reply'
								? unanswered
								: command === 'refused'
									? refused
									: notSent;
					state = transitionDeviceApproval(state, finish(attempt, completion)).next;
				}
				expect(denied && hasCentralApproval).toBe(false);
			}
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
