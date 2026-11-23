import { expect, it } from 'vitest';

import { handleCaptchaProviderProof } from '#sign-in-test-support/test-fixtures/captcha-provider-proof';

// An unrelated route must not inspect any Worker capability or configuration.
const unusedBindings = {
	get DB(): never {
		throw new Error('Unrelated request inspected DB');
	},
	get SIGN_IN_ATTEMPTS(): never {
		throw new Error('Unrelated request inspected SIGN_IN_ATTEMPTS');
	},
	get AUTH_REQUESTS(): never {
		throw new Error('Unrelated request inspected AUTH_REQUESTS');
	},
	get SIGN_IN_CONFIGURATION(): never {
		throw new Error('Unrelated request inspected configuration');
	},
	get AUTH_SECRET(): never {
		throw new Error('Unrelated request inspected secret');
	},
	get GOOGLE_CLIENT_ID(): never {
		throw new Error('Unrelated request inspected Google configuration');
	},
	get GOOGLE_CLIENT_SECRET(): never {
		throw new Error('Unrelated request inspected Google secret');
	},
	get GITHUB_CLIENT_ID(): never {
		throw new Error('Unrelated request inspected GitHub configuration');
	},
	get GITHUB_CLIENT_SECRET(): never {
		throw new Error('Unrelated request inspected GitHub secret');
	},
	get TURNSTILE_SECRET_KEY(): never {
		throw new Error('Unrelated request inspected captcha secret');
	},
	get CENTRAL(): never {
		throw new Error('Unrelated request inspected central');
	},
	get CENTRAL_LINK(): never {
		throw new Error('Unrelated request inspected the machine link');
	},
} satisfies AuthWorkerEnv;

it('leaves an unrelated social POST body available to the production handler', async (): Promise<void> => {
	const body = { provider: 'google', callbackURL: 'http://proof.invalid/owner-ready' };
	const request = new Request('http://proof.invalid/api/auth/sign-in/social', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' },
		body: JSON.stringify(body),
	});

	expect(await handleCaptchaProviderProof(request, unusedBindings)).toBeNull();
	expect(request.bodyUsed).toBe(false);
	// The production Worker derives a Request from this same original after proof routing.
	const productionRequest = new Request(request, { headers: request.headers });
	expect(await productionRequest.json()).toEqual(body);
});
