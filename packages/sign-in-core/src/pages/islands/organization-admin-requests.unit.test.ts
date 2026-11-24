import { expect, it } from 'vitest';

import { fleetAdminResultSchemas } from '#sign-in-core/central-link/fleet-admin-client';
import { fleetAdminForwardingPaths } from '#sign-in-core/contracts/fleet-admin-wire';
import {
	createWorkspace,
	describeChangeRecord,
	freshOperationId,
	readChangeRecords,
	type SendForwardedRequest,
} from '#sign-in-core/pages/islands/organization-admin-requests';

const organizationId = '019a3dce-2000-7000-8000-0000000000a1';
const operationId = '019a3dce-2000-7000-8000-0000000000a2';
const workspaceId = '019a3dce-2000-7000-8000-0000000000a3';

function answering(response: Response): {
	readonly send: SendForwardedRequest;
	readonly sent: { path: string; body: object }[];
} {
	const sent: { path: string; body: object }[] = [];
	return {
		sent,
		send: (path, body) => {
			sent.push({ path, body });
			return Promise.resolve(response);
		},
	};
}

const createRequest = { organizationId, operationId, name: 'Release tooling', description: '' };

it.each([
	[
		'an applied create',
		Response.json({
			result: 'applied',
			workspace: { workspaceId, name: 'Release tooling', description: '', state: 'active' },
		}),
		'answered',
	],
	[
		'a second-factor request',
		Response.json({ result: 'refused', reason: 'secondFactorRequired' }),
		'confirm-again',
	],
	['another refusal', Response.json({ result: 'refused', reason: 'nameInUse' }), 'refused'],
	[
		'a forwarder failure',
		Response.json({ error: 'central-unavailable' }, { status: 503 }),
		'unavailable',
	],
	['an unparseable reply', Response.json({ result: 'unexpected' }), 'unavailable'],
] as const)('classifies %s as %s', async (_case, response, kind) => {
	// Arrange
	const transport = answering(response);

	// Act
	const outcome = await createWorkspace(createRequest, transport.send);

	// Assert
	expect(outcome.kind).toBe(kind);
	expect(transport.sent).toEqual([
		{ path: fleetAdminForwardingPaths.CreateWorkspace, body: createRequest },
	]);
});

it('reads the first page of change records through the forwarding route', async () => {
	// Arrange
	const transport = answering(Response.json({ result: 'records', records: [] }));

	// Act
	const outcome = await readChangeRecords({ organizationId }, transport.send);

	// Assert
	expect(outcome).toEqual({ kind: 'answered', result: { result: 'records', records: [] } });
	expect(transport.sent).toEqual([
		{
			path: fleetAdminForwardingPaths.ReadChangeRecords,
			body: { organizationId, after: null, limit: 100 },
		},
	]);
});

it('labels each change record with the origin it names: the person and permission, automatic in Central, or sign-in', () => {
	// Arrange
	const createdAtMillis = Date.UTC(2026, 10, 22, 9, 30);
	const base = {
		kind: 'organizationProvisioned',
		requestId: 'request-1',
		targetId: organizationId,
		createdAtMillis,
	};
	const records = [
		{ ...base, id: '019a3dce-2000-7000-8000-0000000000b1', origin: { kind: 'signInProvisioning' } },
		{
			...base,
			id: '019a3dce-2000-7000-8000-0000000000b2',
			origin: { kind: 'person', personId: 'person-owner', permissionChecked: 'machine:enroll' },
		},
		{ ...base, id: '019a3dce-2000-7000-8000-0000000000b3', origin: { kind: 'automatic' } },
	];
	const parsed = fleetAdminResultSchemas.ReadChangeRecords.parse({ result: 'records', records });
	if (parsed.result !== 'records') throw new Error('Change record fixture did not parse');

	// Act
	const rows = parsed.records.map(describeChangeRecord);

	// Assert
	expect(rows.map(({ when, change, subject, origin }) => [when, change, subject, origin])).toEqual([
		['2026-11-22T09:30:00.000Z', 'organizationProvisioned', organizationId, 'Sign-in'],
		[
			'2026-11-22T09:30:00.000Z',
			'organizationProvisioned',
			organizationId,
			'person-owner (machine:enroll)',
		],
		[
			'2026-11-22T09:30:00.000Z',
			'organizationProvisioned',
			organizationId,
			'Central, automatically',
		],
	]);
});

it('mints a UUIDv7 whose time prefix is the given clock', () => {
	// Act
	const id = freshOperationId(
		(bytes) => bytes.fill(0xff),
		() => 0x0192_3456_789a,
	);

	// Assert
	expect(id).toBe('01923456-789a-7fff-bfff-ffffffffffff');
});
