import { createLocalJWKSet, jwtVerify } from 'jose';
import type { WorkerOptions } from 'miniflare';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

const keysPath = '/api/auth/jwks';
const discoveryPath = '/.well-known/oauth-authorization-server';
const keysCallerName = 'sign-in-keys-caller';
const keysCaller = {
	config: {
		type: 'worker',
		name: keysCallerName,
		compatibilityDate: '2026-08-15',
		manifest: {
			mainModule: 'keys-caller.mjs',
			modules: {
				'keys-caller.mjs': {
					type: 'esm',
					contents:
						'export default { fetch(request, env) { return env.SIGN_IN_KEYS.fetch(request); } };',
				},
			},
		},
		env: {
			SIGN_IN_KEYS: { type: 'worker', workerName: 'sign-in', exportName: 'SignInJwks' },
		},
	},
} satisfies WorkerOptions;

const publicKeysSchema = z.object({
	keys: z
		.array(
			z.object({
				kty: z.literal('OKP'),
				crv: z.literal('Ed25519'),
				x: z.string(),
				kid: z.uuidv7(),
			}),
		)
		.min(1),
});

useControlledSignInClock();

it('serves only the issuer public keys through the named sign-in service binding', async (): Promise<void> => {
	const harness = await startLocalAuthHarness({
		host: 'cloudflare',
		turnstileSecret: 'published-test',
		signInKeysCaller: keysCaller,
	});
	try {
		await harness.ownerToken();
		const [provisioningSend] = harness.centralProvisioning.sends;
		if (provisioningSend === undefined) throw new Error('Sign-in sent no organization stamp');
		const caller = await harness.miniflare.getWorker(keysCallerName);
		const publicKeysResponse = await harness.auth(keysPath);
		const privateKeysResponse = await caller.fetch(new URL(keysPath, harness.issuer));
		expect(publicKeysResponse.status).toBe(200);
		expect(privateKeysResponse.status).toBe(200);
		const privateKeys: unknown = await privateKeysResponse.json();
		expect(privateKeys).toEqual(await publicKeysResponse.json());
		expect(privateKeysResponse.headers.get('cache-control')).toBe(
			publicKeysResponse.headers.get('cache-control'),
		);
		const verified = await jwtVerify(
			provisioningSend.organizationStatement,
			createLocalJWKSet(publicKeysSchema.parse(privateKeys)),
			{
				issuer: harness.issuer,
				audience: 'https://central.example.invalid/identity',
				typ: 'fleet-organization-stamp+jwt',
				algorithms: ['EdDSA'],
				currentDate: new Date(controlledSignInClock.now()),
			},
		);
		expect(verified.payload.sub).toBe(provisioningSend.organizationId);

		expect((await harness.auth(discoveryPath)).status, 'public discovery').toBe(200);
		for (const pathname of [discoveryPath, '/api/auth/get-session']) {
			const refused = await caller.fetch(new URL(pathname, harness.issuer));
			expect(refused.status, `private GET ${pathname}`).toBe(404);
		}
		for (const method of ['POST', 'HEAD']) {
			const refused = await caller.fetch(new URL(keysPath, harness.issuer), { method });
			expect(refused.status, `private ${method} ${keysPath}`).toBe(405);
			expect(refused.headers.get('allow')).toBe('GET');
		}
	} finally {
		await harness.close();
	}
});
