import { z } from 'zod';

import { uuid7Schema, type Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import { approveDeviceRequestSchema } from '#sign-in-core/machine-login/machine-device-requests';
import {
	machineLabelSchema,
	type DeviceLoginDecision,
	type deviceLoginRefusalSchema,
} from '#sign-in-core/machine-login/machine-login-contracts';

export const deviceApprovalSelectionSchema = z.strictObject({
	label: machineLabelSchema,
	allowedWorkspaces: approveDeviceRequestSchema.shape.allowedWorkspaces.readonly(),
});
type DeviceApprovalSelection = z.infer<typeof deviceApprovalSelectionSchema>;

const attemptStatusSchema = z.enum(['outstanding', 'refused', 'uncertain']);
type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export const deviceApprovalClaimSchema = z.strictObject({
	kind: z.literal('claimed'),
	selection: deviceApprovalSelectionSchema,
	attempts: z
		.record(uuid7Schema, attemptStatusSchema)
		.refine((attempts) => Object.values(attempts).some((status) => status !== 'refused'))
		.readonly()
		.brand<'PendingApprovalAttempts'>(),
});
type DeviceApprovalClaim = z.infer<typeof deviceApprovalClaimSchema>;

export type DeviceApprovalState =
	| { readonly kind: 'unclaimed' }
	| DeviceApprovalClaim
	| { readonly kind: 'approved'; readonly enrollmentId: string | null }
	| { readonly kind: 'denied' }
	| { readonly kind: 'closed' };

type DeviceLoginRefusal = z.infer<typeof deviceLoginRefusalSchema>;
export type DeviceApprovalCompletion =
	| { readonly kind: 'not-sent' }
	| { readonly kind: 'unanswered' }
	| { readonly kind: 'answered'; readonly decision: DeviceLoginDecision };

export type DeviceApprovalAction =
	| {
			readonly kind: 'begin';
			readonly attempt: Uuid7;
			readonly selection: DeviceApprovalSelection;
			readonly validated: boolean;
	  }
	| {
			readonly kind: 'settle';
			readonly attempt: Uuid7;
			readonly completion: DeviceApprovalCompletion;
	  }
	| { readonly kind: 'deny' };

export type DeviceApprovalOutcome =
	| { readonly kind: 'validate-selection' }
	| { readonly kind: 'send'; readonly selection: DeviceApprovalSelection }
	| { readonly kind: 'approved'; readonly enrollmentId: string | null }
	| { readonly kind: 'selection-conflict' }
	| { readonly kind: 'already-decided' }
	| { readonly kind: 'already-deciding' }
	| { readonly kind: 'settled' }
	| { readonly kind: 'not-settled' }
	| { readonly kind: 'denied' };

interface DeviceApprovalTransition {
	readonly next: DeviceApprovalState;
	readonly outcome: DeviceApprovalOutcome;
}

export function transitionDeviceApproval(
	state: DeviceApprovalState,
	action: DeviceApprovalAction,
): DeviceApprovalTransition {
	switch (action.kind) {
		case 'begin': {
			if (state.kind === 'approved') return { next: state, outcome: state };
			if (state.kind !== 'claimed' && state.kind !== 'unclaimed')
				return { next: state, outcome: { kind: 'already-decided' } };
			if (state.kind === 'unclaimed' && !action.validated)
				return { next: state, outcome: { kind: 'validate-selection' } };
			const selection = state.kind === 'claimed' ? state.selection : action.selection;
			if (!sameSelection(selection, action.selection))
				return { next: state, outcome: { kind: 'selection-conflict' } };
			const attempts = state.kind === 'claimed' ? state.attempts : {};
			if (Object.hasOwn(attempts, action.attempt))
				return { next: state, outcome: { kind: 'already-decided' } };
			return {
				next: deviceApprovalClaimSchema.parse({
					kind: 'claimed',
					selection,
					attempts: { ...attempts, [action.attempt]: 'outstanding' },
				}),
				outcome: { kind: 'send', selection },
			};
		}
		case 'settle': {
			const { completion } = action;
			if (
				state.kind === 'approved' &&
				completion.kind === 'answered' &&
				completion.decision.result === 'approved' &&
				completion.decision.enrollmentId === state.enrollmentId
			)
				return { next: state, outcome: { kind: 'settled' } };
			if (state.kind !== 'claimed' || state.attempts[action.attempt] !== 'outstanding')
				return { next: state, outcome: { kind: 'not-settled' } };
			return settleClaim(state, action.attempt, completion);
		}
		case 'deny':
			if (state.kind === 'claimed') return { next: state, outcome: { kind: 'already-deciding' } };
			if (state.kind !== 'unclaimed') return { next: state, outcome: { kind: 'already-decided' } };
			return { next: { kind: 'denied' }, outcome: { kind: 'denied' } };
		default:
			return action satisfies never;
	}
}

function sameSelection(left: DeviceApprovalSelection, right: DeviceApprovalSelection): boolean {
	return (
		left.label === right.label &&
		left.allowedWorkspaces.length === right.allowedWorkspaces.length &&
		left.allowedWorkspaces.every((workspace) => right.allowedWorkspaces.includes(workspace))
	);
}

function settleClaim(
	claim: DeviceApprovalClaim,
	attempt: Uuid7,
	completion: DeviceApprovalCompletion,
): DeviceApprovalTransition {
	let status: AttemptStatus;
	switch (completion.kind) {
		case 'not-sent':
			status = 'refused';
			break;
		case 'unanswered':
			status = 'uncertain';
			break;
		case 'answered':
			if (completion.decision.result === 'approved') {
				return {
					next: { kind: 'approved', enrollmentId: completion.decision.enrollmentId },
					outcome: { kind: 'settled' },
				};
			}
			status = refusalCertifiesNoApproval(completion.decision.reason) ? 'refused' : 'uncertain';
			break;
		default:
			return completion satisfies never;
	}
	const attempts = { ...claim.attempts, [attempt]: status };
	return {
		next: Object.values(attempts).some((value) => value !== 'refused')
			? deviceApprovalClaimSchema.parse({ ...claim, attempts })
			: { kind: 'unclaimed' },
		outcome: { kind: 'settled' },
	};
}

/** Central checks stored approvals before permission, as proved by
 * `stored_approval_resolves_after_approver_loses_permission` on Tokio and workerd.
 * A definitive refusal retires only this attempt. An unanswered or outstanding
 * attempt can still have committed. */
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
