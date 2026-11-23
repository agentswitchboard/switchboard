import { z } from 'zod';

import type {
	ApprovalDecideReply,
	ApprovalInvalidReason,
	ApprovalListReply_Serialize,
	ApprovalOffer_Serialize,
	ApprovalReadReply_Serialize,
	CallCancellation,
	CallOffer,
	Delivery,
	InvalidAnswer,
	InvalidApprovalEnding,
	OptionLifetime,
	ParkedCallStateView,
	ProviderCancellation,
	QuestionField_Serialize,
	QuestionOffer_Serialize,
	RequestSummary,
	RequestView_Serialize,
	SessionCallOperation,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import {
	approvalAnswerSchema,
	approvalDescriptionSchema,
	approvalLabelSchema,
	approvalRequestIdSchema,
	approvalSubjectSchema,
	approvalTitleSchema,
	approvalWindowSchema,
	centralPersonIdSchema,
	centralSessionIdSchema,
	centralTimeSchema,
	decidedBySchema,
	offeredOptionIdSchema,
	questionAnswerSchema,
	questionFieldIdSchema,
	sessionCallDecisionSchema,
	sessionCallFolderSchema,
	sessionCallModeSchema,
	sessionCallWorkFolderSchema,
} from '#sign-in-core/contracts/approval-wire-values';

// Central's C3 replies for a signed-in person (`approval_person_wire.rs` at codex-router
// 8670195): closed unions tagged `kind`, read with unknown fields refused. Each schema's output
// equals the generated `_Serialize` type, the phase central produces.

const requestSummarySchema = z.strictObject({
	requestId: approvalRequestIdSchema,
	kind: z.enum(['providerApproval', 'providerQuestion', 'unprovenCall']),
	state: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('waiting') }),
		z.strictObject({
			kind: z.literal('ended'),
			ending: z.enum(['decided', 'cancelled', 'timedOut']),
		}),
	]),
	raisedAt: centralTimeSchema,
	deadline: centralTimeSchema,
});

const optionLifetimeSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('thisRequest') }),
	z.strictObject({ kind: z.literal('thisTurn'), kept: z.enum(['nowhere', 'agentMemory']) }),
	z.strictObject({ kind: z.literal('thisSession'), kept: z.enum(['nowhere', 'agentMemory']) }),
	z.strictObject({
		kind: z.literal('keptUntilChanged'),
		kept: z.enum(['agentSettingsFile', 'agentRulesFile']),
	}),
	z.strictObject({ kind: z.literal('notVerified') }),
]);
const approvalOfferSchema = z.strictObject({
	title: approvalTitleSchema,
	description: approvalDescriptionSchema.nullable(),
	subject: approvalSubjectSchema.nullable(),
	options: z.array(
		z.strictObject({
			id: offeredOptionIdSchema,
			label: approvalLabelSchema,
			effect: z.enum(['allow', 'decline', 'abort']),
			lasts: optionLifetimeSchema,
		}),
	),
});

const choiceOptionsSchema = z.array(
	z.strictObject({ optionId: offeredOptionIdSchema, label: approvalLabelSchema }),
);
const questionFieldShape = {
	fieldId: questionFieldIdSchema,
	label: approvalLabelSchema,
	description: approvalDescriptionSchema.nullable(),
	required: z.boolean(),
} as const;
const questionFieldSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('text'), ...questionFieldShape }),
	z.strictObject({ kind: z.literal('number'), ...questionFieldShape }),
	z.strictObject({ kind: z.literal('boolean'), ...questionFieldShape }),
	z.strictObject({
		kind: z.literal('singleChoice'),
		...questionFieldShape,
		options: choiceOptionsSchema,
	}),
	z.strictObject({
		kind: z.literal('multiChoice'),
		...questionFieldShape,
		selection: z.strictObject({
			options: choiceOptionsSchema,
			min: z.number().int().nonnegative().nullable(),
			max: z.number().int().nonnegative().nullable(),
		}),
	}),
]);
const questionOfferSchema = z.strictObject({
	prompt: approvalDescriptionSchema,
	fields: z.array(questionFieldSchema),
});

const sessionCallOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('startSession'),
		agentProgram: z.enum(['claude', 'cursor']),
		workingFolder: sessionCallFolderSchema,
		mode: sessionCallModeSchema,
		workFolders: z.array(sessionCallWorkFolderSchema),
	}),
	z.strictObject({ kind: z.literal('endSessionForGood'), sessionId: centralSessionIdSchema }),
]);
const callOfferSchema = z.strictObject({ operation: sessionCallOperationSchema });

const deliverySchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('owed') }),
	z.strictObject({ kind: z.literal('receivedByHolder') }),
	z.strictObject({ kind: z.literal('closedWithoutReceipt') }),
]);
const providerCancellationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('stopped'),
		cause: z.enum([
			'turnStopped',
			'askReplaced',
			'askWithdrawn',
			'sessionClosed',
			'providerConnectionLost',
			'holderRefusedLocally',
		]),
	}),
	z.strictObject({ kind: z.literal('requesterGone') }),
	z.strictObject({ kind: z.literal('sessionEnded') }),
	z.strictObject({ kind: z.literal('enrollmentEnded') }),
]);
const callCancellationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('stopped'),
		cause: z.enum(['callWithdrawn', 'holderRefusedLocally']),
	}),
	z.strictObject({ kind: z.literal('requesterGone') }),
	z.strictObject({ kind: z.literal('enrollmentEnded') }),
]);

function giverDecisionSchema<AnswerSchema extends z.ZodType>(
	answer: AnswerSchema,
): z.ZodObject<{ by: typeof decidedBySchema; answer: AnswerSchema }, z.core.$strict> {
	return z.strictObject({ by: decidedBySchema, answer });
}

// `RequestStateView<AcceptedAnswer, ProviderCancellation>`: both provider kinds share every arm
// except the giver's accepted answer.
const providerWaitingStateSchema = z.strictObject({
	kind: z.literal('waiting'),
	status: z.enum(['pending', 'passedOn']),
});
const providerStandingEndingSchema = z.strictObject({
	kind: z.literal('standing'),
	ending: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('decided'), by: decidedBySchema }),
		z.strictObject({ kind: z.literal('cancelled'), reason: providerCancellationSchema }),
		z.strictObject({ kind: z.literal('timedOut') }),
	]),
});
const endedStateShape = { endedAt: centralTimeSchema, delivery: deliverySchema } as const;
const providerApprovalStateSchema = z.discriminatedUnion('kind', [
	providerWaitingStateSchema,
	z.strictObject({
		kind: z.literal('ended'),
		ending: z.discriminatedUnion('kind', [
			providerStandingEndingSchema,
			z.strictObject({
				kind: z.literal('giver'),
				decision: giverDecisionSchema(offeredOptionIdSchema),
			}),
		]),
		...endedStateShape,
	}),
]);
const providerQuestionStateSchema = z.discriminatedUnion('kind', [
	providerWaitingStateSchema,
	z.strictObject({
		kind: z.literal('ended'),
		ending: z.discriminatedUnion('kind', [
			providerStandingEndingSchema,
			z.strictObject({
				kind: z.literal('giver'),
				decision: giverDecisionSchema(questionAnswerSchema),
			}),
		]),
		...endedStateShape,
	}),
]);

const parkedCallStateViewSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('waiting') }),
	z.strictObject({
		kind: z.literal('ended'),
		ending: z.discriminatedUnion('kind', [
			z.strictObject({ kind: z.literal('decided'), personId: centralPersonIdSchema }),
			z.strictObject({
				kind: z.literal('giver'),
				decision: sessionCallDecisionSchema,
				personId: centralPersonIdSchema,
			}),
			z.strictObject({ kind: z.literal('cancelled'), reason: callCancellationSchema }),
			z.strictObject({ kind: z.literal('timedOut') }),
		]),
		endedAt: centralTimeSchema,
		delivery: deliverySchema,
	}),
]);

const requestViewSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('providerApproval'),
		requestId: approvalRequestIdSchema,
		offer: approvalOfferSchema,
		state: providerApprovalStateSchema,
		window: approvalWindowSchema,
	}),
	z.strictObject({
		kind: z.literal('providerQuestion'),
		requestId: approvalRequestIdSchema,
		offer: questionOfferSchema,
		state: providerQuestionStateSchema,
		window: approvalWindowSchema,
	}),
	z.strictObject({
		kind: z.literal('unprovenCall'),
		requestId: approvalRequestIdSchema,
		offer: callOfferSchema,
		state: parkedCallStateViewSchema,
		window: approvalWindowSchema,
	}),
]);

const invalidAnswerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('wrongKind') }),
	z.strictObject({ kind: z.literal('unofferedOption'), optionId: offeredOptionIdSchema }),
	z.strictObject({ kind: z.literal('unofferedField'), fieldId: questionFieldIdSchema }),
	z.strictObject({ kind: z.literal('missingRequiredField'), fieldId: questionFieldIdSchema }),
	z.strictObject({ kind: z.literal('repeatedField'), fieldId: questionFieldIdSchema }),
	z.strictObject({ kind: z.literal('wrongValueType'), fieldId: questionFieldIdSchema }),
	z.strictObject({
		kind: z.literal('repeatedSelection'),
		fieldId: questionFieldIdSchema,
		optionId: offeredOptionIdSchema,
	}),
	z.strictObject({ kind: z.literal('wrongSelectionCount'), fieldId: questionFieldIdSchema }),
]);
const invalidApprovalEndingSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('digest'), reason: z.enum(['serialization', 'nonInteger']) }),
	z.strictObject({ kind: z.literal('requesterIsReader') }),
	z.strictObject({ kind: z.literal('bindingMismatch') }),
	z.strictObject({ kind: z.literal('answer'), reason: invalidAnswerSchema }),
	z.strictObject({ kind: z.literal('ineligibleDecider') }),
	z.strictObject({ kind: z.literal('destinationNotAdmitted') }),
	z.strictObject({ kind: z.literal('retainedDecisionMismatch') }),
	z.strictObject({ kind: z.literal('chronology') }),
]);
const approvalInvalidReasonSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('invalidAnswer'), reason: invalidAnswerSchema }),
	z.strictObject({ kind: z.literal('invalidApprovalEnding'), reason: invalidApprovalEndingSchema }),
]);

