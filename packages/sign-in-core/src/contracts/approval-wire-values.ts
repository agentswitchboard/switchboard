import { z } from 'zod';

import type {
	Answer,
	ApprovalWindow,
	DecidedBy,
	QuestionAnswer,
	QuestionAnswerValue,
	QuestionFieldAnswer,
	SessionCallDecision,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import type { AssertWireType, WireTypesEqual } from '#sign-in-core/central-link/wire-type-equality';
import { centralUuid7Schema } from '#sign-in-core/contracts/fleet-admin-wire';

// The value rules of central's `approval-request-protocol` and `workspace-ids` crates
// (codex-router main 24e387993, `approval_values.rs`, `workspace-ids/src/lib.rs`). The shapes
// come from the generated wire file; these schemas add the scalar rules central's decoders hold.

/** ApprovalRequestId, CentralSessionId, PersonId and RequestId: canonical lowercase UUIDv7. */
export const approvalRequestIdSchema = centralUuid7Schema;
export const centralSessionIdSchema = centralUuid7Schema;
export const centralPersonIdSchema = centralUuid7Schema;
export const approvalOperationIdSchema = centralUuid7Schema;

/** The only CentralTime spelling central's C3 vectors use: whole seconds, UTC, `Z`. */
const centralTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;

/**
 * CentralTime as central's C3 vectors at 8670195 spell it: `YYYY-MM-DDTHH:MM:SSZ` on the
 * calendar. A fraction, another offset or a leap second is refused. Returns whole seconds since
 * the epoch, or null.
 */
function centralTimeEpochSeconds(text: string): number | null {
	const match = centralTimePattern.exec(text);
	if (match === null) return null;
	const [, ...spelled] = match;
	const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = spelled
		.slice(0, 6)
		.map(Number);
	if (
		year < 1 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	)
		return null;
	return daysSinceEpoch(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
}

function daysInMonth(year: number, month: number): number {
	const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant's days_from_civil). */
function daysSinceEpoch(year: number, month: number, day: number): number {
	const shiftedYear = month <= 2 ? year - 1 : year;
	const era = Math.floor(shiftedYear / 400);
	const yearOfEra = shiftedYear - era * 400;
	const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const dayOfEra =
		yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
	return era * 146_097 + dayOfEra - 719_468;
}

export const centralTimeSchema = z
	.string()
	.refine((text) => centralTimeEpochSeconds(text) !== null, 'Not an RFC 3339 CentralTime in UTC');

/** The immutable first-save time and its deadline exactly one hour later, to the second. */
export const approvalWindowSchema = z
	.strictObject({ raisedAt: centralTimeSchema, deadline: centralTimeSchema })
	.refine((window) => {
		const raised = centralTimeEpochSeconds(window.raisedAt);
		const deadline = centralTimeEpochSeconds(window.deadline);
		return raised !== null && deadline !== null && deadline - raised === 3600;
	}, 'The approval deadline must be exactly one hour after first save');

/** Rust's `chars().count()` for well-formed text: every UTF-16 unit except a pair's low half. */
function unicodeScalarCount(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit < 0xdc00 || unit > 0xdfff) count += 1;
	}
	return count;
}

/** Rust strings hold Unicode scalar values; a lone surrogate never comes from central. */
function approvalTextSchema(props: {
	readonly maximumCharacters: number;
	readonly nonEmpty: boolean;
}): z.ZodString {
	return z
		.string()
		.refine((text) => text.isWellFormed(), 'Text must be well-formed Unicode')
		.refine((text) => !props.nonEmpty || text.length > 0, 'Text cannot be empty')
		.refine(
			(text) => unicodeScalarCount(text) <= props.maximumCharacters,
			`Text exceeds ${props.maximumCharacters} characters`,
		);
}

export const approvalTitleSchema = approvalTextSchema({ maximumCharacters: 200, nonEmpty: false });
export const approvalDescriptionSchema = approvalTextSchema({
	maximumCharacters: 2000,
	nonEmpty: false,
});
export const approvalSubjectSchema = approvalTextSchema({
	maximumCharacters: 500,
	nonEmpty: false,
});
export const approvalLabelSchema = approvalTextSchema({ maximumCharacters: 200, nonEmpty: false });
export const sessionCallFolderSchema = approvalTextSchema({
	maximumCharacters: 2000,
	nonEmpty: true,
});
export const sessionCallModeSchema = approvalTextSchema({ maximumCharacters: 200, nonEmpty: true });
export const sessionCallWorkFolderSchema = approvalTextSchema({
	maximumCharacters: 500,
	nonEmpty: true,
});

/** Offered option ordinals run 1..=16 and question field ordinals 1..=32. */
export const offeredOptionIdSchema = z.number().int().min(1).max(16);
export const questionFieldIdSchema = z.number().int().min(1).max(32);

/** An exact ASCII decimal spelling of at most 40 characters, never `-0` or a leading zero. */
export const questionNumberSchema = z
	.string()
	.max(40)
	.regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u)
	.refine((spelling) => spelling !== '-0', 'Not an approved decimal spelling');

export const sessionCallDecisionSchema = z.enum(['allow', 'decline']);

export const questionAnswerValueSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('selectedOptions'),
		selectedOptionIds: z.array(offeredOptionIdSchema),
	}),
	z.strictObject({ kind: z.literal('text'), value: z.string() }),
	z.strictObject({ kind: z.literal('number'), value: questionNumberSchema }),
	z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
]);
export const questionFieldAnswerSchema = z.strictObject({
	fieldId: questionFieldIdSchema,
	value: questionAnswerValueSchema,
});
export const questionAnswerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('answered'), fields: z.array(questionFieldAnswerSchema) }),
	z.strictObject({ kind: z.literal('declined') }),
]);

/** The one answer a person gives: an offered option, a question's answer, or a call decision. */
export const approvalAnswerSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('approval'), optionId: offeredOptionIdSchema }),
	z.strictObject({ kind: z.literal('question'), answer: questionAnswerSchema }),
	z.strictObject({ kind: z.literal('unprovenCall'), decision: sessionCallDecisionSchema }),
]);

export const decidedBySchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('person'), personId: centralPersonIdSchema }),
	z.strictObject({ kind: z.literal('session'), session: centralSessionIdSchema }),
]);

export type ApprovalWireValueTypes = [
	AssertWireType<WireTypesEqual<z.output<typeof approvalWindowSchema>, ApprovalWindow>>,
	AssertWireType<WireTypesEqual<z.output<typeof sessionCallDecisionSchema>, SessionCallDecision>>,
	AssertWireType<WireTypesEqual<z.output<typeof questionAnswerValueSchema>, QuestionAnswerValue>>,
	AssertWireType<WireTypesEqual<z.output<typeof questionFieldAnswerSchema>, QuestionFieldAnswer>>,
	AssertWireType<WireTypesEqual<z.output<typeof questionAnswerSchema>, QuestionAnswer>>,
	AssertWireType<WireTypesEqual<z.output<typeof approvalAnswerSchema>, Answer>>,
	AssertWireType<WireTypesEqual<z.input<typeof approvalAnswerSchema>, Answer>>,
	AssertWireType<WireTypesEqual<z.output<typeof decidedBySchema>, DecidedBy>>,
];
