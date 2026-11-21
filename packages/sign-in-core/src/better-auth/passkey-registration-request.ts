import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { z } from 'zod';

const registrationRequestSchema = z.object({
	response: z.object({
		id: z.base64url().min(1),
		rawId: z.base64url().min(1),
		type: z.literal('public-key'),
		response: z.object({
			clientDataJSON: z.base64url().min(1),
			attestationObject: z.base64url().min(1),
			transports: z.array(z.string()).optional(),
		}),
		clientExtensionResults: z.record(z.string(), z.unknown()),
		authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
	}),
});

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

/** Check the wire encoding and decoded client-data shape before native verification. */
export function isPasskeyRegistrationRequest(input: unknown): boolean {
	const request = registrationRequestSchema.safeParse(input);
	if (!request.success) return false;
	const credential = request.data.response;
	if (credential.id !== credential.rawId) return false;
	try {
		const decoded: unknown = decodeClientDataJSON(credential.response.clientDataJSON);
		return registrationClientDataSchema.safeParse(decoded).success;
	} catch {
		return false;
	}
}
