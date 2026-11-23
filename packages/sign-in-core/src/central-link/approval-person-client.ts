import { z } from 'zod';

import { approvalPersonReplySchemas } from '#sign-in-core/central-link/approval-person-replies';
import {
	approvalPersonAdminRefusals,
	approvalPersonPreflightStatuses,
	type ApprovalPersonAdminRefusal,
} from '#sign-in-core/central-link/approval-person-results';
import type { CentralTransport } from '#sign-in-core/central-link/central-transport';
import { postPersonRequestToCentral } from '#sign-in-core/central-link/fleet-admin-client';
import {
	approvalPersonRequestBody,
	approvalPersonRoutePaths,
	type ApprovalPersonOperation,
	type ApprovalPersonOperationName,
} from '#sign-in-core/organizations/approval-person-operation';
import type { CentralLinkUncertainty } from '#sign-in-core/organizations/organization-provisioning';

/** The C3 reply central gives for one operation. */
export type ApprovalPersonReplyFor<Operation extends ApprovalPersonOperationName> = z.output<
	(typeof approvalPersonReplySchemas)[Operation]
>;

/** What an empty-bodied preflight refusal from central means to sign-in. */
type ApprovalPersonPreflightAnswer =
	| { readonly kind: 'unauthenticated' }
	| { readonly kind: 'request-refused' }
	| { readonly kind: 'method-refused' }
	| { readonly kind: 'answered-unavailable' };

/**
 * Central's answer to one C3 operation, or why there is none. Every status and refusal comes
 * from central's result matrix (`approval-person-results.ts`).
 */
export type ApprovalPersonAnswer<
	Operation extends ApprovalPersonOperationName = ApprovalPersonOperationName,
> =
	/** 200 with the operation's C3 reply union. */
	| { readonly kind: 'replied'; readonly reply: ApprovalPersonReplyFor<Operation> }
	/** 200 with the admin envelope: admission refused before the C3 union. */
	| { readonly kind: 'refused'; readonly reason: ApprovalPersonAdminRefusal }
	| ApprovalPersonPreflightAnswer
	| { readonly kind: 'unknown'; readonly reason: CentralLinkUncertainty };

/** Each preflight row of central's matrix, as sign-in reads it. */
const preflightAnswers = {
	methodNotPost: { kind: 'method-refused' },
	missingCredentials: { kind: 'unauthenticated' },
	badOrganizationAddress: { kind: 'request-refused' },
	verificationFailed: { kind: 'unauthenticated' },
	unavailable: { kind: 'answered-unavailable' },
} as const satisfies Readonly<
	Record<keyof typeof approvalPersonPreflightStatuses, ApprovalPersonPreflightAnswer>
>;

function isPreflightRow(name: string): name is keyof typeof approvalPersonPreflightStatuses {
	return Object.hasOwn(approvalPersonPreflightStatuses, name);
}

/** The empty-bodied statuses in the matrix; its two 401 rows read the same way. */
function preflightAnswerForStatus(status: number): ApprovalPersonPreflightAnswer | null {
	for (const name of Object.keys(approvalPersonPreflightStatuses))
		if (isPreflightRow(name) && approvalPersonPreflightStatuses[name].status === status)
			return preflightAnswers[name];
	return null;
}

const adminRefusalEnvelopeSchema = z.strictObject({
	result: z.literal('refused'),
	reason: z.enum(approvalPersonAdminRefusals),
});

async function readApprovalPersonResponse<Operation extends ApprovalPersonOperationName>(
	operation: Operation,
	response: Response,
): Promise<ApprovalPersonAnswer<Operation>> {
	if (response.status !== 200) {
		const preflight = preflightAnswerForStatus(response.status);
		return preflight ?? { kind: 'unknown', reason: 'unavailable' };
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return { kind: 'unknown', reason: 'malformed-reply' };
	}
	const refused = adminRefusalEnvelopeSchema.safeParse(payload);
	if (refused.success) return { kind: 'refused', reason: refused.data.reason };
	const reply = replyReaders[operation](payload);
	return reply === null
		? { kind: 'unknown', reason: 'malformed-reply' }
		: { kind: 'replied', reply };
}

/** Each operation's reply, read through its step-1 schema; null when it does not parse. */
const replyReaders: {
	readonly [Operation in ApprovalPersonOperationName]: (
		payload: unknown,
	) => ApprovalPersonReplyFor<Operation> | null;
} = {
	ApprovalList: (payload) => {
		const parsed = approvalPersonReplySchemas.ApprovalList.safeParse(payload);
		return parsed.success ? parsed.data : null;
	},
	ApprovalRead: (payload) => {
		const parsed = approvalPersonReplySchemas.ApprovalRead.safeParse(payload);
		return parsed.success ? parsed.data : null;
	},
	ApprovalDecide: (payload) => {
		const parsed = approvalPersonReplySchemas.ApprovalDecide.safeParse(payload);
		return parsed.success ? parsed.data : null;
	},
};

export interface ApprovalPersonLinkClient {
	/** Sign-in's own send: the body is built from the typed operation. */
	readonly sendApprovalPersonRequest: <Operation extends ApprovalPersonOperationName>(props: {
		readonly operation: Extract<ApprovalPersonOperation, { readonly operation: Operation }>;
		readonly accessToken: string;
		readonly proof: string;
		readonly signal?: AbortSignal;
	}) => Promise<ApprovalPersonAnswer<Operation>>;
	/**
	 * The CLI's request, relayed unchanged: its own `Authorization`, `DPoP` and body bytes.
	 * Central verifies them; nothing here parses or re-encodes the body.
	 */
	readonly relayApprovalPersonRequest: (props: {
		readonly operation: ApprovalPersonOperationName;
		readonly authorization: string;
		readonly proof: string;
		readonly body: Uint8Array<ArrayBuffer>;
		readonly signal?: AbortSignal;
	}) => Promise<ApprovalPersonAnswer>;
}

/** C3's three person routes on the same private link as the admin routes. */
export function createApprovalPersonLinkClient(
	transport: CentralTransport,
): ApprovalPersonLinkClient {
	async function send<Operation extends ApprovalPersonOperationName>(props: {
		readonly operation: Operation;
		readonly authorization: string;
		readonly proof: string;
		readonly body: string | Uint8Array<ArrayBuffer>;
		readonly signal?: AbortSignal;
	}): Promise<ApprovalPersonAnswer<Operation>> {
		const posted = await postPersonRequestToCentral(transport, {
			path: approvalPersonRoutePaths[props.operation],
			authorization: props.authorization,
			proof: props.proof,
			body: props.body,
			...(props.signal === undefined ? {} : { signal: props.signal }),
		});
		if (posted.kind === 'unknown') return posted;
		return readApprovalPersonResponse(props.operation, posted.response);
	}
	return {
		sendApprovalPersonRequest: async (props) =>
			send({
				operation: props.operation.operation,
				authorization: `DPoP ${props.accessToken}`,
				proof: props.proof,
				body: JSON.stringify(approvalPersonRequestBody(props.operation)),
				...(props.signal === undefined ? {} : { signal: props.signal }),
			}),
		relayApprovalPersonRequest: async (props) => send(props),
	};
}
