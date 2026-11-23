import {
	offeredOptionIdSchema,
	questionFieldIdSchema,
	questionNumberSchema,
	type ApprovalPersonOperation,
	type ApprovalPersonReplyFor,
} from '@agent-collaboration/sign-in-core';

// How the owner CLI turns an approve, a deny or `--field` arguments into central's Answer
// (Sign-in Lead's DEL-06 step 2b decisions). Every refusal here happens before anything is sent.

type ReadView = Extract<
	ApprovalPersonReplyFor<'ApprovalRead'>,
	{ readonly kind: 'request' }
>['view'];
export type ProviderApprovalOffer = Extract<
	ReadView,
	{ readonly kind: 'providerApproval' }
>['offer'];
export type QuestionOffer = Extract<ReadView, { readonly kind: 'providerQuestion' }>['offer'];
type OfferedOption = ProviderApprovalOffer['options'][number];
type QuestionField = QuestionOffer['fields'][number];
type DecideAnswer = Extract<
	ApprovalPersonOperation,
	{ readonly operation: 'ApprovalDecide' }
>['answer'];
type QuestionAnswer = Extract<DecideAnswer, { readonly kind: 'question' }>['answer'];
type QuestionFieldAnswer = Extract<QuestionAnswer, { readonly kind: 'answered' }>['fields'][number];

/** The words for an option's lifetime, as `show` and the refusals list it. */
export function lifetimeWords(lasts: OfferedOption['lasts']): string {
	switch (lasts.kind) {
		case 'thisRequest':
			return 'this request only';
		case 'thisTurn':
			return `this turn (kept ${lasts.kept === 'agentMemory' ? 'in agent memory' : 'nowhere'})`;
		case 'thisSession':
			return `this session (kept ${lasts.kept === 'agentMemory' ? 'in agent memory' : 'nowhere'})`;
		case 'keptUntilChanged':
			return `kept until changed (in the ${lasts.kept === 'agentSettingsFile' ? 'agent settings file' : 'agent rules file'})`;
		case 'notVerified':
			return 'lifetime not verified';
		default:
			return lasts satisfies never;
	}
}

/** One line per offered option: its id (what `--option` takes), effect, lifetime and label. */
export function optionLines(offer: ProviderApprovalOffer): readonly string[] {
	return offer.options.map(
		(option) =>
			`  option ${option.id}  ${option.effect}  ${lifetimeWords(option.lasts)}  ${option.label}`,
	);
}

/** `approve` takes the single allow option and `deny` the single decline option. */
const verbEffect = { approve: 'allow', deny: 'decline' } as const;

export type OptionResolution =
	| { readonly kind: 'resolved'; readonly optionId: number }
	| { readonly kind: 'ambiguous'; readonly effect: 'allow' | 'decline' }
	| { readonly kind: 'none'; readonly effect: 'allow' | 'decline' }
	| { readonly kind: 'unoffered'; readonly optionId: number }
	| { readonly kind: 'invalid-option' };

/**
 * The one option an approve or deny answers with. `--option` names it explicitly and overrides
 * the effect match; otherwise exactly one option must have the verb's effect.
 */
export function resolveApprovalOption(props: {
	readonly offer: ProviderApprovalOffer;
	readonly verb: 'approve' | 'deny';
	readonly option: string | undefined;
}): OptionResolution {
	if (props.option !== undefined) {
		const parsed = offeredOptionIdSchema.safeParse(
			/^\d+$/u.test(props.option) ? Number(props.option) : Number.NaN,
		);
		if (!parsed.success) return { kind: 'invalid-option' };
		return props.offer.options.some((option) => option.id === parsed.data)
			? { kind: 'resolved', optionId: parsed.data }
			: { kind: 'unoffered', optionId: parsed.data };
	}
	const effect = verbEffect[props.verb];
	const matching = props.offer.options.filter((option) => option.effect === effect);
	const [only] = matching;
	if (only === undefined) return { kind: 'none', effect };
	return matching.length === 1
		? { kind: 'resolved', optionId: only.id }
		: { kind: 'ambiguous', effect };
}

const effectWords = { allow: 'an allow', decline: 'a decline' } as const;

export function optionRefusalWords(
	resolution: Exclude<OptionResolution, { kind: 'resolved' }>,
): string {
	switch (resolution.kind) {
		case 'ambiguous':
			return `More than one option is ${effectWords[resolution.effect]}; choose one with --option. Nothing was sent.`;
		case 'none':
			return `No option is ${effectWords[resolution.effect]}; choose one with --option. Nothing was sent.`;
		case 'unoffered':
			return `Option ${resolution.optionId} is not offered. Nothing was sent.`;
		case 'invalid-option':
			return '--option takes an option id from the list below. Nothing was sent.';
		default:
			return resolution satisfies never;
	}
}

const fieldKindWords = {
	text: 'text',
	number: 'number',
	boolean: 'true or false',
	singleChoice: 'one option id',
	multiChoice: 'several option ids (not answerable from the CLI yet)',
} as const satisfies Record<QuestionField['kind'], string>;

