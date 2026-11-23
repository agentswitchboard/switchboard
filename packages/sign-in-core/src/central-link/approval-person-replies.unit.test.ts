import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	approvalDecideReplySchema,
	approvalListReplySchema,
	approvalPersonReplySchemas,
	approvalReadReplySchema,
} from '#sign-in-core/central-link/approval-person-replies';
import { approvalPersonRequestBodySchemas } from '#sign-in-core/organizations/approval-person-operation';

// Synthetic replies shaped by the generated C3 types; central's own byte vectors are checked
// separately against its committed fixtures.
const organization = '019a3dce-2000-7000-8000-000000000001';
const requestId = '019a3dce-2000-7000-8000-0000000000c1';
const personId = '019a3dce-2000-7000-8000-0000000000d1';
const sessionId = '019a3dce-2000-7000-8000-0000000000e1';
const operationId = '019a3dce-2000-7000-8000-0000000000f1';
const window = { raisedAt: '2026-11-22T10:00:00Z', deadline: '2026-11-22T11:00:00Z' };
const person = { kind: 'person', personId } as const;
const summary = {
	requestId,
	kind: 'providerApproval',
	state: { kind: 'waiting' },
	raisedAt: window.raisedAt,
	deadline: window.deadline,
};
const providerApproval = {
	kind: 'providerApproval',
	requestId,
	offer: {
		title: 'Run the migration',
		description: null,
		subject: 'database',
		options: [
			{ id: 1, label: 'Allow once', effect: 'allow', lasts: { kind: 'thisRequest' } },
			{
				id: 2,
				label: 'Allow for the session',
				effect: 'allow',
				lasts: { kind: 'thisSession', kept: 'agentMemory' },
			},
			{
				id: 3,
				label: 'Always allow',
				effect: 'allow',
				lasts: { kind: 'keptUntilChanged', kept: 'agentSettingsFile' },
			},
			{ id: 4, label: 'Decline', effect: 'decline', lasts: { kind: 'notVerified' } },
		],
	},
	state: { kind: 'waiting', status: 'pending' },
	window,
};
const providerQuestion = {
	kind: 'providerQuestion',
	requestId,
	offer: {
		prompt: 'Which region?',
		fields: [
			{ kind: 'text', fieldId: 1, label: 'Reason', description: null, required: false },
			{
				kind: 'multiChoice',
				fieldId: 2,
				label: 'Regions',
				description: 'Pick any',
				required: true,
				selection: {
					options: [
						{ optionId: 1, label: 'East' },
						{ optionId: 2, label: 'West' },
					],
					min: 1,
					max: null,
				},
			},
		],
	},
	state: {
		kind: 'ended',
		ending: {
			kind: 'giver',
			decision: {
				by: person,
				answer: {
					kind: 'answered',
					fields: [
						{ fieldId: 2, value: { kind: 'selectedOptions', selectedOptionIds: [1, 2] } },
						{ fieldId: 1, value: { kind: 'text', value: 'latency' } },
					],
				},
			},
		},
		endedAt: '2026-11-22T10:59:59.999999999Z',
		delivery: { kind: 'receivedByHolder' },
	},
	window,
};
const unprovenCall = {
	kind: 'unprovenCall',
	requestId,
	offer: {
		operation: {
			kind: 'startSession',
			agentProgram: 'claude',
			workingFolder: '/work/project',
			mode: 'default',
			workFolders: ['/work/project'],
		},
	},
	state: {
		kind: 'ended',
		ending: { kind: 'cancelled', reason: { kind: 'stopped', cause: 'callWithdrawn' } },
		endedAt: '2026-11-22T10:30:00.001Z',
		delivery: { kind: 'owed' },
	},
	window,
};

