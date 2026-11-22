import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import type {
	DeviceLoginDecision,
	deviceLoginRefusalSchema,
} from '#sign-in-core/machine-login/machine-login-contracts';

export const deviceApprovalClaimSchema = z
	.strictObject({
		attempts: z.array(uuid7Schema).readonly(),
		mayHaveCommitted: z.boolean(),
	})
	.readonly();

export type DeviceApprovalClaim = z.infer<typeof deviceApprovalClaimSchema>;
type DeviceLoginRefusal = z.infer<typeof deviceLoginRefusalSchema>;

export type DeviceApprovalCompletion =
	| { readonly kind: 'not-sent' }
	| { readonly kind: 'unanswered' }
	| { readonly kind: 'answered'; readonly decision: DeviceLoginDecision };

export type DeviceApprovalClaimTransition =
	| { readonly kind: 'unchanged' }
	| { readonly kind: 'approve'; readonly enrollmentId: string }
	| { readonly kind: 'release' }
	| { readonly kind: 'retain'; readonly claim: DeviceApprovalClaim };

export function settleDeviceApprovalClaim(props: {
	readonly claim: DeviceApprovalClaim;
	readonly attempt: z.infer<typeof uuid7Schema>;
	readonly completion: DeviceApprovalCompletion;
}): DeviceApprovalClaimTransition {
	const { claim, attempt, completion } = props;
	if (!claim.attempts.includes(attempt)) return { kind: 'unchanged' };
	if (completion.kind === 'answered' && completion.decision.result === 'approved')
		return { kind: 'approve', enrollmentId: completion.decision.enrollmentId };
	const attempts = claim.attempts.filter((active) => active !== attempt);
	const mayHaveCommitted =
		claim.mayHaveCommitted ||
		completion.kind === 'unanswered' ||
		(completion.kind === 'answered' && !refusalCertifiesNoApproval(completion.decision.reason));
	return attempts.length === 0 && !mayHaveCommitted
		? { kind: 'release' }
		: { kind: 'retain', claim: { attempts, mayHaveCommitted } };
}

/** Assumption at the Central seam: it looks up an existing approval for this
 * request ID before returning one of the four definitive refusals. A lost or
 * unreadable earlier reply can still hide a commit. Only a confirmed approval
 * or expiry disposes of that uncertainty.
 */
function refusalCertifiesNoApproval(refusal: DeviceLoginRefusal): boolean {
	switch (refusal.kind) {
		case 'notPermitted':
		case 'secondFactorRequired':
		case 'unknownWorkspace':
		case 'machineInAnotherOrganization':
			return true;
		case 'requestConflict':
			return false;
		default:
			return refusal satisfies never;
	}
}
