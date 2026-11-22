import { expect, it } from 'vitest';

import { projectMachineDeviceResponse } from '#sign-in-core/response-release/machine-device-response';

const enrollmentId = '019a3dce-2000-7000-8000-0000000000b3';

it('projects the approved decision without any credentials or unrecognized fields', async (): Promise<void> => {
	const provider = Response.json(
		{
			enrollmentId,
			label: 'Proof Mac',
			allowedWorkspaces: [],
			access_token: 'synthetic-credential',
			refresh_token: 'synthetic-refresh',
		},
		{
			headers: {
				'set-cookie': 'synthetic_session=fixture',
				authorization: 'Bearer fixture',
				dpop: 'fixture-proof',
				'x-provider-credential': 'fixture',
			},
		},
	);
	const response = await projectMachineDeviceResponse('/api/auth/machine-login/approve', provider);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	for (const credentialHeader of ['set-cookie', 'authorization', 'dpop', 'x-provider-credential'])
		expect(response.headers.has(credentialHeader), credentialHeader).toBe(false);
	expect(await response.json()).toEqual({
		enrollmentId,
		label: 'Proof Mac',
		allowedWorkspaces: [],
	});
});

it('keeps the conflict reason without releasing unrelated provider fields', async (): Promise<void> => {
	const provider = Response.json(
		{
			error: 'access_denied',
			reason: { kind: 'requestConflict' },
			access_token: 'synthetic-credential',
		},
		{ status: 409 },
	);
	const response = await projectMachineDeviceResponse('/api/auth/machine-login/approve', provider);
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		error: 'access_denied',
		reason: { kind: 'requestConflict' },
	});
});

it('fails closed if an approval response cannot be projected', async (): Promise<void> => {
	const provider = Response.json({ access_token: 'synthetic-credential' });
	const response = await projectMachineDeviceResponse('/api/auth/machine-login/approve', provider);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
});
