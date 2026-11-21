import { expect, it } from 'vitest';

import { isPasskeyRegistrationRequest } from '#sign-in-core/better-auth/passkey-registration-request';

function parserFixture(clientData: unknown): unknown {
	return {
		response: {
			id: 'YQ',
			rawId: 'YQ',
			type: 'public-key',
			response: {
				clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString('base64url'),
				// The parser does not claim to verify the attestation.
				attestationObject: 'Yg',
			},
			clientExtensionResults: {},
		},
	};
}

it('validates decoded registration client data before it is eligible for native verification', (): void => {
	const clientData = {
		type: 'webauthn.create',
		origin: 'https://sign-in.example.invalid',
		challenge: 'Yw',
	};
	expect(isPasskeyRegistrationRequest(parserFixture(clientData))).toBe(true);
	expect(isPasskeyRegistrationRequest(parserFixture(null))).toBe(false);
	expect(isPasskeyRegistrationRequest(parserFixture({ ...clientData, origin: false }))).toBe(false);
	expect(isPasskeyRegistrationRequest(parserFixture({ ...clientData, type: 'webauthn.get' }))).toBe(
		false,
	);
});
