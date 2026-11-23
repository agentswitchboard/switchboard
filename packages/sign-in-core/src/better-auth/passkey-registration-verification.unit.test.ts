import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

import { isoCBOR } from '@simplewebauthn/server/helpers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	verifyPasskeyRegistrationResponse,
	type PasskeyRegistrationExpectation,
	type PasskeyRegistrationRefusalReason,
	type PasskeyRegistrationVerification,
} from '#sign-in-core/better-auth/passkey-registration-verification';

const expected: PasskeyRegistrationExpectation = {
	challenge: 'Y2hhbGxlbmdl',
	origin: 'https://sign-in.example.invalid',
	rpId: 'sign-in.example.invalid',
};

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = publicKey.export({ format: 'jwk' });
const coseKey = new Map<number, number | Uint8Array>([
	[1, 2],
	[3, -7],
	[-1, 1],
	[-2, Buffer.from(String(publicJwk.x), 'base64url')],
	[-3, Buffer.from(String(publicJwk.y), 'base64url')],
]);

interface RegistrationParts {
	readonly clientChallenge?: string;
	readonly clientOrigin?: string;
	readonly rpIdHashedInAuthData?: string;
	readonly attestedCredentialData?: boolean;
	readonly credentialPublicKeyBytes?: Uint8Array;
	readonly attestationFormat?: string;
	readonly packedSelfSignature?: 'valid' | 'wrong-signer' | 'not-der' | 'empty';
	readonly userPresent?: boolean;
}

/** A real registration wire response, with one part changed per test. */
function registrationResponse(parts: RegistrationParts = {}): unknown {
	const clientData = Buffer.from(
		JSON.stringify({
			type: 'webauthn.create',
			challenge: parts.clientChallenge ?? expected.challenge,
			origin: parts.clientOrigin ?? expected.origin,
		}),
	);
	const credentialId = randomBytes(16);
	const attested = parts.attestedCredentialData ?? true;
	const header = Buffer.concat([
		createHash('sha256')
			.update(parts.rpIdHashedInAuthData ?? expected.rpId)
			.digest(),
		Buffer.from([(attested ? 0x40 : 0) | ((parts.userPresent ?? true) ? 0x01 : 0)]),
		Buffer.alloc(4),
	]);
	const credentialLength = Buffer.alloc(2);
	credentialLength.writeUInt16BE(credentialId.length);
	const authData = attested
		? Buffer.concat([
				header,
				Buffer.alloc(16),
				credentialLength,
				credentialId,
				parts.credentialPublicKeyBytes ?? isoCBOR.encode(coseKey),
			])
		: header;
	const attestationStatement = new Map<string, number | Uint8Array>();
	if (parts.packedSelfSignature !== undefined) {
		const signedBytes = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
		attestationStatement.set('alg', -7);
		attestationStatement.set(
			'sig',
			parts.packedSelfSignature === 'not-der'
				? new Uint8Array(70).fill(1)
				: parts.packedSelfSignature === 'empty'
					? new Uint8Array(0)
					: sign('sha256', signedBytes, {
							key:
								parts.packedSelfSignature === 'valid'
									? privateKey
									: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
							dsaEncoding: 'der',
						}),
		);
	}
	const attestationObject = isoCBOR.encode(
		new Map<string, string | Map<string, number | Uint8Array> | Uint8Array>([
			['fmt', parts.attestationFormat ?? (parts.packedSelfSignature ? 'packed' : 'none')],
			['attStmt', attestationStatement],
			['authData', authData],
		]),
	);
	const credential = credentialId.toString('base64url');
	return {
		id: credential,
		rawId: credential,
		type: 'public-key',
		response: {
			clientDataJSON: clientData.toString('base64url'),
			attestationObject: Buffer.from(attestationObject).toString('base64url'),
		},
	};
}

function refusal(reason: PasskeyRegistrationRefusalReason): PasskeyRegistrationVerification {
	return { kind: 'refused', reason };
}

