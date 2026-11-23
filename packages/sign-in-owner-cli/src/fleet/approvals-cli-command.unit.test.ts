import { approvalPersonIntentDigest } from '@agent-collaboration/sign-in-core';
import { describe, expect, it } from 'vitest';

import {
	decideReplyWords,
	runApprovalsCommand,
	type ApprovalsCommandOptions,
} from '#sign-in-owner-cli/fleet/approvals-cli-command';
import {
	authTarget,
	decodeJwt,
	scenario,
	target,
} from '#sign-in-owner-cli/fleet/fleet-cli-test-world';

const organization = target.organizationId;
const requestId = '019a3dce-2000-7000-8000-0000000000c1';
const personId = '019a3dce-2000-7000-8000-0000000000d1';
const window = { raisedAt: '2026-11-23T12:00:00.007Z', deadline: '2026-11-23T13:00:00.007Z' };
const unprovenCallView = {
	kind: 'unprovenCall',
	requestId,
	offer: {
		operation: { kind: 'endSessionForGood', sessionId: '019a3dce-2000-7000-8000-0000000000e1' },
	},
	state: { kind: 'waiting' },
	window,
};
const providerApprovalView = {
	kind: 'providerApproval',
	requestId,
	offer: {
		title: 'Run the migration',
		description: null,
		subject: null,
		options: [{ id: 1, label: 'Allow once', effect: 'allow', lasts: { kind: 'thisRequest' } }],
	},
	state: { kind: 'waiting', status: 'pending' },
	window,
};
const readRequest = (view: object) => (): Response => Response.json({ kind: 'request', view });
const saved = (decision: 'allow' | 'decline') => (): Response =>
	Response.json({
		kind: 'savedDecision',
		decision: { by: { kind: 'person', personId }, answer: { kind: 'unprovenCall', decision } },
	});
const unavailable = (): Response =>
	Response.json({ error: 'central-unavailable' }, { status: 503 });

/** One `approvals` command through the real entry: printed lines, exit code and relay calls. */
async function approvals(
	args: readonly string[],
	relayReplies: readonly (() => Response)[],
	options: ApprovalsCommandOptions = {},
): Promise<{
	readonly exitCode: number;
	readonly lines: string[];
	readonly calls: { readonly path: string; readonly body: unknown; readonly proof: string }[];
}> {
	const world = await scenario(relayReplies);
	const lines: string[] = [];
	const exitCode = await runApprovalsCommand({
		arguments: args,
		target: authTarget,
		options,
		environment: {
			io: world.io,
			store: () => world.store,
			confirmSecondFactor: async () => {
				throw new Error('approvals never ask for a second factor');
			},
			write: (line) => lines.push(line),
		},
	});
	return {
		exitCode,
		lines,
		calls: world.relayCalls.map((call) => ({ ...call, body: JSON.parse(call.body) })),
	};
}

describe('approvals list', (): void => {
	it('lists waiting requests through the relay with a proof for central list route', async (): Promise<void> => {
		// Arrange
		const page = {
			kind: 'page',
			items: [{ requestId, kind: 'unprovenCall', state: { kind: 'waiting' }, ...window }],
			next: requestId,
		};
		// Act
		const result = await approvals(['list'], [() => Response.json(page)]);
		// Assert
		expect(result.exitCode).toBe(0);
		expect(result.lines).toEqual([
			`${requestId}  unproven call  waiting  raised ${window.raisedAt}  deadline ${window.deadline}`,
			`More: approvals list --cursor ${requestId}`,
		]);
		const [call] = result.calls;
		expect(call?.path).toBe('/api/auth/organization-admin/v1/approval-list');
		expect(call?.body).toEqual({ organization, filter: 'waiting' });
		const proof = decodeJwt(call?.proof ?? '');
		expect(proof['htu']).toBe(`${target.centralPublicOrigin}/organization-admin/v1/approval-list`);
		expect(proof['intent']).toBe(
			await approvalPersonIntentDigest(globalThis.crypto, {
				operation: 'ApprovalList',
				organization,
				filter: 'waiting',
				cursor: null,
			}),
		);
	});

	it('asks for every request after a cursor with --all --cursor', async (): Promise<void> => {
		const result = await approvals(
			['list'],
			[() => Response.json({ kind: 'page', items: [], next: null })],
			{ all: true, cursor: requestId },
		);
		expect(result.exitCode).toBe(0);
		expect(result.lines).toEqual(['No approval requests.']);
		expect(result.calls[0]?.body).toEqual({ organization, filter: 'all', cursor: requestId });
	});
});

