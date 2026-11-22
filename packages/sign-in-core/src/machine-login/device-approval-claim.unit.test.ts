import { expect, it } from 'vitest';
import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { settleDeviceApprovalClaim } from '#sign-in-core/machine-login/device-approval-claim';
import { deviceLoginRefusalSchema } from '#sign-in-core/machine-login/machine-login-contracts';

const attempt = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000081');
const anotherAttempt = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000082');
const enrollmentId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000083');

const refusalCases = [
	{ kind: 'notPermitted' },
	{ kind: 'secondFactorRequired', withinSeconds: 900 },
	{ kind: 'unknownWorkspace' },
	{ kind: 'machineInAnotherOrganization' },
] as const satisfies readonly z.infer<typeof deviceLoginRefusalSchema>[];

it.each(refusalCases)(
	'releases the last answered attempt for $kind and keeps a concurrent attempt',
	(reason): void => {
		const completion = { kind: 'answered', decision: { result: 'refused', reason } } as const;
		expect(
			settleDeviceApprovalClaim({
				claim: { attempts: [attempt], mayHaveCommitted: false },
				attempt,
				completion,
			}),
		).toEqual({ kind: 'release' });
		expect(
			settleDeviceApprovalClaim({
				claim: { attempts: [attempt, anotherAttempt], mayHaveCommitted: false },
				attempt,
				completion,
			}),
		).toEqual({ kind: 'retain', claim: { attempts: [anotherAttempt], mayHaveCommitted: false } });
	},
);

it.each([
	{ kind: 'answered', decision: { result: 'refused', reason: { kind: 'requestConflict' } } },
	{ kind: 'unanswered' },
] as const)('retains the claim for $kind when Central may hold an approval', (completion): void => {
	const settled = settleDeviceApprovalClaim({
		claim: { attempts: [attempt], mayHaveCommitted: false },
		attempt,
		completion,
	});
	expect(settled).toEqual({ kind: 'retain', claim: { attempts: [], mayHaveCommitted: true } });
	if (settled.kind !== 'retain') throw new Error('The original claim was lost');
	const replay = { ...settled.claim, attempts: [anotherAttempt] };
	expect(
		settleDeviceApprovalClaim({
			claim: replay,
			attempt: anotherAttempt,
			completion: {
				kind: 'answered',
				decision: { result: 'refused', reason: { kind: 'notPermitted' } },
			},
		}),
	).toEqual(settled);
	expect(
		settleDeviceApprovalClaim({
			claim: replay,
			attempt: anotherAttempt,
			completion: {
				kind: 'answered',
				decision: { result: 'approved', enrollmentId, label: 'Proof Mac', allowedWorkspaces: [] },
			},
		}),
	).toEqual({ kind: 'approve', enrollmentId });
});
