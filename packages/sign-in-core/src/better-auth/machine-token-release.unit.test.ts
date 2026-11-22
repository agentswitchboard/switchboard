import { generateKeyPair, SignJWT } from 'jose';
import { expect, it } from 'vitest';

import { releaseMachineTokenResponse } from '#sign-in-core/better-auth/machine-token-release';
import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { machineLoginConfigurationSchema } from '#sign-in-core/machine-login/machine-login-contracts';

const machineId = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000b1');
const organizationId = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000b2');
const enrollmentId = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000b3');
const configuration = machineLoginConfigurationSchema.parse({
	routerClientId: '019a3dce-2000-7000-8000-0000000000b4',
	machineAudience: 'https://central.example.invalid/machine',
	linkUrlTemplate: 'https://central.example.invalid/v1/organizations/{organization_id}/link',
	fleetCentral: {
		receiver: '019a3dce-2000-7000-8000-0000000000b5',
		relay: '019a3dce-2000-7000-8000-0000000000b6',
	},
});
const issuer = 'https://sign-in.example.invalid';
const issuedAt = 1_800_000_000;
const grantExpiresAt = issuedAt + 30;

it('releases the machine credential only before the exact grant deadline', async (): Promise<void> => {
	const { privateKey } = await generateKeyPair('EdDSA');
	const access = await new SignJWT({
		iss: issuer,
		sub: enrollmentId,
		aud: configuration.machineAudience,
		iat: issuedAt,
		exp: issuedAt + 3600,
		client_id: enrollmentId,
		azp: enrollmentId,
		principal: { kind: 'machine', machine_id: machineId, enrollment_id: enrollmentId },
		organization_id: organizationId,
		grant_expires_at: grantExpiresAt,
	})
		.setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
		.sign(privateKey);
	const nativeBody = {
		access_token: access,
		refresh_token: 'synthetic-refresh',
		expires_in: 3600,
		expires_at: issuedAt + 3600,
		token_type: 'Bearer',
		scope: 'offline_access',
		machine_client_id: enrollmentId,
		fleet_central: configuration.fleetCentral,
	};
	const releaseAt = (milliseconds: number): Promise<Response> =>
		releaseMachineTokenResponse({
			response: Response.json(
				{ ...nativeBody, id_token: 'unexpected-token' },
				{
					headers: {
						'set-cookie': 'synthetic_session=fixture',
						authorization: 'Bearer fixture',
						dpop: 'fixture-proof',
					},
				},
			),
			configuration,
			issuer,
			now: () => milliseconds,
			state: {
				kind: 'granted',
				clientId: enrollmentId,
				decidedAt: issuedAt,
				enrollmentId,
				grantExpiresAt,
				machineId,
				organizationId,
			},
		});
	const prior = await releaseAt(grantExpiresAt * 1000 - 1);
	expect(prior.status).toBe(200);
	for (const credentialHeader of ['set-cookie', 'authorization', 'dpop'])
		expect(prior.headers.has(credentialHeader), credentialHeader).toBe(false);
	const projected: unknown = await prior.json();
	expect(projected).not.toHaveProperty('id_token');
	const exact = await releaseAt(grantExpiresAt * 1000);
	expect(exact.status).toBe(400);
	expect(await exact.json()).toEqual({ error: 'invalid_grant' });
});
