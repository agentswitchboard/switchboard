import { z } from 'zod';

import type { CentralTransport } from '#sign-in-core/central-link/central-transport';
import type {
	AdminRefusal,
	MachineAllowanceState,
	OrganizationAdminResult_Serialize,
	OrganizationChangeKind,
	OrganizationChangeOrigin,
	OrganizationChangeRecord,
	TargetedOrganizationChangeKind,
	WorkspaceView_Serialize,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import { organizationChangeFixtures } from '#sign-in-core/central-link/generated/organization-change-fixtures';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import type { Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import {
	fleetAdminRequestBody,
	fleetAdminRoutePaths,
	fleetAdminWorkspaceNameSchema,
	type FleetAdminRequest,
} from '#sign-in-core/organizations/fleet-admin-operation';
import type { CentralLinkUncertainty } from '#sign-in-core/organizations/organization-provisioning';

// Central's closed `OrganizationAdminResult` (codex-router #275, merged as `ea030e513`,
// `collaboration-central-core/src/organization_admin_contract.rs`; mirrored in
// `contract-fixtures/central-organization-admin/`), tag `result`.
const centralRecordIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
// A brand marks the value only after the same lowercase UUIDv7 validator succeeds.
const signInRecordIdSchema = centralRecordIdSchema.brand<'Uuid7'>();
const workspaceWireSchema = z.strictObject({
	workspaceId: centralRecordIdSchema,
	name: fleetAdminWorkspaceNameSchema,
	description: z
		.string()
		// Central #275 `WorkspaceView`: at most 2048 UTF-8 bytes, the same bound a create sends.
		.refine((text) => new TextEncoder().encode(text).length <= 2048, 'Description too long'),
	state: z.enum(['active', 'archiving', 'archived']),
});
const signInAdminRefusalReasons = [
	/** Another workspace already holds this name (case-insensitive, trimmed). */
	'nameInUse',
	'notPermitted',
	'secondFactorRequired',
	'refreshRequired',
	'authorizationSyncRequired',
	'expired',
	'requestTime',
	'requestReused',
	/** The same operation ID arrived with a different request. */
	'conflict',
	'rejected',
] as const satisfies readonly AdminRefusal[];

// All three current Sign-in routes share this subset; engine operations own the other reasons.
export type FleetAdminRefusalReason = Extract<
	AdminRefusal,
	(typeof signInAdminRefusalReasons)[number]
>;
export const fleetAdminRefusalReasonSchema = z.enum(signInAdminRefusalReasons);
const refusedSchema = z.strictObject({
	result: z.literal('refused'),
	reason: fleetAdminRefusalReasonSchema,
});
const targetedChangeKindSchema = z.enum(
	organizationChangeFixtures
		.filter((record) => record.kind !== 'machineAllowanceChanged')
		.map(({ kind }) => kind),
);
const machineAllowanceStateSchema = z.enum(
	organizationChangeFixtures
		.filter((record) => record.kind === 'machineAllowanceChanged')
		.map(({ state }) => state),
);
const organizationChangeOriginSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('signInProvisioning') }),
	z.strictObject({ kind: z.literal('automatic') }),
	z.strictObject({
		kind: z.literal('person'),
		personId: z.string().min(1),
		permissionChecked: z.string().min(1),
	}),
]);
const changeRecordFields = z.strictObject({
	id: centralRecordIdSchema,
	requestId: z
		.string()
		.min(1)
		.refine((value) => !value.includes('\0') && new TextEncoder().encode(value).byteLength <= 128),
	origin: organizationChangeOriginSchema,
	createdAtMillis: z.number().int(),
});
const targetedChangeWireSchema = changeRecordFields.extend({
	kind: targetedChangeKindSchema,
	targetId: z.string().min(1),
});
const machineAllowanceWireSchema = changeRecordFields.extend({
	kind: z.literal('machineAllowanceChanged'),
	machineId: centralRecordIdSchema,
	workspaceId: centralRecordIdSchema,
	state: machineAllowanceStateSchema,
});
const changeRecordWireSchema = z.discriminatedUnion('kind', [
	targetedChangeWireSchema,
	machineAllowanceWireSchema,
]);
const changeRecordSchema = z.discriminatedUnion('kind', [
	targetedChangeWireSchema.extend({ id: signInRecordIdSchema }),
	machineAllowanceWireSchema.extend({
		id: signInRecordIdSchema,
		machineId: signInRecordIdSchema,
		workspaceId: signInRecordIdSchema,
	}),
]);
const workspaceSchema = workspaceWireSchema.extend({ workspaceId: signInRecordIdSchema });
export const fleetAdminResultSchemas = {
	CreateWorkspace: z.union([
		z.strictObject({ result: z.literal('applied'), workspace: workspaceSchema }),
		refusedSchema,
	]),
	WorkspaceLookup: z.union([
		z.strictObject({ result: z.literal('found'), workspace: workspaceSchema.nullable() }),
		refusedSchema,
	]),
	ReadChangeRecords: z.union([
		z.strictObject({ result: z.literal('records'), records: z.array(changeRecordSchema) }),
		refusedSchema,
	]),
} as const;
type GeneratedAdminRefusal = Extract<OrganizationAdminResult_Serialize, { result: 'refused' }>;
type SignInAdminWireResult =
	| Exclude<OrganizationAdminResult_Serialize, GeneratedAdminRefusal>
	| (GeneratedAdminRefusal & { reason: FleetAdminRefusalReason });