/** C3 signed edit 1: `next` is always present and null on the last page. */
export const approvalListReplySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('page'),
		items: z.array(requestSummarySchema),
		next: approvalRequestIdSchema.nullable(),
	}),
]);
/** A missing id and one the person may not see answer the same `notVisible`. */
export const approvalReadReplySchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('request'), view: requestViewSchema }),
	z.strictObject({ kind: z.literal('notVisible') }),
]);
/** Approvals need no second factor (owner decision, 23 Nov): there is no step-up reply. */
export const approvalDecideReplySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('savedDecision'),
		decision: giverDecisionSchema(approvalAnswerSchema),
	}),
	z.strictObject({ kind: z.literal('alreadyDecided'), by: decidedBySchema, at: centralTimeSchema }),
	z.strictObject({ kind: z.literal('tooLate') }),
	z.strictObject({ kind: z.literal('invalid'), reason: approvalInvalidReasonSchema }),
	z.strictObject({ kind: z.literal('notVisible') }),
	z.strictObject({ kind: z.literal('operationConflict') }),
]);

/** The reply schema for each C3 operation, keyed like the signed intent's `operation`. */
export const approvalPersonReplySchemas = {
	ApprovalList: approvalListReplySchema,
	ApprovalRead: approvalReadReplySchema,
	ApprovalDecide: approvalDecideReplySchema,
} as const;
export type ApprovalListReply = z.output<typeof approvalListReplySchema>;
export type ApprovalReadReply = z.output<typeof approvalReadReplySchema>;
export type ApprovalDecideReplyResult = z.output<typeof approvalDecideReplySchema>;

export type ApprovalPersonReplyTypes = [
	AssertWireType<WireTypesEqual<z.output<typeof requestSummarySchema>, RequestSummary>>,
	AssertWireType<WireTypesEqual<z.output<typeof optionLifetimeSchema>, OptionLifetime>>,
	AssertWireType<WireTypesEqual<z.output<typeof approvalOfferSchema>, ApprovalOffer_Serialize>>,
	AssertWireType<WireTypesEqual<z.output<typeof questionFieldSchema>, QuestionField_Serialize>>,
	AssertWireType<WireTypesEqual<z.output<typeof questionOfferSchema>, QuestionOffer_Serialize>>,
	AssertWireType<WireTypesEqual<z.output<typeof sessionCallOperationSchema>, SessionCallOperation>>,
	AssertWireType<WireTypesEqual<z.output<typeof callOfferSchema>, CallOffer>>,
	AssertWireType<WireTypesEqual<z.output<typeof deliverySchema>, Delivery>>,
	AssertWireType<WireTypesEqual<z.output<typeof providerCancellationSchema>, ProviderCancellation>>,
	AssertWireType<WireTypesEqual<z.output<typeof callCancellationSchema>, CallCancellation>>,
	AssertWireType<WireTypesEqual<z.output<typeof parkedCallStateViewSchema>, ParkedCallStateView>>,
	AssertWireType<WireTypesEqual<z.output<typeof requestViewSchema>, RequestView_Serialize>>,
	AssertWireType<WireTypesEqual<z.output<typeof invalidAnswerSchema>, InvalidAnswer>>,
	AssertWireType<
		WireTypesEqual<z.output<typeof invalidApprovalEndingSchema>, InvalidApprovalEnding>
	>,
	AssertWireType<
		WireTypesEqual<z.output<typeof approvalInvalidReasonSchema>, ApprovalInvalidReason>
	>,
	AssertWireType<WireTypesEqual<ApprovalListReply, ApprovalListReply_Serialize>>,
	AssertWireType<
		WireTypesEqual<z.input<typeof approvalListReplySchema>, ApprovalListReply_Serialize>
	>,
	AssertWireType<WireTypesEqual<ApprovalReadReply, ApprovalReadReply_Serialize>>,
	AssertWireType<
		WireTypesEqual<z.input<typeof approvalReadReplySchema>, ApprovalReadReply_Serialize>
	>,
	AssertWireType<WireTypesEqual<ApprovalDecideReplyResult, ApprovalDecideReply>>,
	AssertWireType<WireTypesEqual<z.input<typeof approvalDecideReplySchema>, ApprovalDecideReply>>,
];
