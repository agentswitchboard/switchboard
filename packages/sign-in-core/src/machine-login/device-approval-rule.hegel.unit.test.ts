import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import { decideDeviceApproval } from '#sign-in-core/machine-login/device-approval-rule';

it('keeps approval and denial confined to an unexpired code verified by the permitted person', (): void => {
	const now = 1_800_000_000_000;
	const approver = '019a3dce-2000-7000-8000-0000000000a1';
	const otherPerson = '019a3dce-2000-7000-8000-0000000000a2';
	hegel.test(
		(testCase) => {
			const status = testCase.draw(generators.sampledFrom(['pending', 'approved', 'denied']));
			const userId = testCase.draw(generators.sampledFrom([approver, otherPerson, null]));
			const permitted = testCase.draw(generators.sampledFrom([true, false]));
			const expiresAt = testCase.draw(generators.sampledFrom([now - 1, now, now + 1]));
			const confirmationAge = testCase.draw(
				generators.sampledFrom([null, -1, 0, 899_999, 900_000, 900_001]),
			);
			const facts = {
				approver,
				code: { status, userId, expiresAt: new Date(expiresAt) },
				now,
				permitted,
				secondFactorAt: confirmationAge === null ? null : now - confirmationAge,
			};
			const verified = userId === approver && permitted && expiresAt > now;
			const fresh = confirmationAge !== null && confirmationAge >= 0 && confirmationAge <= 900_000;
			const approval = decideDeviceApproval({ ...facts, action: 'approve' });
			const denial = decideDeviceApproval({ ...facts, action: 'deny' });
			expect(approval.kind === 'approve').toBe(verified && status !== 'denied');
			expect(denial.kind === 'deny').toBe(verified && status === 'pending' && fresh);
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
