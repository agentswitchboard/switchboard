import { z } from 'zod';

import type {
	DecideDeviceLogin_Deserialize,
	DecideMachineToken as DecideMachineTokenWireRequest,
	DeviceLoginDecision as DeviceLoginWireDecision,
	DeviceLoginRefusal as DeviceLoginWireRefusal,
	MachineEnrollmentRevocationRefusal,
	MachineEnrollmentRevocationResult,
	MachineTokenDecision_Serialize,
	MachineTokenRefusal,
	RevokeMachineEnrollmentRequest as RevokeMachineEnrollmentWireRequest,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
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

const deviceLoginWireRefusalSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('notPermitted') }),
	z.strictObject({ kind: z.literal('machineInAnotherOrganization') }),
	z.strictObject({ kind: z.literal('unknownWorkspace') }),
	z.strictObject({
		kind: z.literal('secondFactorRequired'),
		withinSeconds: z.number().int().positive(),
	}),
]);
// Provisional DEL-03 compatibility. The pinned producer does not emit RequestConflict yet.
const provisionalDeviceLoginConflict = z.strictObject({ kind: z.literal('requestConflict') });
export const deviceLoginRefusalSchema = z.discriminatedUnion('kind', [
	...deviceLoginWireRefusalSchema.options,
	provisionalDeviceLoginConflict,
]);
type DeviceLoginRouteRefusal = Extract<
	DeviceLoginWireRefusal,
	{ kind: z.output<typeof deviceLoginWireRefusalSchema>['kind'] }
>;

/** Central returns the stored snapshot for a repeat with the same bound fields. */
const machineApprovalWireFactsSchema = z.strictObject({
	enrollmentId: z.uuidv7(),
	label: machineLabelSchema,
	allowedWorkspaces: z.array(z.uuidv7()).max(100),
});
const deviceLoginApprovedWireSchema = machineApprovalWireFactsSchema.extend({
	result: z.literal('approved'),
});
const deviceLoginDecisionWireSchema = z.discriminatedUnion('result', [
	deviceLoginApprovedWireSchema,
	z.strictObject({ result: z.literal('refused'), reason: deviceLoginWireRefusalSchema }),
]);
export const machineDeviceApprovalResultSchema = machineApprovalWireFactsSchema.extend({
	enrollmentId: uuid7Schema,
	allowedWorkspaces: decideDeviceLoginSchema.shape.allowedWorkspaces,
});
export type MachineDeviceApprovalResult = z.infer<typeof machineDeviceApprovalResultSchema>;
export const deviceLoginDecisionSchema = z.discriminatedUnion('result', [
	machineDeviceApprovalResultSchema.extend({ result: z.literal('approved') }),
	z.strictObject({ result: z.literal('refused'), reason: deviceLoginRefusalSchema }),
]);
export type DeviceLoginDecision = z.infer<typeof deviceLoginDecisionSchema>;
export const decideMachineTokenSchema = z.strictObject({
	organizationId: uuid7Schema,
	enrollmentId: uuid7Schema,
	clientId: uuid7Schema,
});
export type DecideMachineToken = z.infer<typeof decideMachineTokenSchema>;

const endedMachineClientWireSchema = z.strictObject({
	enrollmentId: z.uuidv7(),
	clientId: z.uuidv7(),
});
const endedMachineClientSchema = endedMachineClientWireSchema.extend({
	enrollmentId: uuid7Schema,
	clientId: uuid7Schema,
});
const machineTokenRefusalSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('enrollmentNotActive') }),
	z.strictObject({ kind: z.literal('superseded') }),
	z.strictObject({ kind: z.literal('wrongClient') }),
	z.strictObject({ kind: z.literal('idleExpired') }),
]);
type MachineTokenRouteRefusal = Extract<
	MachineTokenRefusal,
	{ kind: z.output<typeof machineTokenRefusalSchema>['kind'] }
>;
const machineTokenRefusedSchema = z.strictObject({
	result: z.literal('refuse'),
	reason: machineTokenRefusalSchema,
});
const machineTokenGrantWireSchema = z.strictObject({
	result: z.literal('grant'),
	machineId: z.uuidv7(),
	enrollmentId: z.uuidv7(),
	decidedAt: unixSecondsSchema,
	grantExpiresAt: unixSecondsSchema,
	superseded: endedMachineClientWireSchema.optional(),
});
const machineTokenDecisionWireSchema = z
	.discriminatedUnion('result', [machineTokenGrantWireSchema, machineTokenRefusedSchema])
	.transform((decision) => {
		if (decision.result === 'refuse') return decision;
		const { superseded, ...grant } = decision;
		return { ...grant, ...(superseded === undefined ? {} : { superseded }) };
	});
export const machineTokenDecisionSchema = z.discriminatedUnion('result', [
	machineTokenGrantWireSchema.extend({
		...presentedMachineSchema.shape,
		enrollmentId: uuid7Schema,
		superseded: endedMachineClientSchema.optional(),
	}),
	machineTokenRefusedSchema,
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

const revokeMachineRefusalReasons = [
	'notPermitted',
	'factorNotRecent',
] as const satisfies readonly MachineEnrollmentRevocationRefusal[];
type RevokeMachineRouteRefusal = Extract<
	MachineEnrollmentRevocationRefusal,
	(typeof revokeMachineRefusalReasons)[number]
>;
export const revokeMachineEnrollmentResultSchema = z.discriminatedUnion('result', [
	z.strictObject({ result: z.literal('revoked') }),
	z.strictObject({ result: z.literal('notFound') }),
	z.strictObject({ result: z.literal('alreadyEnded') }),
	z.strictObject({
		result: z.literal('refused'),
		reason: z.enum(revokeMachineRefusalReasons),
	}),
]);
export type RevokeMachineEnrollmentResult = z.infer<typeof revokeMachineEnrollmentResultSchema>;

export type MachineDecisionWireTypes = [
	AssertWireType<
		WireTypesEqual<z.input<typeof decideDeviceLoginSchema>, DecideDeviceLogin_Deserialize>
	>,
	AssertWireType<
		WireTypesEqual<z.input<typeof decideMachineTokenSchema>, DecideMachineTokenWireRequest>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof deviceLoginWireRefusalSchema>, DeviceLoginRouteRefusal>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof deviceLoginDecisionWireSchema>, DeviceLoginWireDecision>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof machineTokenRefusalSchema>, MachineTokenRouteRefusal>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof machineTokenDecisionWireSchema>, MachineTokenDecision_Serialize>
	>,
	AssertWireType<
		WireTypesEqual<
			z.input<typeof revokeMachineEnrollmentRequestSchema>,
			RevokeMachineEnrollmentWireRequest
		>
	>,
	AssertWireType<
		WireTypesEqual<
			z.output<typeof revokeMachineEnrollmentResultSchema>,
			MachineEnrollmentRevocationResult
		>
	>,
	AssertWireType<
		WireTypesEqual<
			Extract<
				z.output<typeof revokeMachineEnrollmentResultSchema>,
				{ result: 'refused' }
			>['reason'],
			RevokeMachineRouteRefusal
		>
	>,
];

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