describe('C3 replies sign-in accepts', (): void => {
	it.each([
		['the last page', { kind: 'page', items: [summary], next: null }],
		['a page with a continuation', { kind: 'page', items: [summary], next: requestId }],
		['an empty last page', { kind: 'page', items: [], next: null }],
	])('list: %s', (_name, reply): void => {
		// Arrange / Act
		const parsed = approvalListReplySchema.safeParse(reply);
		// Assert
		expect(parsed.success && parsed.data).toEqual(reply);
	});

	it.each([
		['a waiting provider approval', { kind: 'request', view: providerApproval }],
		['an answered provider question', { kind: 'request', view: providerQuestion }],
		['a withdrawn unproven call', { kind: 'request', view: unprovenCall }],
		['a request the person may not see', { kind: 'notVisible' }],
	])('read: %s', (_name, reply): void => {
		const parsed = approvalReadReplySchema.safeParse(reply);
		expect(parsed.success && parsed.data).toEqual(reply);
	});

	it.each([
		{ kind: 'savedDecision', decision: { by: person, answer: { kind: 'approval', optionId: 1 } } },
		{
			kind: 'savedDecision',
			decision: { by: person, answer: { kind: 'question', answer: { kind: 'declined' } } },
		},
		{
			kind: 'savedDecision',
			decision: { by: person, answer: { kind: 'unprovenCall', decision: 'decline' } },
		},
		{ kind: 'alreadyDecided', by: { kind: 'session', session: sessionId }, at: window.raisedAt },
		{ kind: 'tooLate' },
		{ kind: 'factorRequired', withinSeconds: 900 },
		{
			kind: 'invalid',
			reason: { kind: 'invalidAnswer', reason: { kind: 'unofferedOption', optionId: 9 } },
		},
		{
			kind: 'invalid',
			reason: { kind: 'invalidApprovalEnding', reason: { kind: 'freshFactorRequired' } },
		},
		{ kind: 'notVisible' },
		{ kind: 'operationConflict' },
	])('decide: $kind', (reply): void => {
		const parsed = approvalDecideReplySchema.safeParse(reply);
		expect(parsed.success && parsed.data).toEqual(reply);
	});

	it.each([
		'2026-11-22T10:00:00Z',
		'2026-11-22T10:00:00.001Z',
		'2026-11-22T10:00:00.000001Z',
		'2026-11-22T10:00:00.999999999Z',
		'2028-02-29T23:59:59Z',
	])('the CentralTime spelling %s', (at): void => {
		expect(
			approvalDecideReplySchema.safeParse({ kind: 'alreadyDecided', by: person, at }).success,
		).toBe(true);
	});

	it('keys each operation to its own reply union', (): void => {
		expect(Object.keys(approvalPersonReplySchemas)).toEqual([
			'ApprovalList',
			'ApprovalRead',
			'ApprovalDecide',
		]);
	});
});

