import { describe, expect, it } from 'vitest';

import {
	buildQuestionAnswer,
	fieldLines,
	lifetimeWords,
	optionLines,
	resolveApprovalOption,
	type ProviderApprovalOffer,
	type QuestionOffer,
} from '#sign-in-owner-cli/fleet/approval-answers';

const singleEach: ProviderApprovalOffer = {
	title: 'Run the migration',
	description: null,
	subject: null,
	options: [
		{ id: 1, label: 'Allow once', effect: 'allow', lasts: { kind: 'thisRequest' } },
		{ id: 2, label: 'Decline', effect: 'decline', lasts: { kind: 'thisRequest' } },
		{ id: 3, label: 'Stop the turn', effect: 'abort', lasts: { kind: 'notVerified' } },
	],
};
const twoAllows: ProviderApprovalOffer = {
	...singleEach,
	options: [
		{ id: 1, label: 'Allow once', effect: 'allow', lasts: { kind: 'thisRequest' } },
		{
			id: 4,
			label: 'Always allow',
			effect: 'allow',
			lasts: { kind: 'keptUntilChanged', kept: 'agentSettingsFile' },
		},
		{
			id: 2,
			label: 'Decline',
			effect: 'decline',
			lasts: { kind: 'thisSession', kept: 'agentMemory' },
		},
	],
};
const question: QuestionOffer = {
	prompt: 'Deploy settings',
	fields: [
		{ kind: 'text', fieldId: 1, label: 'Reason', description: null, required: true },
		{ kind: 'number', fieldId: 2, label: 'Replicas', description: null, required: false },
		{ kind: 'boolean', fieldId: 3, label: 'Canary', description: null, required: false },
		{
			kind: 'singleChoice',
			fieldId: 4,
			label: 'Region',
			description: null,
			required: false,
			options: [
				{ optionId: 1, label: 'East' },
				{ optionId: 2, label: 'West' },
			],
		},
		{
			kind: 'multiChoice',
			fieldId: 5,
			label: 'Zones',
			description: null,
			required: false,
			selection: { options: [{ optionId: 1, label: 'a' }], min: null, max: null },
		},
	],
};

describe('resolving the one option an approve or deny answers with', (): void => {
	it.each([
		['approve', 1],
		['deny', 2],
	] as const)('%s takes the single option with its effect', (verb, optionId): void => {
		expect(resolveApprovalOption({ offer: singleEach, verb, option: undefined })).toEqual({
			kind: 'resolved',
			optionId,
		});
	});

	it('refuses when more than one option has the effect', (): void => {
		expect(resolveApprovalOption({ offer: twoAllows, verb: 'approve', option: undefined })).toEqual(
			{
				kind: 'ambiguous',
				effect: 'allow',
			},
		);
	});

	it('refuses when no option has the effect; abort is not a deny', (): void => {
		const abortOnly: ProviderApprovalOffer = {
			...singleEach,
			options: [{ id: 3, label: 'Stop', effect: 'abort', lasts: { kind: 'thisRequest' } }],
		};
		expect(resolveApprovalOption({ offer: abortOnly, verb: 'deny', option: undefined })).toEqual({
			kind: 'none',
			effect: 'decline',
		});
	});

	it.each([
		[
			'an offered option overrides the effect match',
			'approve',
			'3',
			{ kind: 'resolved', optionId: 3 },
		],
		['an ambiguous allow resolved by --option', 'approve', '4', { kind: 'resolved', optionId: 4 }],
		['an option not offered', 'deny', '9', { kind: 'unoffered', optionId: 9 }],
		['an option id past 16', 'approve', '17', { kind: 'invalid-option' }],
		['an option that is not a number', 'approve', 'allow', { kind: 'invalid-option' }],
		['a negative option', 'approve', '-1', { kind: 'invalid-option' }],
	] as const)('--option: %s', (_name, verb, option, expected): void => {
		const offer = option === '3' ? singleEach : twoAllows;
		expect(resolveApprovalOption({ offer, verb, option })).toEqual(expected);
	});

	it('lists each option with its id, effect, lifetime and label', (): void => {
		expect(optionLines(twoAllows)).toEqual([
			'  option 1  allow  this request only  Allow once',
			'  option 4  allow  kept until changed (in the agent settings file)  Always allow',
			'  option 2  decline  this session (kept in agent memory)  Decline',
		]);
		expect(lifetimeWords({ kind: 'thisTurn', kept: 'nowhere' })).toBe('this turn (kept nowhere)');
	});
});

describe('building a question answer from --field arguments', (): void => {
	it('builds central QuestionAnswer for each plain field kind, in the order given', (): void => {
		expect(
			buildQuestionAnswer({
				offer: question,
				fieldArguments: ['4=2', '1=low=risk', '2=-1.50', '3=true'],
			}),
		).toEqual({
			kind: 'built',
			answer: {
				kind: 'answered',
				fields: [
					{ fieldId: 4, value: { kind: 'selectedOptions', selectedOptionIds: [2] } },
					{ fieldId: 1, value: { kind: 'text', value: 'low=risk' } },
					{ fieldId: 2, value: { kind: 'number', value: '-1.50' } },
					{ fieldId: 3, value: { kind: 'boolean', value: true } },
				],
			},
		});
	});

	it.each([
		['an argument without =', ['reason'], { kind: 'malformed-argument', argument: 'reason' }],
		['an empty field id', ['=x'], { kind: 'malformed-argument', argument: '=x' }],
		['an unknown field id', ['1=a', '9=x'], { kind: 'unknown-field', fieldId: '9' }],
		[
			'a field id that is not a number',
			['1=a', 'region=1'],
			{ kind: 'unknown-field', fieldId: 'region' },
		],
		['a repeated field', ['1=a', '1=b'], { kind: 'repeated-field', fieldId: 1 }],
		[
			'a number that is not a decimal spelling',
			['1=a', '2=01'],
			{ kind: 'wrong-value', fieldId: 2 },
		],
		['a boolean other than true or false', ['1=a', '3=yes'], { kind: 'wrong-value', fieldId: 3 }],
		['a choice not offered', ['1=a', '4=3'], { kind: 'wrong-value', fieldId: 4 }],
		['a choice by label', ['1=a', '4=East'], { kind: 'wrong-value', fieldId: 4 }],
		['a multi-choice field', ['1=a', '5=1'], { kind: 'multi-choice', fieldId: 5 }],
		['a missing required field', ['2=3'], { kind: 'missing-required', fieldId: 1 }],
	] as const)('refuses %s', (_name, fieldArguments, expected): void => {
		expect(buildQuestionAnswer({ offer: question, fieldArguments })).toEqual(expected);
	});

	it('refuses a question whose required field is multi-choice', (): void => {
		const required = {
			...question,
			fields: question.fields.map((field) =>
				field.kind === 'multiChoice' ? { ...field, required: true } : field,
			),
		};
		expect(buildQuestionAnswer({ offer: required, fieldArguments: ['1=a'] })).toEqual({
			kind: 'multi-choice',
			fieldId: 5,
		});
	});

	it('lists each field with what fits it, whether it is required, and its choices', (): void => {
		expect(fieldLines(question)).toEqual([
			'  field 1  text  required  Reason',
			'  field 2  number  optional  Replicas',
			'  field 3  true or false  optional  Canary',
			'  field 4  one option id  optional  Region',
			'    option 1  East',
			'    option 2  West',
			'  field 5  several option ids (not answerable from the CLI yet)  optional  Zones',
			'    option 1  a',
		]);
	});
});
