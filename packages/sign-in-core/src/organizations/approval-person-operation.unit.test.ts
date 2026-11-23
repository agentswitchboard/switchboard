import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '#sign-in-core/contracts/canonical-json';
import {
	approvalPersonIntent,
	approvalPersonIntentDigest,
	approvalPersonOperationSchema,
	approvalPersonRequestBody,
	approvalPersonRequestBodySchemas,
	approvalPersonRoutePaths,
	type ApprovalPersonOperation,
} from '#sign-in-core/organizations/approval-person-operation';

const organization = '019a3dce-2000-7000-8000-000000000001';
const requestId = '019a3dce-2000-7000-8000-0000000000c1';
const operationId = '019a3dce-2000-7000-8000-0000000000f1';

/** An oracle independent of sign-in's builder: node's SHA-256, base64url without padding. */
function independentDigest(canonical: string): string {
	return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

// Expected strings are written by hand from central's `ApprovalPersonOperation::intent`
// (approval_person_wire.rs at 8670195): RFC 8785 member order, no whitespace.
const cases: readonly {
	readonly name: string;
	readonly operation: ApprovalPersonOperation;
	readonly path: string;
	readonly body: unknown;
	readonly canonical: string;
}[] = [
	{
		name: 'the first waiting page',
		operation: { operation: 'ApprovalList', organization, filter: 'waiting', cursor: null },
		path: '/organization-admin/v1/approval-list',
		body: { organization, filter: 'waiting' },
		canonical: `{"operation":"ApprovalList","operationId":null,"organization":"${organization}","params":{"cursor":null,"filter":"waiting"},"target":"${organization}","v":1}`,
	},
	{
		name: 'a later page of all requests',
		operation: { operation: 'ApprovalList', organization, filter: 'all', cursor: requestId },
		path: '/organization-admin/v1/approval-list',
		body: { organization, filter: 'all', cursor: requestId },
		canonical: `{"operation":"ApprovalList","operationId":null,"organization":"${organization}","params":{"cursor":"${requestId}","filter":"all"},"target":"${organization}","v":1}`,
	},
	{
		name: 'a read',
		operation: { operation: 'ApprovalRead', organization, requestId },
		path: '/organization-admin/v1/approval-read',
		body: { organization, requestId },
		canonical: `{"operation":"ApprovalRead","operationId":null,"organization":"${organization}","params":{},"target":"${requestId}","v":1}`,
	},
	{
		name: 'a decide answering a question',
		operation: {
			operation: 'ApprovalDecide',
			organization,
			requestId,
			operationId,
			answer: {
				kind: 'question',
				answer: {
					kind: 'answered',
					fields: [
						{ fieldId: 2, value: { kind: 'number', value: '-1.50' } },
						{ fieldId: 1, value: { kind: 'text', value: 'Café 🚀' } },
					],
				},
			},
		},
		path: '/organization-admin/v1/approval-decide',
		body: {
			organization,
			requestId,
			operationId,
			answer: {
				kind: 'question',
				answer: {
					kind: 'answered',
					fields: [
						{ fieldId: 2, value: { kind: 'number', value: '-1.50' } },
						{ fieldId: 1, value: { kind: 'text', value: 'Café 🚀' } },
					],
				},
			},
		},
		canonical: `{"operation":"ApprovalDecide","operationId":"${operationId}","organization":"${organization}","params":{"answer":{"answer":{"fields":[{"fieldId":2,"value":{"kind":"number","value":"-1.50"}},{"fieldId":1,"value":{"kind":"text","value":"Café 🚀"}}],"kind":"answered"},"kind":"question"}},"target":"${requestId}","v":1}`,
	},
];

describe('C3 canonical intents through the admin frame and digest', (): void => {
	it.each(cases)(
		'$name: route, body, canonical bytes and digest',
		async (vector): Promise<void> => {
			// Arrange
			const operation = approvalPersonOperationSchema.parse(vector.operation);
			// Act
			const intent = approvalPersonIntent(operation);
			const body = approvalPersonRequestBody(operation);
			// Assert
			expect(approvalPersonRoutePaths[operation.operation]).toBe(vector.path);
			expect(body).toEqual(vector.body);
			expect(approvalPersonRequestBodySchemas[operation.operation].safeParse(body).success).toBe(
				true,
			);
			expect(canonicalJson(intent)).toBe(vector.canonical);
			await expect(approvalPersonIntentDigest(globalThis.crypto, operation)).resolves.toBe(
				independentDigest(vector.canonical),
			);
		},
	);

	it('a step-up resend with a new operation id signs a different intent', async (): Promise<void> => {
		// Arrange
		const first: ApprovalPersonOperation = {
			operation: 'ApprovalDecide',
			organization,
			requestId,
			operationId,
			answer: { kind: 'approval', optionId: 1 },
		};
		const resend = { ...first, operationId: '019a3dce-2000-7000-8000-0000000000f2' };
		// Act
		const digests = await Promise.all(
			[first, resend].map((operation) => approvalPersonIntentDigest(globalThis.crypto, operation)),
		);
		// Assert
		expect(new Set(digests).size).toBe(2);
	});

	it.each([
		[
			'a list without its explicit cursor',
			{ operation: 'ApprovalList', organization, filter: 'all' },
		],
		[
			'a list whose cursor is not UUIDv7',
			{ operation: 'ApprovalList', organization, filter: 'all', cursor: 'page-2' },
		],
		[
			'a read carrying an operation id',
			{ operation: 'ApprovalRead', organization, requestId, operationId },
		],
		[
			'a decide without an operation id',
			{
				operation: 'ApprovalDecide',
				organization,
				requestId,
				answer: { kind: 'approval', optionId: 1 },
			},
		],
		['an admin operation', { operation: 'CreateWorkspace', organizationId: organization }],
	])('refuses %s', (_name, operation): void => {
		expect(approvalPersonOperationSchema.safeParse(operation).success).toBe(false);
	});
});
