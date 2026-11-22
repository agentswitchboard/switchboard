import { z } from 'zod';

import {
	deviceLoginRefusalSchema,
	machineDeviceApprovalResultSchema,
} from '#sign-in-core/machine-login/machine-login-contracts';
import type { DeviceRefusal } from '#sign-in-core/pages/device-approval-copy';

/** What the page shows after `POST /api/auth/machine-login/{approve,deny}`. */
export type DeviceDecisionOutcome =
	/** Central's stored approval (N03): what it stored, not what was sent. */
	| {
			readonly kind: 'approved';
			readonly label: string;
			readonly allowedWorkspaces: readonly string[];
	  }
	| { readonly kind: 'denied' }
	/** Central wants a fresher second factor; Approve is then sent again. */
	| { readonly kind: 'confirm-again'; readonly withinSeconds: number }
	| { readonly kind: 'refused'; readonly refusal: DeviceRefusal }
	| { readonly kind: 'signed-out' };

const refusalBodySchema = z
	.object({
		error: z.string().optional(),
		reason: deviceLoginRefusalSchema.optional(),
	})
	.catch({});

const centralRefusal: Readonly<
	Record<
		Exclude<z.infer<typeof deviceLoginRefusalSchema>['kind'], 'secondFactorRequired'>,
		DeviceRefusal
	>
> = {
	notPermitted: 'not-permitted',
	machineInAnotherOrganization: 'other-organization',
	unknownWorkspace: 'unknown-workspace',
	requestConflict: 'request-conflict',
};

/** Maps the endpoint's actual status and body. B3a's endpoints answer a central
 * refusal as 403 `{error: 'access_denied', reason}`, sign-in's own permission
 * check as 403 `access_denied` without a reason, a code no longer pending or
 * another person's code as 400/403/409, and an unreachable central as 503. */
export function deviceDecisionOutcome(
	decision: 'approve' | 'deny',
	status: number,
	body: unknown,
): DeviceDecisionOutcome {
	if (status === 200) {
		if (decision === 'deny')
			return z.strictObject({ success: z.literal(true) }).safeParse(body).success
				? { kind: 'denied' }
				: { kind: 'refused', refusal: 'unavailable' };
		const approval = machineDeviceApprovalResultSchema.safeParse(body);
		return approval.success
			? {
					kind: 'approved',
					label: approval.data.label,
					allowedWorkspaces: approval.data.allowedWorkspaces,
				}
			: { kind: 'refused', refusal: 'unavailable' };
	}
	if (status === 401) return { kind: 'signed-out' };
	if (status === 409 && refusalBodySchema.parse(body).reason?.kind === 'requestConflict')
		return { kind: 'refused', refusal: 'request-conflict' };
	if (status === 403) {
		const refusal = refusalBodySchema.parse(body);
		if (refusal.error !== 'access_denied') return { kind: 'refused', refusal: 'expired' };
		const reason = refusal.reason;
		if (reason === undefined) return { kind: 'refused', refusal: 'not-permitted' };
		if (reason.kind === 'secondFactorRequired')
			return { kind: 'confirm-again', withinSeconds: reason.withinSeconds };
		return { kind: 'refused', refusal: centralRefusal[reason.kind] };
	}
	if (status === 400 || status === 409) return { kind: 'refused', refusal: 'expired' };
	return { kind: 'refused', refusal: 'unavailable' };
}
