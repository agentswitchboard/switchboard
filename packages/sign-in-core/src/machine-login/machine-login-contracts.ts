import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { machineResourceUriSchema } from '#sign-in-core/machine-login/machine-resource-uri';

const unixSecondsSchema = z.number().int().nonnegative();
const machineIdSchema = uuid7Schema.brand<'MachineId'>();
export const machineLabelSchema = z
	.string()
	.transform((label) => label.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ''))
	.pipe(
		z
			.string()
			.min(1)
			.refine((label) => new TextEncoder().encode(label).length <= 256)
			.refine((label) =>
				Array.from(label).every(
					(character) => character >= ' ' || character === '\t' || character === '\n',
				),
			),
	);

export const presentedMachineSchema = z.strictObject({ machineId: machineIdSchema });
export type PresentedMachine = z.infer<typeof presentedMachineSchema>;

export const machineLoginConfigurationSchema = z.strictObject({
	routerClientId: uuid7Schema,
	machineAudience: machineResourceUriSchema,
	fleetCentral: z.strictObject({ receiver: uuid7Schema, relay: uuid7Schema }),
});
export type MachineLoginConfiguration = z.infer<typeof machineLoginConfigurationSchema>;

export const decideDeviceLoginSchema = z.strictObject({
	...presentedMachineSchema.shape,
	organizationId: uuid7Schema,
	approver: uuid7Schema,
	permissionChecked: z.literal('machine:enroll'),
	requestId: uuid7Schema,
	label: machineLabelSchema,
	allowedWorkspaces: z.array(uuid7Schema).max(100),
	approverSecondFactorAt: unixSecondsSchema.nullable(),
	codeExpiresAt: unixSecondsSchema,
});
export type DecideDeviceLogin = z.infer<typeof decideDeviceLoginSchema>;

export const deviceLoginRefusalSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('notPermitted') }),
	z.strictObject({ kind: z.literal('machineInAnotherOrganization') }),
	z.strictObject({ kind: z.literal('unknownWorkspace') }),
	z.strictObject({ kind: z.literal('requestConflict') }),
	z.strictObject({
		kind: z.literal('secondFactorRequired'),
		withinSeconds: z.number().int().positive(),
	}),
]);
/** Central returns the stored snapshot for a repeat with the same bound fields. */
export const machineDeviceApprovalResultSchema = z.strictObject({
	enrollmentId: uuid7Schema,
	label: machineLabelSchema,
	allowedWorkspaces: decideDeviceLoginSchema.shape.allowedWorkspaces,
});
export type MachineDeviceApprovalResult = z.infer<typeof machineDeviceApprovalResultSchema>;
export const deviceLoginDecisionSchema = z.discriminatedUnion('result', [
	z.strictObject({
		result: z.literal('approved'),
		...machineDeviceApprovalResultSchema.shape,
	}),
	z.strictObject({ result: z.literal('refused'), reason: deviceLoginRefusalSchema }),
]);
export type DeviceLoginDecision = z.infer<typeof deviceLoginDecisionSchema>;
export const decideMachineTokenSchema = z.strictObject({
	organizationId: uuid7Schema,
	enrollmentId: uuid7Schema,
	clientId: uuid7Schema,
});
export type DecideMachineToken = z.infer<typeof decideMachineTokenSchema>;

const endedMachineClientSchema = z.strictObject({
	enrollmentId: uuid7Schema,
	clientId: uuid7Schema,
});
const machineTokenRefusalSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('enrollmentNotActive') }),
	z.strictObject({ kind: z.literal('superseded') }),
	z.strictObject({ kind: z.literal('wrongClient') }),
	z.strictObject({ kind: z.literal('idleExpired') }),
]);

export const machineTokenDecisionSchema = z.discriminatedUnion('result', [
	z.strictObject({
		...presentedMachineSchema.shape,
		result: z.literal('grant'),
		enrollmentId: uuid7Schema,
		decidedAt: unixSecondsSchema,
		grantExpiresAt: unixSecondsSchema,
		superseded: endedMachineClientSchema.optional(),
	}),
	z.strictObject({ result: z.literal('refuse'), reason: machineTokenRefusalSchema }),
]);
export type MachineTokenDecision = z.infer<typeof machineTokenDecisionSchema>;

