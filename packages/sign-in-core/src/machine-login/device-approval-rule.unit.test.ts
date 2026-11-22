import { expect, it } from 'vitest';

import { decideDeviceApproval } from '#sign-in-core/machine-login/device-approval-rule';

const approver = '019a3dce-2000-7000-8000-0000000000a1';
const now = 1_800_000_000_000;
const code = { userId: approver, status: 'pending', expiresAt: new Date(now + 1) };

it('delegates the first-approval factor exception to Central and enforces the factor window for deny', (): void => {
	expect(
		decideDeviceApproval({
			action: 'approve',
			code,
			approver,
			permitted: true,
			secondFactorAt: null,
			now,
		}),
	).toEqual({ kind: 'approve' });
	expect(
		decideDeviceApproval({
			action: 'deny',
			code,
			approver,
			permitted: true,
			secondFactorAt: now - 900_000,
			now,
		}),
	).toEqual({ kind: 'deny' });
	expect(
		decideDeviceApproval({
			action: 'deny',
			code,
			approver,
			permitted: true,
			secondFactorAt: now - 900_001,
			now,
		}),
	).toEqual({ kind: 'refuse', reason: { kind: 'secondFactorRequired', withinSeconds: 900 } });
	expect(
		decideDeviceApproval({
			action: 'deny',
			code,
			approver,
			permitted: true,
			secondFactorAt: null,
			now,
		}),
	).toEqual({ kind: 'refuse', reason: { kind: 'secondFactorRequired', withinSeconds: 900 } });
});

it('refuses changes without the live approver or after expiry and lets only approve replay an approval', (): void => {
	const facts = { code, approver, permitted: true, secondFactorAt: now, now };
	expect(decideDeviceApproval({ ...facts, action: 'deny', permitted: false })).toEqual({
		kind: 'refuse',
		reason: { kind: 'notPermitted' },
	});
	expect(
		decideDeviceApproval({ ...facts, action: 'deny', code: { ...code, userId: 'someone-else' } }),
	).toEqual({ kind: 'refuse', reason: { kind: 'notPermitted' } });
	expect(
		decideDeviceApproval({
			...facts,
			action: 'approve',
			code: { ...code, expiresAt: new Date(now) },
		}),
	).toEqual({ kind: 'refuse', reason: { kind: 'expired' } });
	const approved = { ...code, status: 'approved' };
	expect(decideDeviceApproval({ ...facts, action: 'approve', code: approved })).toEqual({
		kind: 'approve',
	});
	expect(decideDeviceApproval({ ...facts, action: 'deny', code: approved })).toEqual({
		kind: 'refuse',
		reason: { kind: 'alreadyDecided' },
	});
});