type AdminReplyFor<Results extends SignInAdminWireResult['result']> = Extract<
	SignInAdminWireResult,
	{ result: Results }
>;
export type FleetAdminResult = z.output<
	(typeof fleetAdminResultSchemas)[keyof typeof fleetAdminResultSchemas]
>;
type SignInWorkspaceId = z.output<typeof workspaceSchema>['workspaceId'];
type SignInAllowanceChange = Extract<
	z.output<typeof changeRecordSchema>,
	{ kind: 'machineAllowanceChanged' }
>;
type PlainWorkspaceIdMatches = WireTypesEqual<SignInWorkspaceId, string>;
// @ts-expect-error A validated workspace ID cannot leave the decoder as an unbranded string.
export type RejectUnbrandedWorkspaceId = AssertWireType<PlainWorkspaceIdMatches>;
export type FleetAdminIdTypes = [
	AssertWireType<WireTypesEqual<SignInWorkspaceId, Uuid7>>,
	AssertWireType<WireTypesEqual<z.output<typeof changeRecordSchema>['id'], Uuid7>>,
	AssertWireType<WireTypesEqual<SignInAllowanceChange['machineId'], Uuid7>>,
	AssertWireType<WireTypesEqual<SignInAllowanceChange['workspaceId'], Uuid7>>,
];
export type FleetAdminWireSchemaTypes = [
	AssertWireType<WireTypesEqual<z.output<typeof workspaceWireSchema>, WorkspaceView_Serialize>>,
	AssertWireType<
		WireTypesEqual<z.output<typeof fleetAdminRefusalReasonSchema>, FleetAdminRefusalReason>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof targetedChangeKindSchema>, TargetedOrganizationChangeKind>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof machineAllowanceStateSchema>, MachineAllowanceState>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof changeRecordWireSchema>['kind'], OrganizationChangeKind>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof organizationChangeOriginSchema>, OrganizationChangeOrigin>
	>,
	AssertWireType<WireTypesEqual<z.output<typeof changeRecordWireSchema>, OrganizationChangeRecord>>,
	AssertWireType<
		WireTypesEqual<
			z.input<(typeof fleetAdminResultSchemas)['CreateWorkspace']>,
			AdminReplyFor<'applied' | 'refused'>
		>
	>,
	AssertWireType<
		WireTypesEqual<
			z.input<(typeof fleetAdminResultSchemas)['WorkspaceLookup']>,
			AdminReplyFor<'found' | 'refused'>
		>
	>,
	AssertWireType<
		WireTypesEqual<
			z.input<(typeof fleetAdminResultSchemas)['ReadChangeRecords']>,
			AdminReplyFor<'records' | 'refused'>
		>
	>,
];

