import { deviceCode, uuid7Schema } from '@agent-collaboration/sign-in-core';
import { fleetLoginDiscoveryResponseSchema } from '@agent-collaboration/sign-in-core/better-auth';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	organizationOne,
	startLocalAuthHarness,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

const routerClientId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000071');
const machineId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000072');
const enrollmentId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000073');
const revokePath = '/api/auth/organization-admin/revoke-machine-enrollment';
const revokeBody = JSON.stringify({ organizationId: organizationOne, enrollmentId });
const json = 'application/json';
const form = 'application/x-www-form-urlencoded';

it('rejects query inputs on every machine POST and requires JSON for enrollment revocation', async (): Promise<void> => {
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		machineLogin: {
			routerClientId,
			machineAudience: 'https://central.example.invalid/machine',
		},
	});
	try {
		const discoveryPath = '/.well-known/fleet-login';
		const discovery = await harness.auth(discoveryPath, {
			headers: { 'x-forwarded-host': 'unrelated.example.invalid', 'x-forwarded-proto': 'http' },
		});
		expect(discovery.status).toBe(200);
		expect(discovery.headers.get('cache-control')).toBe('no-store');
		expect(fleetLoginDiscoveryResponseSchema.parse(await discovery.json())).toEqual({
			client_id: routerClientId,
			link_url:
				harness.signInHost === 'cloudflare'
					? `https://${new URL(harness.issuer).host}/api/fleet/link/{organization_id}`
					: 'https://central.example.invalid/v1/organizations/{organization_id}/link',
		});
		const suppliedLink = await harness.auth(
			`${discoveryPath}?link_url=https://unrelated.example.invalid`,
		);
		expect(suppliedLink.status).toBe(400);

		const requests = [
			{
				path: '/api/auth/device/code',
				body: new URLSearchParams({
					client_id: routerClientId,
					machine_id: machineId,
					machine_label: 'Proof Mac',
					organization_id: organizationOne,
				}),
				mediaType: form,
			},
			{
				path: '/api/auth/machine-login/approve',
				body: JSON.stringify({ userCode: 'ABCD-EFGH', allowedWorkspaces: [] }),
				mediaType: json,
			},
			{
				path: '/api/auth/machine-login/deny',
				body: JSON.stringify({ userCode: 'ABCD-EFGH' }),
				mediaType: json,
			},
			{
				path: '/api/auth/oauth2/revoke',
				body: new URLSearchParams({ token: 'fixture-credential', client_id: routerClientId }),
				mediaType: form,
			},
			{
				path: '/api/auth/oauth2/token',
				body: new URLSearchParams({
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					client_id: routerClientId,
					device_code: 'fixture-code',
				}),
				mediaType: form,
			},
			{ path: revokePath, body: revokeBody, mediaType: json },
		];
		const replies = await Promise.all(
			requests.map(async ({ path, body, mediaType }) => ({
				path,
				response: await harness.auth(
					`${path}?machine_installation_id=${machineId}&machine_peer_id=${machineId}`,
					{
						method: 'POST',
						headers: { 'content-type': mediaType, origin: harness.issuer },
						body,
					},
				),
			})),
		);
		expect(replies.map(({ path, response }) => [path, response.status])).toEqual(
			requests.map(({ path }) => [path, 400]),
		);
		const wrongMediaType = await harness.auth(revokePath, {
			method: 'POST',
			headers: { 'content-type': 'text/plain', origin: harness.issuer },
			body: revokeBody,
		});
		expect(wrongMediaType.status).toBe(400);
		const formRevocation = await harness.auth(revokePath, {
			method: 'POST',
			headers: { 'content-type': form, origin: harness.issuer },
			body: new URLSearchParams({ organizationId: organizationOne, enrollmentId }),
		});
		expect(formRevocation.status).toBe(400);
		expect(await formRevocation.json()).toEqual({ error: 'invalid-request' });
		expect(await harness.database.select({ id: deviceCode.id }).from(deviceCode)).toEqual([]);
		expect(harness.centralProvisioning.arrivals).toEqual([]);
	} finally {
		await harness.close();
	}
});