describe('C3 replies sign-in refuses', (): void => {
	it.each([
		['an unknown kind', { kind: 'standing', ending: { kind: 'timedOut' } }],
		['an extra top-level field', { kind: 'tooLate', retryAfter: 5 }],
		['withinSeconds other than 900', { kind: 'factorRequired', withinSeconds: 901 }],
		['withinSeconds as a decimal string', { kind: 'factorRequired', withinSeconds: '900' }],
		['a missing withinSeconds', { kind: 'factorRequired' }],
		[
			'a person id that is not UUIDv7',
			{ kind: 'alreadyDecided', by: { kind: 'person', personId: 'p1' }, at: window.raisedAt },
		],
		[
			'an uppercase session id',
			{
				kind: 'alreadyDecided',
				by: { kind: 'session', session: sessionId.toUpperCase() },
				at: window.raisedAt,
			},
		],
		[
			'an option id past 16',
			{
				kind: 'savedDecision',
				decision: { by: person, answer: { kind: 'approval', optionId: 17 } },
			},
		],
		[
			'an option id of 0',
			{
				kind: 'invalid',
				reason: { kind: 'invalidAnswer', reason: { kind: 'unofferedOption', optionId: 0 } },
			},
		],
		[
			'an unknown invalid reason',
			{ kind: 'invalid', reason: { kind: 'invalidAnswer', reason: { kind: 'tooLong' } } },
		],
	])('decide: %s', (_name, reply): void => {
		expect(approvalDecideReplySchema.safeParse(reply).success).toBe(false);
	});

	it.each([
		['an offset other than Z', '2026-11-22T10:00:00+00:00'],
		['a lowercase z', '2026-11-22T10:00:00z'],
		['a space separator', '2026-11-22 10:00:00Z'],
		['a two-digit fraction', '2026-11-22T10:00:00.50Z'],
		['a twelve-digit fraction', '2026-11-22T10:00:00.000000000001Z'],
		['a day off the calendar', '2026-02-30T00:00:00Z'],
		['hour 24', '2026-11-22T24:00:00Z'],
		['a leap second', '2026-12-31T23:59:60Z'],
		['a date without a time', '2026-11-22'],
		['epoch milliseconds', 1795000000000],
	])('a bad time: %s', (_name, at): void => {
		expect(
			approvalDecideReplySchema.safeParse({ kind: 'alreadyDecided', by: person, at }).success,
		).toBe(false);
	});

	it.each([
		['a missing next', { kind: 'page', items: [] }],
		['a positional page', ['page', [], null]],
		['an extra field', { kind: 'page', items: [], next: null, extra: false }],
		['an extra summary field', { kind: 'page', items: [{ ...summary, title: 'x' }], next: null }],
		[
			'an unknown summary kind',
			{ kind: 'page', items: [{ ...summary, kind: 'notice' }], next: null },
		],
		['a non-UUIDv7 continuation', { kind: 'page', items: [], next: 'next' }],
		[
			'a summary with a bad time',
			{ kind: 'page', items: [{ ...summary, deadline: '2026-11-22T11:00Z' }], next: null },
		],
	])('list: %s', (_name, reply): void => {
		expect(approvalListReplySchema.safeParse(reply).success).toBe(false);
	});

	it.each([
		['an unknown view kind', { kind: 'request', view: { ...providerApproval, kind: 'notice' } }],
		['an extra view field', { kind: 'request', view: { ...providerApproval, extra: 1 } }],
		[
			'an extra offer field',
			{
				kind: 'request',
				view: { ...providerApproval, offer: { ...providerApproval.offer, icon: 'x' } },
			},
		],
		[
			'an omitted nullable description',
			{
				kind: 'request',
				view: { ...providerApproval, offer: { title: 'x', subject: null, options: [] } },
			},
		],
		[
			'a title past 200 characters',
			{
				kind: 'request',
				view: { ...providerApproval, offer: { ...providerApproval.offer, title: 'é'.repeat(201) } },
			},
		],
		[
			'a file kept for a turn',
			{
				kind: 'request',
				view: {
					...providerApproval,
					offer: {
						...providerApproval.offer,
						options: [
							{
								id: 1,
								label: 'x',
								effect: 'allow',
								lasts: { kind: 'thisTurn', kept: 'agentRulesFile' },
							},
						],
					},
				},
			},
		],
		[
			'a deadline not one hour after first save',
			{
				kind: 'request',
				view: {
					...providerApproval,
					window: { raisedAt: window.raisedAt, deadline: '2026-11-22T11:00:01Z' },
				},
			},
		],
		[
			'a deadline with a different fraction',
			{
				kind: 'request',
				view: {
					...providerApproval,
					window: { raisedAt: '2026-11-22T10:00:00.001Z', deadline: '2026-11-22T11:00:00Z' },
				},
			},
		],
		[
			'a question number with a leading zero',
			{
				kind: 'request',
				view: {
					...providerQuestion,
					state: {
						...providerQuestion.state,
						ending: {
							kind: 'giver',
							decision: {
								by: person,
								answer: {
									kind: 'answered',
									fields: [{ fieldId: 1, value: { kind: 'number', value: '01' } }],
								},
							},
						},
					},
				},
			},
		],
		[
			'a field id past 32',
			{
				kind: 'request',
				view: {
					...providerQuestion,
					offer: {
						prompt: 'p',
						fields: [
							{ kind: 'boolean', fieldId: 33, label: 'x', description: null, required: true },
						],
					},
				},
			},
		],
		[
			'an empty working folder',
			{
				kind: 'request',
				view: {
					...unprovenCall,
					offer: { operation: { ...unprovenCall.offer.operation, workingFolder: '' } },
				},
			},
		],
		[
			'a parked call without its delivery',
			{
				kind: 'request',
				view: {
					...unprovenCall,
					state: { kind: 'ended', ending: { kind: 'timedOut' }, endedAt: window.deadline },
				},
			},
		],
		['notVisible carrying a reason', { kind: 'notVisible', reason: 'missing' }],
	])('read: %s', (_name, reply): void => {
		expect(approvalReadReplySchema.safeParse(reply).success).toBe(false);
	});
});