/** JWT extension claims keep their existing snake_case spelling. */
export const machinePrincipalSchema = z.strictObject({
	kind: z.literal('machine'),
	machine_id: machineIdSchema,
	enrollment_id: uuid7Schema,
});
export type MachinePrincipal = z.infer<typeof machinePrincipalSchema>;

export const machineTokenClaimsSchema = z.looseObject({
	iss: z.string(),
	sub: uuid7Schema,
	aud: z.string(),
	iat: unixSecondsSchema,
	exp: unixSecondsSchema,
	client_id: uuid7Schema,
	azp: uuid7Schema,
	principal: machinePrincipalSchema,
	organization_id: uuid7Schema,
	grant_expires_at: unixSecondsSchema,
});
export type MachineTokenClaims = z.infer<typeof machineTokenClaimsSchema>;

/** The verified person token supplies actor identity and second-factor time. */
export const revokeMachineEnrollmentRequestSchema = z.strictObject({
	organizationId: uuid7Schema,
	enrollmentId: uuid7Schema,
});
export type RevokeMachineEnrollmentRequest = z.infer<typeof revokeMachineEnrollmentRequestSchema>;

export const revokeMachineEnrollmentResultSchema = z.discriminatedUnion('result', [
	z.strictObject({ result: z.literal('revoked') }),
	z.strictObject({ result: z.literal('notFound') }),
	z.strictObject({ result: z.literal('alreadyEnded') }),
	z.strictObject({
		result: z.literal('refused'),
		reason: z.enum(['notPermitted', 'factorNotRecent']),
	}),
]);
export type RevokeMachineEnrollmentResult = z.infer<typeof revokeMachineEnrollmentResultSchema>;

export type MachineDecisionReply<TDecision> =
	| { readonly kind: 'answered'; readonly decision: TDecision }
	/**
	 * Central itself answered 503. Pinned central answers an unstamped store that way too, so the
	 * guard's run may probe for a forgotten organization (WS4, WS7 R-notdue).
	 */
	| { readonly kind: 'answered-unavailable' }
	| {
			readonly kind: 'unavailable';
			readonly reason: 'unavailable' | 'timeout' | 'malformed-reply';
	  };
/** WS7 R-retrysignal: only the retry after a recovery carries the run's deadline to the link. */
export interface MachineDecisionOptions {
	readonly signal?: AbortSignal;
}
export interface MachineLoginDecisions {
	readonly decideDeviceLogin: (
		request: DecideDeviceLogin,
		options?: MachineDecisionOptions,
	) => Promise<MachineDecisionReply<DeviceLoginDecision>>;
	readonly decideMachineToken: (
		request: DecideMachineToken,
		options?: MachineDecisionOptions,
	) => Promise<MachineDecisionReply<MachineTokenDecision>>;
}
/** B3b supplies the real central link. This sends nothing and admits nothing. */
export const unavailableMachineLoginDecisions: MachineLoginDecisions = {
	decideDeviceLogin: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
	decideMachineToken: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
};
export const machineEnrollmentMetadataSchema = z.strictObject({
	kind: z.literal('machineEnrollment'),
	organizationId: uuid7Schema,
	enrollmentId: uuid7Schema,
});
export function parseMachineEnrollmentMetadata(
	value: unknown,
): z.infer<typeof machineEnrollmentMetadataSchema> | null {
	const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
	const result = machineEnrollmentMetadataSchema.safeParse(parsed);
	return result.success ? result.data : null;
}
export const machineTokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	expires_in: z.number().int().positive(),
	expires_at: unixSecondsSchema,
	token_type: z.literal('Bearer'),
	scope: z.literal('offline_access'),
	machine_client_id: uuid7Schema,
	fleet_central: machineLoginConfigurationSchema.shape.fleetCentral,
});
