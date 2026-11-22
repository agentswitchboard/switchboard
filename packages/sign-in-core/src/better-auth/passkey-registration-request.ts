import {
	decodeAttestationObject,
	decodeClientDataJSON,
	isoBase64URL,
	parseAuthenticatorData,
} from '@simplewebauthn/server/helpers';
import { z } from 'zod';

/**
 * Run one of the verifier's own decoders. A throw becomes a zod issue at the field's path.
 * The result is `unknown` on purpose: the next pipe stage states and checks its shape.
 */
function decodeWith<Encoded>(
	decode: (encoded: Encoded) => unknown,
	description: string,
): (encoded: Encoded, context: z.RefinementCtx<Encoded>) => unknown {
	return (encoded, context) => {
		try {
			return decode(encoded);
		} catch (error) {
			context.issues.push({
				code: 'custom',
				message: `${description}: ${error instanceof Error ? error.message : 'undecodable'}`,
				input: encoded,
			});
			return z.NEVER;
		}
	};
}

const registrationClientDataSchema = z.object({
	type: z.literal('webauthn.create'),
	challenge: z.base64url().min(1),
	origin: z.url(),
	tokenBinding: z
		.object({
			status: z.enum(['present', 'supported', 'not-supported']),
			id: z.string().optional(),
		})
		.optional(),
});

/** What parseAuthenticatorData returns that later verification reads without re-checking. */
const parsedAuthenticatorDataSchema = z.looseObject({
	rpIdHash: z.instanceof(Uint8Array),
	counter: z.number(),
	flags: z.looseObject({ up: z.boolean(), uv: z.boolean(), at: z.boolean(), ed: z.boolean() }),
});

const decodedAttestationObjectSchema = z.object({
	fmt: z.string(),
	attStmt: z.instanceof(Map),
	authData: z
		.instanceof(Uint8Array)
		.transform(decodeWith(parseAuthenticatorData, 'authenticator data is malformed'))
		.pipe(parsedAuthenticatorDataSchema),
});

/**
 * Wire shape plus the decoding steps @simplewebauthn/server runs before any
 * cryptographic check, in the same order and with the same helpers. Challenge,
 * origin, RP ID and signature checks stay with the native verifier.
 */
export const passkeyRegistrationRequestSchema = z.object({
	response: z
		.object({
			id: z.base64url().min(1),
			rawId: z.base64url().min(1),
			type: z.literal('public-key'),
			response: z.object({
				clientDataJSON: z
					.base64url()
					.min(1)
					.transform(decodeWith(decodeClientDataJSON, 'client data is not JSON'))
					.pipe(registrationClientDataSchema),
				attestationObject: z
					.base64url()
					.min(1)
					.transform(
						decodeWith(
							(encoded: string) => decodeAttestationObject(isoBase64URL.toBuffer(encoded)),
							'attestation object is not CBOR',
						),
					)
					.pipe(z.instanceof(Map))
					.transform((attestation) => ({
						fmt: attestation.get('fmt'),
						attStmt: attestation.get('attStmt'),
						authData: attestation.get('authData'),
					}))
					.pipe(decodedAttestationObjectSchema),
				transports: z.array(z.string()).optional(),
			}),
			// Optional: the Better Auth passkey client destructures clientExtensionResults out of
			// the credential before it posts `response`, so real browser requests never carry it.
			// Registration verification does not read it.
			clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
			authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
		})
		.refine((credential) => credential.id === credential.rawId, {
			message: 'id and rawId differ',
			path: ['rawId'],
		}),
});

export type PasskeyRegistrationRequest = z.output<typeof passkeyRegistrationRequestSchema>;

/** True when the request decodes the way native verification will decode it. */
export function isPasskeyRegistrationRequest(input: unknown): boolean {
	return passkeyRegistrationRequestSchema.safeParse(input).success;
}
