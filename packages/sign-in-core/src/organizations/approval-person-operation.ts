import { z } from 'zod';

import type {
	ApprovalDecideRequest,
	ApprovalListRequest_Deserialize,
	ApprovalReadRequest,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import {
	approvalAnswerSchema,
	approvalOperationIdSchema,
	approvalRequestIdSchema,
} from '#sign-in-core/contracts/approval-wire-values';
import { centralUuid7Schema } from '#sign-in-core/contracts/fleet-admin-wire';

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
		/** Chosen once per decide; a step-up resend after `factorRequired` uses a new one. */
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
