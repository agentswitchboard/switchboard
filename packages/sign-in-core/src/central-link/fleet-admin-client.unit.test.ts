import { readFile } from 'node:fs/promises';

import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	createFleetAdminLinkClient,
	fleetAdminResultSchemas,
} from '#sign-in-core/central-link/fleet-admin-client';
import { organizationChangeFixtures } from '#sign-in-core/central-link/generated/organization-change-fixtures';
import {
	fleetAdminRequestBody,
	fleetAdminRoutePaths,
	type FleetAdminRequest,
} from '#sign-in-core/organizations/fleet-admin-operation';

const organizationId = '019a3dce-2000-7000-8000-000000000001';
const create: FleetAdminRequest = {
	operation: 'CreateWorkspace',
	organizationId,
	operationId: '019a3dce-2000-7000-8000-000000000004',
	name: 'research',
	description: '',
};
const workspace = {
	workspaceId: '019a3dce-2000-7000-8000-000000000005',
	name: 'research',
	description: '',
	state: 'active',
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

it('sends the DPoP token, the proof and the closed body to the route the operation names', async (): Promise<void> => {
	// Arrange
	const transport = scripted(async () => Response.json({ result: 'applied', workspace }));
	// Act
	const answer = await createFleetAdminLinkClient(transport).sendFleetAdminRequest({
		operation: create,
		accessToken: 'token',
		proof: 'proof',
	});
	// Assert
	expect(answer).toEqual({
		kind: 'answered',
		result: { result: 'applied', workspace },
	});
	const request = transport.sent[0];
	if (request === undefined) throw new Error('No admin request sent');
	expect(new URL(request.url).pathname).toBe('/organization-admin/v1/create-workspace');
	expect(request.headers.get('authorization')).toBe('DPoP token');
	expect(request.headers.get('dpop')).toBe('proof');
	expect(await request.json()).toEqual({
		organizationId,
		operationId: create.operationId,
		name: 'research',
		description: '',
	});
});

const operations: Readonly<Record<FleetAdminRequest['operation'], FleetAdminRequest>> = {
	CreateWorkspace: create,
	WorkspaceLookup: {
		operation: 'WorkspaceLookup',
		organizationId,
		workspaceId: workspace.workspaceId,
	},
	ReadChangeRecords: { operation: 'ReadChangeRecords', organizationId, after: null, limit: 10 },
};
/** Which route may answer each result tag; a refusal can come from any of them. */
const routesForResult: Readonly<Record<string, readonly FleetAdminRequest['operation'][]>> = {
	applied: ['CreateWorkspace'],
	found: ['WorkspaceLookup'],
	records: ['ReadChangeRecords'],
	refused: ['CreateWorkspace', 'WorkspaceLookup', 'ReadChangeRecords'],
};
async function producerResults(kind: 'fixtures' | 'negatives'): Promise<readonly unknown[]> {
	return z
		.array(z.unknown())
		.min(1)
		.parse(
			JSON.parse(
				await readFile(
					new URL(
						`../../contract-fixtures/central-organization-admin/OrganizationAdminResult.${kind}.json`,
						import.meta.url,
					),
					'utf8',
				),
			),
		);
}
const resultFixtures = await producerResults('fixtures');
const resultNegatives = await producerResults('negatives');

it.each(
	organizationChangeFixtures.map(
		(record) =>
			[
				record.kind === 'machineAllowanceChanged' ? `${record.kind} ${record.state}` : record.kind,
				record,
			] as const,
	),
)('reads the Central change record fixture for %s', (_label, record): void => {
	const reply = { result: 'records', records: [record] };
	expect(fleetAdminResultSchemas.ReadChangeRecords.parse(reply)).toEqual(reply);
	const invalidKind = { ...reply, records: [{ ...record, kind: 'unrecognized-change-kind' }] };
	expect(fleetAdminResultSchemas.ReadChangeRecords.safeParse(invalidKind).success).toBe(false);
	const invalidOrigin = {
		...reply,
		records: [{ ...record, origin: { kind: 'unrecognized-origin' } }],
	};
	expect(fleetAdminResultSchemas.ReadChangeRecords.safeParse(invalidOrigin).success).toBe(false);
	const wrongFields =
		record.kind === 'machineAllowanceChanged'
			? { ...record, targetId: record.workspaceId }
			: { ...record, workspaceId: record.targetId };
	expect(
		fleetAdminResultSchemas.ReadChangeRecords.safeParse({ ...reply, records: [wrongFields] })
			.success,
	).toBe(false);
	if (record.kind === 'machineAllowanceChanged') {
		const invalidState = { ...record, state: 'unrecognized-allowance-state' };
		expect(
			fleetAdminResultSchemas.ReadChangeRecords.safeParse({ ...reply, records: [invalidState] })
				.success,
		).toBe(false);
	}
});

it.each(Object.values(operations))(
	'$operation is sent to its own route with its closed body',
	async (operation): Promise<void> => {
		const transport = scripted(async () => new Response(null, { status: 503 }));
		await createFleetAdminLinkClient(transport).sendFleetAdminRequest({
			operation,
			accessToken: 'token',
			proof: 'proof',
		});
		const request = transport.sent[0];
		if (request === undefined) throw new Error('No admin request sent');
		expect(new URL(request.url).pathname).toBe(fleetAdminRoutePaths[operation.operation]);
		expect(await request.json()).toEqual(fleetAdminRequestBody(operation));
	},
);

it.each(resultFixtures.map((fixture) => [JSON.stringify(fixture).slice(0, 80), fixture]))(
	'parses central producer result %s on each route that may answer it, and refuses it elsewhere',
	async (_label, fixture): Promise<void> => {
		const tag = z.object({ result: z.string() }).parse(fixture).result;
		const allowed = routesForResult[tag] ?? [];
		expect(allowed.length).toBeGreaterThan(0);
		for (const operation of Object.values(operations)) {
			const transport = scripted(async () => Response.json(fixture));
			const answer = await createFleetAdminLinkClient(transport).sendFleetAdminRequest({
				operation,
				accessToken: 'token',
				proof: 'proof',
			});
			expect(answer).toEqual(
				allowed.includes(operation.operation)
					? { kind: 'answered', result: fixture }
					: { kind: 'unknown', reason: 'malformed-reply' },
			);
		}
	},
);

it.each(resultNegatives.map((negative) => [JSON.stringify(negative).slice(0, 80), negative]))(
	'refuses central producer negative %s on every route',
	async (_label, negative): Promise<void> => {
		for (const operation of Object.values(operations)) {
			const transport = scripted(async () => Response.json(negative));
			await expect(
				createFleetAdminLinkClient(transport).sendFleetAdminRequest({
					operation,
					accessToken: 'token',
					proof: 'proof',
				}),
			).resolves.toEqual({ kind: 'unknown', reason: 'malformed-reply' });
		}
	},
);

it.each([
	{ status: 401, body: '', expected: { kind: 'unauthenticated' } },
	{ status: 400, body: '', expected: { kind: 'request-refused' } },
	// WS7 R-notdue: central's own 503 (the pinned unstamped-store answer) is kept apart.
	{ status: 503, body: '', expected: { kind: 'answered-unavailable' } },
	{ status: 500, body: '', expected: { kind: 'unknown', reason: 'unavailable' } },
	{
		status: 200,
		body: '{"result":"applied"}',
		expected: { kind: 'unknown', reason: 'malformed-reply' },
	},
	{
		status: 200,
		body: '{"result":"refused","reason":"invented"}',
		expected: { kind: 'unknown', reason: 'malformed-reply' },
	},
])('maps $status $body to its own outcome', async ({ status, body, expected }): Promise<void> => {
	const transport = scripted(async () => new Response(body === '' ? null : body, { status }));
	await expect(
		createFleetAdminLinkClient(transport).sendFleetAdminRequest({
			operation: create,
			accessToken: 'token',
			proof: 'proof',
		}),
	).resolves.toEqual(expected);
});

it('keeps a transport failure unknown, never as central having answered 503', async (): Promise<void> => {
	const transport = scripted(async () => {
		throw new Error('Link closed before central answered');
	});
	await expect(
		createFleetAdminLinkClient(transport).sendFleetAdminRequest({
			operation: create,
			accessToken: 'token',
			proof: 'proof',
		}),
	).resolves.toEqual({ kind: 'unknown', reason: 'unavailable' });
});

it.each(['send', 'relay'] as const)(
	'R-retrysignal: a given signal reaches the link request on %s and aborts it; without one the request carries none',
	async (method): Promise<void> => {
		// Arrange
		const transport = scripted(async () => new Response(null, { status: 503 }));
		const client = createFleetAdminLinkClient(transport);
		const deadline = new AbortController();
		const request = async (signal?: AbortSignal): Promise<unknown> =>
			method === 'send'
				? client.sendFleetAdminRequest({
						operation: create,
						accessToken: 'token',
						proof: 'proof',
						...(signal === undefined ? {} : { signal }),
					})
				: client.relayFleetAdminRequest({
						operation: 'CreateWorkspace',
						authorization: 'DPoP token',
						proof: 'proof',
						body: new TextEncoder().encode('{}') as Uint8Array<ArrayBuffer>,
						...(signal === undefined ? {} : { signal }),
					});
		// Act
		await request();
		await request(deadline.signal);
		deadline.abort(new DOMException('Run deadline', 'TimeoutError'));
		// Assert: only the request given the deadline is aborted by it.
		const [first, retry] = transport.sent;
		expect(first?.signal.aborted).toBe(false);
		expect(retry?.signal.aborted).toBe(true);
	},
);

it('reads a mixed page of every Central change kind and keeps the record vocabulary closed', async (): Promise<void> => {
	const base = {
		id: '019a3dce-2000-7000-8000-000000000006',
		requestId: 'central-test-record',
		targetId: workspace.workspaceId,
		createdAtMillis: 1_800_000_000_000,
	};
	const person = {
		kind: 'person',
		personId: organizationId,
		permissionChecked: 'workspace:create',
	};
	const automatic = { kind: 'automatic' };
	const records = [
		{ ...base, kind: 'organizationProvisioned', origin: { kind: 'signInProvisioning' } },
		{ ...base, kind: 'stampRenewed', origin: { kind: 'signInProvisioning' } },
		{ ...base, kind: 'workspaceCreated', origin: person },
		{ ...base, kind: 'machineEnrolled', origin: person },
		{ ...base, kind: 'machineRevoked', origin: person },
		{ ...base, kind: 'machineExpired', origin: automatic },
		{ ...base, kind: 'allowanceChanged', origin: person },
	];

	function read(
		replyRecords: readonly unknown[],
	): ReturnType<ReturnType<typeof createFleetAdminLinkClient>['sendFleetAdminRequest']> {
		const reply = { result: 'records', records: replyRecords };
		const transport = scripted(async () => Response.json(reply));
		return createFleetAdminLinkClient(transport).sendFleetAdminRequest({
			operation: operations.ReadChangeRecords,
			accessToken: 'test-token',
			proof: 'test-proof',
		});
	}

	await expect(read(records)).resolves.toEqual({
		kind: 'answered',
		result: { result: 'records', records },
	});
	await expect(
		read([...records, { ...base, kind: 'unrecognized', origin: person }]),
	).resolves.toEqual({
		kind: 'unknown',
		reason: 'malformed-reply',
	});
	await expect(
		read([{ ...base, kind: 'machineExpired', origin: { kind: 'unrecognized' } }]),
	).resolves.toEqual({
		kind: 'unknown',
		reason: 'malformed-reply',
	});
	await expect(
		read([{ ...base, kind: 'machineExpired', origin: { ...automatic, personId: organizationId } }]),
	).resolves.toEqual({
		kind: 'unknown',
		reason: 'malformed-reply',
	});
});

const storedRecord = {
	id: '019a3dce-2000-7000-8000-000000000006',
	requestId: 'é'.repeat(64),
	kind: 'workspaceCreated',
	origin: { kind: 'person', personId: 'opaque-person', permissionChecked: 'workspace:create' },
	targetId: 'opaque-target',
	createdAtMillis: 1_800_000_000_000,
};

async function readRecord(record: unknown): Promise<unknown> {
	const transport = scripted(async () => Response.json({ result: 'records', records: [record] }));
	return createFleetAdminLinkClient(transport).sendFleetAdminRequest({
		operation: operations.ReadChangeRecords,
		accessToken: 'test-token',
		proof: 'test-proof',
	});
}

it('accepts opaque change-record identities and a request identity of 128 UTF-8 bytes', async (): Promise<void> => {
	await expect(readRecord(storedRecord)).resolves.toEqual({
		kind: 'answered',
		result: { result: 'records', records: [storedRecord] },
	});
});

it.each([
	{
		field: 'record id version',
		record: { ...storedRecord, id: '019a3dce-2000-4000-8000-000000000006' },
	},
	{ field: 'record id spelling', record: { ...storedRecord, id: storedRecord.id.toUpperCase() } },
	{ field: 'target identity', record: { ...storedRecord, targetId: '' } },
	{
		field: 'person identity',
		record: { ...storedRecord, origin: { ...storedRecord.origin, personId: '' } },
	},
	{
		field: 'checked permission',
		record: { ...storedRecord, origin: { ...storedRecord.origin, permissionChecked: '' } },
	},
	{ field: 'empty request identity', record: { ...storedRecord, requestId: '' } },
	{ field: 'request identity byte length', record: { ...storedRecord, requestId: 'é'.repeat(65) } },
	{ field: 'NUL in request identity', record: { ...storedRecord, requestId: 'request\0identity' } },
])('rejects a Central change record with invalid $field', async ({ record }): Promise<void> => {
	await expect(readRecord(record)).resolves.toEqual({ kind: 'unknown', reason: 'malformed-reply' });
});