describe('approvals show', (): void => {
	it('shows a request as central views it', async (): Promise<void> => {
		const result = await approvals(['show', requestId], [readRequest(unprovenCallView)]);
		expect(result.exitCode).toBe(0);
		expect(result.lines).toEqual([
			`${requestId}  unproven call  waiting`,
			JSON.stringify(unprovenCallView),
		]);
		expect(result.calls[0]?.body).toEqual({ organization, requestId });
	});

	it('says not found for a request the person may not see', async (): Promise<void> => {
		const result = await approvals(
			['show', requestId],
			[() => Response.json({ kind: 'notVisible' })],
		);
		expect(result).toMatchObject({ exitCode: 2, lines: ['Not found.'] });
	});
});

describe('approvals approve and deny', (): void => {
	it.each([
		['approve', 'allow'],
		['deny', 'decline'],
	] as const)(
		'%s reads the request, then decides %s with one minted operation id',
		async (verb, decision): Promise<void> => {
			// Act
			const result = await approvals(
				[verb, requestId],
				[readRequest(unprovenCallView), saved(decision)],
			);
			// Assert
			expect(result.exitCode).toBe(0);
			expect(result.lines).toEqual([`Decision saved: ${decision}.`]);
			expect(result.calls.map((call) => call.path)).toEqual([
				'/api/auth/organization-admin/v1/approval-read',
				'/api/auth/organization-admin/v1/approval-decide',
			]);
			const decide = result.calls[1];
			expect(decide?.body).toEqual({
				organization,
				requestId,
				operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/u),
				answer: { kind: 'unprovenCall', decision },
			});
			expect(decodeJwt(decide?.proof ?? '')['htu']).toBe(
				`${target.centralPublicOrigin}/organization-admin/v1/approval-decide`,
			);
		},
	);

	it('retries a decide that got no answer once, with a fresh proof and the same operation id', async (): Promise<void> => {
		// Act
		const result = await approvals(
			['approve', requestId],
			[readRequest(unprovenCallView), unavailable, saved('allow')],
		);
		// Assert
		expect(result.exitCode).toBe(0);
		const [, first, retry] = result.calls;
		expect(first?.body).toEqual(retry?.body);
		expect(decodeJwt(first?.proof ?? '')['jti']).not.toBe(decodeJwt(retry?.proof ?? '')['jti']);
	});

	it('names the operation id to repeat with when the retry gets no answer either', async (): Promise<void> => {
		const result = await approvals(
			['approve', requestId],
			[readRequest(unprovenCallView), unavailable, unavailable],
			{ 'operation-id': '019a3dce-2000-7000-8000-0000000000f1' },
		);
		expect(result.exitCode).toBe(1);
		expect(result.lines).toEqual([
			'Central did not answer. Repeat with --operation-id 019a3dce-2000-7000-8000-0000000000f1; it will not be decided twice.',
		]);
		expect(result.calls.slice(1).map((call) => call.body)).toEqual([
			expect.objectContaining({ operationId: '019a3dce-2000-7000-8000-0000000000f1' }),
			expect.objectContaining({ operationId: '019a3dce-2000-7000-8000-0000000000f1' }),
		]);
	});

	it('decides nothing for a provider approval it cannot express', async (): Promise<void> => {
		const result = await approvals(['approve', requestId], [readRequest(providerApprovalView)]);
		expect(result.exitCode).toBe(2);
		expect(result.lines).toEqual([
			'This request is a provider approval; the CLI cannot answer it yet. Nothing was decided.',
		]);
		expect(result.calls).toHaveLength(1);
	});

	it('decides nothing for a request the person may not see', async (): Promise<void> => {
		const result = await approvals(
			['deny', requestId],
			[() => Response.json({ kind: 'notVisible' })],
		);
		expect(result).toMatchObject({ exitCode: 2, lines: ['Not found.'] });
		expect(result.calls).toHaveLength(1);
	});

	it.each([
		['tooLate', { kind: 'tooLate' }],
		['operationConflict', { kind: 'operationConflict' }],
		[
			'alreadyDecided',
			{ kind: 'alreadyDecided', by: { kind: 'person', personId }, at: window.raisedAt },
		],
	])('a %s decide exits 2 with its words', async (_name, reply): Promise<void> => {
		const result = await approvals(
			['approve', requestId],
			[readRequest(unprovenCallView), () => Response.json(reply)],
		);
		expect(result.exitCode).toBe(2);
		expect(result.lines).toHaveLength(1);
	});
});