describe('verifyPasskeyRegistrationResponse', (): void => {
	it('verifies a well-formed registration', async (): Promise<void> => {
		expect(
			await verifyPasskeyRegistrationResponse({ response: registrationResponse(), expected }),
		).toEqual({
			kind: 'verified',
		});
	});

	it('verifies a packed self-attestation signed by the credential key', async (): Promise<void> => {
		expect(
			await verifyPasskeyRegistrationResponse({
				response: registrationResponse({ packedSelfSignature: 'valid' }),
				expected,
			}),
		).toEqual({ kind: 'verified' });
	});

	const faults: readonly (readonly [PasskeyRegistrationRefusalReason, RegistrationParts])[] = [
		['challenge', { clientChallenge: 'b3RoZXI' }],
		['origin', { clientOrigin: 'https://other.example.invalid' }],
		['rpId', { rpIdHashedInAuthData: 'other.example.invalid' }],
		// Valid DER from the wrong key: the verifier reports verified: false, which maps to signature.
		['signature', { packedSelfSignature: 'wrong-signer' }],
		// Bytes that are not a DER ECDSA signature: the ASN.1 parser refuses them.
		['signature', { packedSelfSignature: 'not-der' }],
		['signature', { packedSelfSignature: 'empty' }],
		['attestation', { attestationFormat: 'unknown-format' }],
		['credentialData', { attestedCredentialData: false }],
		['publicKey', { credentialPublicKeyBytes: isoCBOR.encode(new Map([[1, 2]])) }],
		['publicKey', { credentialPublicKeyBytes: isoCBOR.encode(7) }],
		// A COSE EC2 key whose point is not on the curve: WebCrypto's importKey refuses it (DataError).
		[
			'publicKey',
			{
				credentialPublicKeyBytes: isoCBOR.encode(
					new Map<number, number | Uint8Array>([
						[1, 2],
						[3, -7],
						[-1, 1],
						[-2, new Uint8Array(32).fill(7)],
						[-3, new Uint8Array(32).fill(9)],
					]),
				),
				packedSelfSignature: 'valid',
			},
		],
		['malformed', { userPresent: false }],
	];
	it.each(faults)('refuses a %s fault with that reason', async (reason, parts): Promise<void> => {
		expect(
			await verifyPasskeyRegistrationResponse({ response: registrationResponse(parts), expected }),
		).toEqual(refusal(reason));
	});

	it('refuses a response of the wrong shape as malformed', async (): Promise<void> => {
		expect(await verifyPasskeyRegistrationResponse({ response: { id: 'x' }, expected })).toEqual(
			refusal('malformed'),
		);
		expect(await verifyPasskeyRegistrationResponse({ response: undefined, expected })).toEqual(
			refusal('malformed'),
		);
	});

	describe('a verifier failure no credential error explains', (): void => {
		afterEach((): void => {
			vi.restoreAllMocks();
		});

		// A packed self-attestation, so verification imports the credential key through WebCrypto.
		// (Failing the RP ID digest instead hangs: SimpleWebAuthn 13.3.3's matchExpectedRPID never
		// settles when that digest rejects.)
		const packedRegistration = (): unknown =>
			registrationResponse({ packedSelfSignature: 'valid' });

		it('is a verifier failure, not a refusal, when WebCrypto throws', async (): Promise<void> => {
			const failure = new DOMException('Injected WebCrypto failure', 'OperationError');
			vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValue(failure);
			expect(
				await verifyPasskeyRegistrationResponse({ response: packedRegistration(), expected }),
			).toEqual({ kind: 'verifier-failed', failure });
		});

		it('is a verifier failure when WebCrypto is unavailable', async (): Promise<void> => {
			// What SimpleWebAuthn's getWebCrypto rejects with when the runtime has no Crypto API.
			const failure = Object.assign(
				new Error('An instance of the Crypto API could not be located'),
				{
					name: 'MissingWebCrypto',
				},
			);
			vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValue(failure);
			expect(
				await verifyPasskeyRegistrationResponse({ response: packedRegistration(), expected }),
			).toEqual({ kind: 'verifier-failed', failure });
		});
	});
});
