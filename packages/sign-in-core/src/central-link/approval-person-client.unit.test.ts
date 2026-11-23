import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApprovalPersonLinkClient } from '#sign-in-core/central-link/approval-person-client';
import type { ApprovalPersonOperation } from '#sign-in-core/organizations/approval-person-operation';

const organization = '019a3dce-2000-7000-8000-000000000001';
const requestId = '019a3dce-2000-7000-8000-000000000002';
const operationId = '019a3dce-2000-7000-8000-000000000003';
const list: ApprovalPersonOperation = {
	operation: 'ApprovalList',
	organization,
	filter: 'waiting',
	cursor: null,
};
const decide: ApprovalPersonOperation = {
	operation: 'ApprovalDecide',
	organization,
	requestId,
	operationId,
	answer: { kind: 'unprovenCall', decision: 'allow' },
};

function scripted(reply: () => Promise<Response>): {
	readonly sent: Request[];
	readonly fetch: (request: Request) => Promise<Response>;
} {
	const sent: Request[] = [];
	return {
		sent,
		fetch: async (request: Request): Promise<Response> => {
			sent.push(request);
			return reply();
		},
	};
}

// Central's committed reply bytes (contract-fixtures/central-person-approvals, central main 1ede5c1b9).
const centralReplies = z
	.strictObject({
		ApprovalListReply: z.array(z.string()).min(1),
		ApprovalReadReply: z.array(z.string()).min(1),
		ApprovalDecideReply: z.array(z.string()).min(1),
	})
	.parse(
		JSON.parse(
			await readFile(
				new URL(
					'../../contract-fixtures/central-person-approvals/approval-person-reply-vectors.json',
					import.meta.url,
				),
				'utf8',
			),
		),
	);

describe('sending a C3 operation over the private link', (): void => {
	it('posts the closed body with the DPoP token and proof to central path', async (): Promise<void> => {
		// Arrange
		const transport = scripted(async () => Response.json({ kind: 'page', items: [], next: null }));
		// Act
		const answer = await createApprovalPersonLinkClient(transport).sendApprovalPersonRequest({
			operation: list,
			accessToken: 'token',
			proof: 'proof',
		});
		// Assert
		expect(answer).toEqual({ kind: 'replied', reply: { kind: 'page', items: [], next: null } });
		const request = transport.sent[0];
		if (request === undefined) throw new Error('No request sent');
		expect(request.method).toBe('POST');
		expect(new URL(request.url).pathname).toBe('/organization-admin/v1/approval-list');
		expect(request.headers.get('authorization')).toBe('DPoP token');
		expect(request.headers.get('dpop')).toBe('proof');
		expect(await request.json()).toEqual({ organization, filter: 'waiting' });
	});

	it('relays the CLI bytes and headers unchanged', async (): Promise<void> => {
		// Arrange
		const transport = scripted(async () => Response.json({ kind: 'tooLate' }));
		const body = new TextEncoder().encode(' {"organization":"x"} ');
		// Act
		const answer = await createApprovalPersonLinkClient(transport).relayApprovalPersonRequest({
			operation: 'ApprovalDecide',
			authorization: 'DPoP cli-token',
			proof: 'cli-proof',
			body,
		});
		// Assert
		expect(answer).toEqual({ kind: 'replied', reply: { kind: 'tooLate' } });
		const request = transport.sent[0];
		if (request === undefined) throw new Error('No request relayed');
		expect(new URL(request.url).pathname).toBe('/organization-admin/v1/approval-decide');
		expect(request.headers.get('authorization')).toBe('DPoP cli-token');
		expect(request.headers.get('dpop')).toBe('cli-proof');
		expect(new Uint8Array(await request.arrayBuffer())).toEqual(body);
	});

	it.each([
		['ApprovalList', centralReplies.ApprovalListReply],
		['ApprovalRead', centralReplies.ApprovalReadReply],
		['ApprovalDecide', centralReplies.ApprovalDecideReply],
	] as const)(
		'%s: every central reply vector is a reply',
		async (operation, vectors): Promise<void> => {
			for (const bytes of vectors) {
				const transport = scripted(async () => new Response(bytes, { status: 200 }));
				const answer = await createApprovalPersonLinkClient(transport).relayApprovalPersonRequest({
					operation,
					authorization: 'DPoP token',
					proof: 'proof',
					body: new Uint8Array(),
				});
				expect(answer).toEqual({ kind: 'replied', reply: JSON.parse(bytes) });
			}
		},
	);
});