describe('outcome words', (): void => {
	it.each([
		[
			{
				kind: 'savedDecision',
				decision: {
					by: { kind: 'person', personId },
					answer: { kind: 'unprovenCall', decision: 'allow' },
				},
			},
			'Decision saved: allow.',
		],
		[
			{ kind: 'alreadyDecided', by: { kind: 'person', personId }, at: '2026-11-23T12:15:00.007Z' },
			`Already decided by person ${personId} at 2026-11-23T12:15:00.007Z; this answer was not saved.`,
		],
		[
			{
				kind: 'alreadyDecided',
				by: { kind: 'session', session: requestId },
				at: '2026-11-23T12:15:00Z',
			},
			`Already decided by session ${requestId} at 2026-11-23T12:15:00Z; this answer was not saved.`,
		],
		[{ kind: 'tooLate' }, 'Too late: the request timed out or was closed before an answer.'],
		[
			{ kind: 'invalid', reason: { kind: 'invalidAnswer', reason: { kind: 'wrongKind' } } },
			'Not accepted: the answer does not fit the request (wrongKind).',
		],
		[
			{
				kind: 'invalid',
				reason: { kind: 'invalidApprovalEnding', reason: { kind: 'bindingMismatch' } },
			},
			'Not accepted: central could not end the request (bindingMismatch).',
		],
		[{ kind: 'notVisible' }, 'Not found.'],
		[{ kind: 'operationConflict' }, 'This operation id was already used with a different answer.'],
	] as const)('%j', (reply, words): void => {
		expect(decideReplyWords(reply)).toBe(words);
	});

	it.each([
		[
			() => Response.json({ result: 'refused', reason: 'notPermitted' }),
			2,
			"Not permitted: answering approvals needs the organization owner's approval:decide.",
		],
		[
			() => Response.json({ result: 'refused', reason: 'requestReused' }),
			2,
			'Central refused (requestReused).',
		],
		[
			() => new Response(null, { status: 401 }),
			1,
			'Central refused the fleet credential; run fleet-login again.',
		],
		[unavailable, 1, 'Central did not answer. Repeat the command.'],
	] as const)('a list answered %#: exit %i, %s', async (reply, exitCode, words): Promise<void> => {
		const result = await approvals(['list'], [reply]);
		expect(result).toMatchObject({ exitCode, lines: [words] });
	});
});

describe('arguments', (): void => {
	it.each([
		[['list', requestId]],
		[['show']],
		[['show', 'not-a-uuid']],
		[['approve', requestId.toUpperCase()]],
		[['answer', requestId]],
	])('refuses %j before any request', async (args): Promise<void> => {
		await expect(approvals(args, [])).rejects.toThrow();
	});
});
