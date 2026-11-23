import { z } from 'zod';

import type {
	ApprovalDecideRequest,
	ApprovalIntent_Serialize,
	ApprovalListRequest_Deserialize,
	ApprovalListRequest_Serialize,
	ApprovalReadRequest,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import {
	approvalAnswerSchema,
	approvalOperationIdSchema,
	approvalRequestIdSchema,
} from '#sign-in-core/contracts/approval-wire-values';
import type { CanonicalJsonValue } from '#sign-in-core/contracts/canonical-json';
import { centralUuid7Schema } from '#sign-in-core/contracts/fleet-admin-wire';
import type { SignInCrypto } from '#sign-in-core/contracts/sign-in-platform';
import { centralSignedIntentDigest } from '#sign-in-core/organizations/fleet-admin-operation';

// C3 (signed 23 Nov): a signed-in person lists, reads and answers approvals through central's
// approval system, on the same private admin wire and with one permission, `approval:decide`.
// Bodies are central's `ApprovalPersonRoute` readers at codex-router 8670195: closed objects
// that never name their operation; the route selects it.

export const approvalPersonRoutePaths = {
	ApprovalList: '/organization-admin/v1/approval-list',
	ApprovalRead: '/organization-admin/v1/approval-read',
	ApprovalDecide: '/organization-admin/v1/approval-decide',
} as const;
export type ApprovalPersonOperationName = keyof typeof approvalPersonRoutePaths;

export const approvalListFilterSchema = z.enum(['waiting', 'all']);

/** The bodies central reads. A list's `cursor` may be absent or null for the first page. */
export const approvalPersonRequestBodySchemas = {
	ApprovalList: z.strictObject({
		organization: centralUuid7Schema,
		filter: approvalListFilterSchema,
		cursor: approvalRequestIdSchema.nullable().exactOptional(),
	}),
	ApprovalRead: z.strictObject({
		organization: centralUuid7Schema,
		requestId: approvalRequestIdSchema,
	}),
	ApprovalDecide: z.strictObject({
		organization: centralUuid7Schema,
		requestId: approvalRequestIdSchema,
		/** Chosen once per decide; an exact retry of the same decide, with a fresh proof, reuses it. */
		operationId: approvalOperationIdSchema,
		answer: approvalAnswerSchema,
	}),
} as const satisfies Record<ApprovalPersonOperationName, z.ZodType>;

type ApprovalPersonRequestBodies = {
	[Operation in ApprovalPersonOperationName]: z.output<
		(typeof approvalPersonRequestBodySchemas)[Operation]
	>;
};
export type ApprovalPersonRequestBodyTypes = [
	AssertWireType<
		WireTypesEqual<ApprovalPersonRequestBodies['ApprovalList'], ApprovalListRequest_Deserialize>
	>,
	AssertWireType<WireTypesEqual<ApprovalPersonRequestBodies['ApprovalRead'], ApprovalReadRequest>>,
	AssertWireType<
		WireTypesEqual<ApprovalPersonRequestBodies['ApprovalDecide'], ApprovalDecideRequest>
	>,
];

/**
 * One person's C3 operation as sign-in builds it, tagged like the signed intent. A list's
 * cursor is explicit: null asks for the first page.
 */
export const approvalPersonOperationSchema = z.discriminatedUnion('operation', [
	approvalPersonRequestBodySchemas.ApprovalList.extend({
		operation: z.literal('ApprovalList'),
		cursor: approvalRequestIdSchema.nullable(),
	}),
	approvalPersonRequestBodySchemas.ApprovalRead.extend({ operation: z.literal('ApprovalRead') }),
	approvalPersonRequestBodySchemas.ApprovalDecide.extend({
		operation: z.literal('ApprovalDecide'),
	}),
]);
export type ApprovalPersonOperation = z.output<typeof approvalPersonOperationSchema>;
type ExpectedApprovalPersonOperation =
	| ({ operation: 'ApprovalList' } & Omit<ApprovalListRequest_Deserialize, 'cursor'> & {
				cursor: NonNullable<ApprovalListRequest_Deserialize['cursor']> | null;
			})
	| ({ operation: 'ApprovalRead' } & ApprovalReadRequest)
	| ({ operation: 'ApprovalDecide' } & ApprovalDecideRequest);
export type ApprovalPersonOperationTypes = [
	AssertWireType<WireTypesEqual<ApprovalPersonOperation, ExpectedApprovalPersonOperation>>,
	AssertWireType<
		WireTypesEqual<ApprovalPersonOperation['operation'], ApprovalIntent_Serialize['operation']>
	>,
];

/** The closed body for the operation's route, as central serializes it: no cursor on page one. */
export function approvalPersonRequestBody(operation: ApprovalPersonOperation): CanonicalJsonValue {
	switch (operation.operation) {
		case 'ApprovalList':
			return {
				organization: operation.organization,
				filter: operation.filter,
				...(operation.cursor === null ? {} : { cursor: operation.cursor }),
			} satisfies ApprovalListRequest_Serialize;
		case 'ApprovalRead':
			return {
				organization: operation.organization,
				requestId: operation.requestId,
			} satisfies ApprovalReadRequest;
		case 'ApprovalDecide':
			return {
				organization: operation.organization,
				requestId: operation.requestId,
				operationId: operation.operationId,
				answer: operation.answer,
			} satisfies ApprovalDecideRequest;
		default:
			return operation satisfies never;
	}
}

/**
 * Central's `ApprovalPersonOperation::intent`: the admin frame, targeting the organization for
 * a list and the request for a read or decide. Only a decide carries an operation id.
 */
export function approvalPersonIntent(operation: ApprovalPersonOperation): ApprovalIntent_Serialize {
	switch (operation.operation) {
		case 'ApprovalList':
			return {
				v: 1,
				operation: operation.operation,
				organization: operation.organization,
				target: operation.organization,
				operationId: null,
				params: { filter: operation.filter, cursor: operation.cursor },
			} satisfies ApprovalIntent_Serialize;
		case 'ApprovalRead':
			return {
				v: 1,
				operation: operation.operation,
				organization: operation.organization,
				target: operation.requestId,
				operationId: null,
				params: {},
			} satisfies ApprovalIntent_Serialize;
		case 'ApprovalDecide':
			return {
				v: 1,
				operation: operation.operation,
				organization: operation.organization,
				target: operation.requestId,
				operationId: operation.operationId,
				params: { answer: operation.answer },
			} satisfies ApprovalIntent_Serialize;
		default:
			return operation satisfies never;
	}
}

/** The proof's `intent` claim for a C3 operation, through the admin digest. */
export async function approvalPersonIntentDigest(
	crypto: SignInCrypto,
	operation: ApprovalPersonOperation,
): Promise<string> {
	return centralSignedIntentDigest(crypto, approvalPersonIntent(operation));
}