describe("central's statuses and refusals, read through its result matrix", (): void => {
	it.each([
		'notPermitted',
		'refreshRequired',
		'authorizationSyncRequired',
		'expired',
		'requestTime',
		'requestReused',
	])('200 with the admin envelope %s is a refusal', async (reason): Promise<void> => {
		const transport = scripted(async () => Response.json({ result: 'refused', reason }));
		await expect(
			createApprovalPersonLinkClient(transport).sendApprovalPersonRequest({
				operation: decide,
				accessToken: 'token',
				proof: 'proof',
			}),
		).resolves.toEqual({ kind: 'refused', reason });
	});

	it.each([
		[401, { kind: 'unauthenticated' }],
		[400, { kind: 'request-refused' }],
		[405, { kind: 'method-refused' }],
		[503, { kind: 'answered-unavailable' }],
		[500, { kind: 'unknown', reason: 'unavailable' }],
		[404, { kind: 'unknown', reason: 'unavailable' }],
		[302, { kind: 'unknown', reason: 'unavailable' }],
	] as const)('an empty %i is %j', async (status, expected): Promise<void> => {
		const transport = scripted(async () => new Response(null, { status }));
		await expect(
			createApprovalPersonLinkClient(transport).sendApprovalPersonRequest({
				operation: list,
				accessToken: 'token',
				proof: 'proof',
			}),
		).resolves.toEqual(expected);
	});

	it.each([
		[
			'a second-factor refusal C3 never sends',
			{ result: 'refused', reason: 'secondFactorRequired' },
		],
		['an admin refusal outside C3', { result: 'refused', reason: 'nameInUse' }],
		['the removed factorRequired reply', { kind: 'factorRequired', withinSeconds: 900 }],
		['a list reply to a decide', { kind: 'page', items: [], next: null }],
		['an unknown decide kind', { kind: 'maybe' }],
	])('200 with %s is a malformed reply', async (_name, body): Promise<void> => {
		const transport = scripted(async () => Response.json(body));
		await expect(
			createApprovalPersonLinkClient(transport).sendApprovalPersonRequest({
				operation: decide,
				accessToken: 'token',
				proof: 'proof',
			}),
		).resolves.toEqual({ kind: 'unknown', reason: 'malformed-reply' });
	});

	it('200 with a body that is not JSON is a malformed reply', async (): Promise<void> => {
		const transport = scripted(async () => new Response('not json', { status: 200 }));
		await expect(
			createApprovalPersonLinkClient(transport).sendApprovalPersonRequest({
				operation: decide,
				accessToken: 'token',
				proof: 'proof',
			}),
		).resolves.toEqual({ kind: 'unknown', reason: 'malformed-reply' });
	});

	it.each([
		[new DOMException('deadline', 'TimeoutError'), 'timeout'],
		[new TypeError('connection refused'), 'unavailable'],
	] as const)('a link that fails with %s is unknown (%s)', async (error, reason): Promise<void> => {
		const transport = scripted(async () => Promise.reject(error));
		await expect(
			createApprovalPersonLinkClient(transport).sendApprovalPersonRequest({
				operation: decide,
				accessToken: 'token',
				proof: 'proof',
			}),
		).resolves.toEqual({ kind: 'unknown', reason });
	});
});
