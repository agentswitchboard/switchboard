import { expect, it } from 'vitest';

import { isPasskeyRegistrationRequest } from '#sign-in-core/better-auth/passkey-registration-request';

// CBOR map {"fmt": "none", "attStmt": {}, "authData": h'00'}.
const decodableAttestationObject = Buffer.from(
	'a3' + '63666d74' + '646e6f6e65' + '6761747453746d74' + 'a0' + '686175746844617461' + '4100',
	'hex',
).toString('base64url');

function parserFixture(
	clientData: unknown,
	attestationObject = decodableAttestationObject,
): unknown {
	return {
		response: {
			id: 'YQ',
			rawId: 'YQ',
			type: 'public-key',
			response: {
				clientDataJSON: Buffer.from(JSON.stringify(clientData)).toString('base64url'),
				// The parser checks the attestation decodes; it does not verify it.
				attestationObject,
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

it('refuses an attestation object that does not decode to fmt, attStmt and authData', (): void => {
	const clientData = {
		type: 'webauthn.create',
		origin: 'https://sign-in.example.invalid',
		challenge: 'Yw',
	};
	const notCbor = Buffer.from('not cbor at all').toString('base64url');
	const withoutAuthData = Buffer.from(
		'a2' + '63666d74' + '646e6f6e65' + '6761747453746d74' + 'a0',
		'hex',
	).toString('base64url');
	expect(isPasskeyRegistrationRequest(parserFixture(clientData, notCbor))).toBe(false);
	expect(isPasskeyRegistrationRequest(parserFixture(clientData, withoutAuthData))).toBe(false);
});