/**
 * Central's answer, or why there is none. 401 (any token or proof failure, empty body) and 400
 * (a body central could not parse: our defect, never retried) are their own outcomes.
 */
export type FleetAdminAnswer =
	| { readonly kind: 'answered'; readonly result: FleetAdminResult }
	| { readonly kind: 'unauthenticated' }
	| { readonly kind: 'request-refused' }
	/**
	 * Central itself answered 503. Pinned central `e847a888` answers an unstamped store that way
	 * too (empty body, revealing nothing); only a digest read tells them apart (WS7 R-notdue).
	 */
	| { readonly kind: 'answered-unavailable' }
	| { readonly kind: 'unknown'; readonly reason: CentralLinkUncertainty };

export interface FleetAdminLinkClient {
	/**
	 * `signal`, when given, aborts the request on the link: WS7 R-retrysignal passes the run's
	 * deadline only on the retry after a recovery, never on the first send.
	 */
	readonly sendFleetAdminRequest: (props: {
		readonly operation: FleetAdminRequest;
		readonly accessToken: string;
		readonly proof: string;
		readonly signal?: AbortSignal;
	}) => Promise<FleetAdminAnswer>;
	/**
	 * The CLI's request, relayed unchanged: its own `Authorization`, `DPoP` and body bytes.
	 * Central verifies them; nothing here parses or re-encodes the body.
	 */
	readonly relayFleetAdminRequest: (props: {
		readonly operation: FleetAdminRequest['operation'];
		readonly authorization: string;
		readonly proof: string;
		readonly body: Uint8Array<ArrayBuffer>;
		readonly signal?: AbortSignal;
	}) => Promise<FleetAdminAnswer>;
}

/** One send per call; the admin routes travel the private link like every other central call. */
export function createFleetAdminLinkClient(transport: CentralTransport): FleetAdminLinkClient {
	async function send(props: {
		readonly operation: FleetAdminRequest['operation'];
		readonly authorization: string;
		readonly proof: string;
		readonly body: string | Uint8Array<ArrayBuffer>;
		readonly signal?: AbortSignal;
	}): Promise<FleetAdminAnswer> {
		let response: Response;
		try {
			response = await transport.fetch(
				new Request(`http://central.invalid${fleetAdminRoutePaths[props.operation]}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: props.authorization,
						dpop: props.proof,
					},
					body: props.body,
					...(props.signal === undefined ? {} : { signal: props.signal }),
				}),
			);
		} catch (error) {
			return {
				kind: 'unknown',
				reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unavailable',
			};
		}
		if (response.status === 401) return { kind: 'unauthenticated' };
		if (response.status === 400) return { kind: 'request-refused' };
		if (response.status === 503) return { kind: 'answered-unavailable' };
		if (response.status !== 200) return { kind: 'unknown', reason: 'unavailable' };
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { kind: 'unknown', reason: 'malformed-reply' };
		}
		const parsed = fleetAdminResultSchemas[props.operation].safeParse(payload);
		if (!parsed.success) return { kind: 'unknown', reason: 'malformed-reply' };
		return { kind: 'answered', result: parsed.data };
	}
	return {
		sendFleetAdminRequest: async (props) =>
			send({
				operation: props.operation.operation,
				authorization: `DPoP ${props.accessToken}`,
				proof: props.proof,
				body: JSON.stringify(fleetAdminRequestBody(props.operation)),
				...(props.signal === undefined ? {} : { signal: props.signal }),
			}),
		relayFleetAdminRequest: async (props) => send(props),
	};
}