describe('C3 request bodies', (): void => {
	it.each([
		{ organization, filter: 'waiting' },
		{ organization, filter: 'all', cursor: null },
		{ organization, filter: 'all', cursor: requestId },
	])('list body %#: the cursor may be absent, null or an id', (body): void => {
		const parsed = approvalPersonRequestBodySchemas.ApprovalList.safeParse(body);
		expect(parsed.success && parsed.data).toEqual(body);
	});

	it('read and decide bodies parse unchanged', (): void => {
		const read = { organization, requestId };
		const decide = {
			organization,
			requestId,
			operationId,
			answer: { kind: 'approval', optionId: 2 },
		};
		expect(approvalPersonRequestBodySchemas.ApprovalRead.parse(read)).toEqual(read);
		expect(approvalPersonRequestBodySchemas.ApprovalDecide.parse(decide)).toEqual(decide);
	});

	it.each([
		['an unknown list filter', 'ApprovalList', { organization, filter: 'mine' }],
		[
			'a list body naming its operation',
			'ApprovalList',
			{ organization, filter: 'all', operation: 'ApprovalList' },
		],
		['a positional list body', 'ApprovalList', [organization, 'waiting', null]],
		['a read body without its request', 'ApprovalRead', { organization }],
		[
			'a decide body whose operation id is not UUIDv7',
			'ApprovalDecide',
			{
				organization,
				requestId,
				operationId: 'retry-1',
				answer: { kind: 'approval', optionId: 1 },
			},
		],
		[
			'a decide body with an unknown answer kind',
			'ApprovalDecide',
			{ organization, requestId, operationId, answer: { kind: 'maybe' } },
		],
		[
			'a decide body with an extra answer field',
			'ApprovalDecide',
			{
				organization,
				requestId,
				operationId,
				answer: { kind: 'approval', optionId: 1, note: 'x' },
			},
		],
	] as const)('refuses %s', (_name, operation, body): void => {
		expect(approvalPersonRequestBodySchemas[operation].safeParse(body).success).toBe(false);
	});
});

describe("central's own specimen literals (contract-fixtures/central-person-approvals)", (): void => {
	const literalsSchema = z.strictObject({
		source: z.string(),
		accepted: z.strictObject({ ApprovalListReply: z.array(z.string()).min(1) }),
		refused: z.strictObject({
			ApprovalListReply: z.array(z.string()).min(1),
			ApprovalDecideReply: z.array(z.string()).min(1),
			ApprovalListRequest: z.array(z.string()).min(1),
		}),
	});
	async function specimenLiterals(): Promise<z.output<typeof literalsSchema>> {
		const text = await readFile(
			new URL(
				'../../contract-fixtures/central-person-approvals/specimen-literals.json',
				import.meta.url,
			),
			'utf8',
		);
		return literalsSchema.parse(JSON.parse(text));
	}

	it('accepts the last page central accepts, unchanged', async (): Promise<void> => {
		// Arrange
		const literals = await specimenLiterals();
		for (const bytes of literals.accepted.ApprovalListReply) {
			// Act
			const parsed = approvalListReplySchema.safeParse(JSON.parse(bytes));
			// Assert
			expect(parsed.success && parsed.data).toEqual(JSON.parse(bytes));
		}
	});

	it('refuses every body central refuses', async (): Promise<void> => {
		// Arrange
		const { refused } = await specimenLiterals();
		const checks = [
			...refused.ApprovalListReply.map((bytes) =>
				approvalListReplySchema.safeParse(JSON.parse(bytes)),
			),
			...refused.ApprovalDecideReply.map((bytes) =>
				approvalDecideReplySchema.safeParse(JSON.parse(bytes)),
			),
			...refused.ApprovalListRequest.map((bytes) =>
				approvalPersonRequestBodySchemas.ApprovalList.safeParse(JSON.parse(bytes)),
			),
		];
		// Act / Assert
		expect(checks.map((check) => check.success)).toEqual(checks.map(() => false));
		expect(checks).toHaveLength(6);
	});
});
