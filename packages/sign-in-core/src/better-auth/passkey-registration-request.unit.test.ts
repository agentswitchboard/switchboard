import { expect, it } from 'vitest';

import { isPasskeyRegistrationRequest } from '#sign-in-core/better-auth/passkey-registration-request';

const authenticatorDataHeaderBytes = 37;

/** CBOR map {"fmt": "none", "attStmt": {}, "authData": <authDataLength zero bytes>}. */
function attestationObjectWithAuthData(authDataLength: number): string {
	return Buffer.concat([
		Buffer.from(
			'a3' + '63666d74' + '646e6f6e65' + '6761747453746d74' + 'a0' + '686175746844617461',
			'hex',
		),
		// Byte string with a one-byte length: 0x58 <length>.
		Buffer.from([0x58, authDataLength]),
		Buffer.alloc(authDataLength),
	]).toString('base64url');
}
const decodableAttestationObject = attestationObjectWithAuthData(authenticatorDataHeaderBytes);

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

it('refuses an attestation object that does not decode to fmt, attStmt and parseable authData', (): void => {
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
	// One byte short of the 37-byte header parseAuthenticatorData requires.
	expect(
		isPasskeyRegistrationRequest(
			parserFixture(clientData, attestationObjectWithAuthData(authenticatorDataHeaderBytes - 1)),
		),
	).toBe(false);
});

it('accepts the registration body the Better Auth client posts from a real Chromium virtual authenticator', (): void => {
	// Captured from the native browser journey; values sanitised, member shapes kept. The client
	// strips clientExtensionResults and the browser adds publicKey, publicKeyAlgorithm and
	// authenticatorData to the response.
	const clientDataJSON = Buffer.from(
		JSON.stringify({
			type: 'webauthn.create',
			challenge: 'Yw',
			origin: 'http://localhost:65328',
			crossOrigin: false,
		}),
	).toString('base64url');
	const attestationObject = decodableAttestationObject;
	const realChromeBody = {
		response: {
			id: 'YQ',
			rawId: 'YQ',
			response: {
				attestationObject,
				clientDataJSON,
				transports: ['internal'],
				publicKeyAlgorithm: -8,
				publicKey: 'YQ',
				authenticatorData: 'YQ',
			},
			type: 'public-key',
			authenticatorAttachment: 'platform',
		},
	};
	expect(isPasskeyRegistrationRequest(realChromeBody)).toBe(true);
	expect(
		isPasskeyRegistrationRequest({
			response: { ...realChromeBody.response, clientExtensionResults: 'not-a-record' },
		}),
	).toBe(false);
	expect(
		isPasskeyRegistrationRequest({
			response: { ...realChromeBody.response, authenticatorAttachment: 'usb' },
		}),
	).toBe(false);
});