/** One line per field (with its choice options): its id, what value fits, required or not, label. */
export function fieldLines(offer: QuestionOffer): readonly string[] {
	return offer.fields.flatMap((field) => {
		const line = `  field ${field.fieldId}  ${fieldKindWords[field.kind]}  ${field.required ? 'required' : 'optional'}  ${field.label}`;
		const choices =
			field.kind === 'singleChoice'
				? field.options
				: field.kind === 'multiChoice'
					? field.selection.options
					: [];
		return [line, ...choices.map((choice) => `    option ${choice.optionId}  ${choice.label}`)];
	});
}

export type QuestionAnswerBuild =
	| { readonly kind: 'built'; readonly answer: QuestionAnswer }
	| { readonly kind: 'malformed-argument'; readonly argument: string }
	| { readonly kind: 'unknown-field'; readonly fieldId: string }
	| { readonly kind: 'repeated-field'; readonly fieldId: number }
	| { readonly kind: 'wrong-value'; readonly fieldId: number }
	| { readonly kind: 'multi-choice'; readonly fieldId: number }
	| { readonly kind: 'missing-required'; readonly fieldId: number };

/** One field's value as the field's declared kind takes it; null when it does not fit. */
function fieldValue(field: QuestionField, text: string): QuestionFieldAnswer['value'] | null {
	switch (field.kind) {
		case 'text':
			return text.isWellFormed() ? { kind: 'text', value: text } : null;
		case 'number': {
			const parsed = questionNumberSchema.safeParse(text);
			return parsed.success ? { kind: 'number', value: parsed.data } : null;
		}
		case 'boolean':
			return text === 'true' || text === 'false'
				? { kind: 'boolean', value: text === 'true' }
				: null;
		case 'singleChoice': {
			const optionId = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
			return field.options.some((option) => option.optionId === optionId)
				? { kind: 'selectedOptions', selectedOptionIds: [optionId] }
				: null;
		}
		case 'multiChoice':
			return null;
		default:
			return field satisfies never;
	}
}

/**
 * `--field ID=VALUE` arguments as central's QuestionAnswer, in the order given. Refused before
 * sending: a malformed argument, an unknown or repeated field id, a value that does not fit the
 * field's declared kind, any multi-choice field, and a required field left out.
 */
export function buildQuestionAnswer(props: {
	readonly offer: QuestionOffer;
	readonly fieldArguments: readonly string[];
}): QuestionAnswerBuild {
	const answered: QuestionFieldAnswer[] = [];
	for (const argument of props.fieldArguments) {
		const separator = argument.indexOf('=');
		if (separator <= 0) return { kind: 'malformed-argument', argument };
		const idText = argument.slice(0, separator);
		const fieldId = questionFieldIdSchema.safeParse(
			/^\d+$/u.test(idText) ? Number(idText) : Number.NaN,
		);
		const field = fieldId.success
			? props.offer.fields.find((candidate) => candidate.fieldId === fieldId.data)
			: undefined;
		if (field === undefined) return { kind: 'unknown-field', fieldId: idText };
		if (answered.some((prior) => prior.fieldId === field.fieldId))
			return { kind: 'repeated-field', fieldId: field.fieldId };
		if (field.kind === 'multiChoice') return { kind: 'multi-choice', fieldId: field.fieldId };
		const value = fieldValue(field, argument.slice(separator + 1));
		if (value === null) return { kind: 'wrong-value', fieldId: field.fieldId };
		answered.push({ fieldId: field.fieldId, value });
	}
	const missing = props.offer.fields.find(
		(field) => field.required && !answered.some((prior) => prior.fieldId === field.fieldId),
	);
	if (missing !== undefined)
		return missing.kind === 'multiChoice'
			? { kind: 'multi-choice', fieldId: missing.fieldId }
			: { kind: 'missing-required', fieldId: missing.fieldId };
	return { kind: 'built', answer: { kind: 'answered', fields: answered } };
}

export function questionRefusalWords(
	build: Exclude<QuestionAnswerBuild, { kind: 'built' }>,
): string {
	switch (build.kind) {
		case 'malformed-argument':
			return `--field takes FIELD_ID=VALUE, not "${build.argument}". Nothing was sent.`;
		case 'unknown-field':
			return `Field ${build.fieldId} is not on this question. Nothing was sent.`;
		case 'repeated-field':
			return `Field ${build.fieldId} is given more than once. Nothing was sent.`;
		case 'wrong-value':
			return `The value for field ${build.fieldId} does not fit that field. Nothing was sent.`;
		case 'multi-choice':
			return `Field ${build.fieldId} takes several options; the CLI cannot answer multi-choice fields yet. Nothing was sent.`;
		case 'missing-required':
			return `Field ${build.fieldId} is required. Nothing was sent.`;
		default:
			return build satisfies never;
	}
}
