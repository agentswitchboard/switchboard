import { secondFactorWindowSeconds } from '#sign-in-core/second-factors/second-factor-step-up';
import type { deviceCode } from '#sign-in-core/storage/sign-in-schema';

type DeviceApprovalRefusal =
	| { readonly kind: 'notPermitted' }
	| { readonly kind: 'deviceNotVerified' }
	| { readonly kind: 'alreadyDecided' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'secondFactorRequired'; readonly withinSeconds: number };

export type DeviceApprovalDecision =
	| { readonly kind: 'approve' }
	| { readonly kind: 'deny' }
	| { readonly kind: 'refuse'; readonly reason: DeviceApprovalRefusal };

export function decideDeviceApproval(props: {
	readonly action: 'approve' | 'deny';
	readonly code: Pick<typeof deviceCode.$inferSelect, 'expiresAt' | 'status' | 'userId'>;
	readonly approver: string;
	readonly permitted: boolean;
	readonly secondFactorAt: number | null;
	readonly now: number;
}): DeviceApprovalDecision {
	if (!props.permitted || (props.code.userId !== null && props.code.userId !== props.approver))
		return { kind: 'refuse', reason: { kind: 'notPermitted' } };
	if (props.code.expiresAt.getTime() <= props.now)
		return { kind: 'refuse', reason: { kind: 'expired' } };
	if (props.code.userId === null) return { kind: 'refuse', reason: { kind: 'deviceNotVerified' } };
	if (
		props.code.status !== 'pending' &&
		!(props.action === 'approve' && props.code.status === 'approved')
	)
		return { kind: 'refuse', reason: { kind: 'alreadyDecided' } };

	// Central knows whether the organization's first-approval exception still applies.
	if (props.action === 'approve') return { kind: 'approve' };
	const age = props.secondFactorAt === null ? -1 : props.now - props.secondFactorAt;
	return age < 0 || age > secondFactorWindowSeconds * 1000
		? {
				kind: 'refuse',
				reason: { kind: 'secondFactorRequired', withinSeconds: secondFactorWindowSeconds },
			}
		: { kind: 'deny' };
}
