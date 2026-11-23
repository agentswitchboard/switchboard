import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { z } from 'zod';

/**
 * Why a registration response was refused. Closed: every refusal is one of these, and a switch
 * over it ends in a `never` check, so a new reason cannot be added without handling it.
 */
export type PasskeyRegistrationRefusalReason =
	| 'challenge'
	| 'origin'
	| 'rpId'
	| 'signature'
	| 'attestation'
	| 'credentialData'
	| 'publicKey'
	| 'malformed';

/**
 * What one verification run concluded. `verifier-failed` is not a client fault: the verifier failed
 * in a way no known credential error explains (WebCrypto unavailable or throwing, for one), so the
 * caller answers it as the server error it is.
 */
export type PasskeyRegistrationVerification =
	| { readonly kind: 'verified' }
	| { readonly kind: 'refused'; readonly reason: PasskeyRegistrationRefusalReason }
	| { readonly kind: 'verifier-failed'; readonly failure: unknown };

export interface PasskeyRegistrationExpectation {
	readonly challenge: string;
	readonly origin: string;
	readonly rpId: string;
}

/**
 * The wire fields verification reads. The request guard has already decoded this body once;
 * this is the typed view the verifier takes. `transports` is left out: verification only echoes it.
 */
const registrationResponseWireSchema = z.object({
	id: z.string(),
	rawId: z.string(),
	type: z.literal('public-key'),
	response: z.object({ clientDataJSON: z.string(), attestationObject: z.string() }),
});

/**
 * The known credential errors, by what @simplewebauthn/server 13.3.3 and the libraries it calls
 * throw for client-supplied input. Anything not listed here is not assumed to be the client's fault.
 */
interface ThrownError {
	readonly name: string;
	readonly message: string;
}

/** The name and message of a thrown value. DOMException is read the same way on every runtime. */
function readThrownError(error: unknown): ThrownError | null {
	if (typeof error !== 'object' || error === null || !('name' in error) || !('message' in error))
		return null;
	const { name, message } = error;
	return typeof name === 'string' && typeof message === 'string' ? { name, message } : null;
}

const knownCredentialFaults: readonly {
	readonly reason: PasskeyRegistrationRefusalReason;
	readonly matches: (error: ThrownError) => boolean;
}[] = [
	{
		reason: 'challenge',
		matches: (error) => error.message.startsWith('Unexpected registration response challenge '),
	},
	{
		reason: 'origin',
		matches: (error) => error.message.startsWith('Unexpected registration response origin '),
	},
	{ reason: 'rpId', matches: (error) => error.name === 'UnexpectedRPIDHash' },
	{
		reason: 'credentialData',
		matches: (error) =>
			/^No (credential ID|public key) was provided by authenticator$|^No AAGUID was present during registration$/u.test(
				error.message,
			),
	},
	{
		reason: 'publicKey',
		matches: (error) =>
			// WebCrypto refuses key bytes that do not describe a key (a point off the curve): DataError.
			error.name === 'DataError' ||
			// A key that decodes to something other than a COSE map fails on `.get` inside the verifier.
			/^(Credential public key was missing numeric alg|Unexpected public key alg |decodedPublicKey\.get is not a function|Public key was missing (alg|crv|x|y|n|e) \(|Public key had invalid alg |Unexpected COSE crv value of |unknown COSE curve |Signature verification with public key of kty |Could not map COSE alg value of |Unexpected RSA key algorithm )/u.test(
				error.message,
			),
	},
	{
		reason: 'signature',
		// The signature bytes are not a DER ECDSA signature: the ASN.1 parser refuses them.
		matches: (error) =>
			/^(Data does not match to ECDSASigValue ASN1 schema|Input buffer has zero length$|Invalid signature component length )/u.test(
				error.message,
			),
	},
	{
		reason: 'attestation',
		matches: (error) =>
			/^(Unsupported Attestation Format|None attestation had unexpected|No attestation |Attestation statement )|\((Packed|FIDOU2F|TPM|AndroidKey|AndroidSafetyNet|Apple)/u.test(
				error.message,
			),
	},
	{
		reason: 'malformed',
		matches: (error) =>
			/^(Missing credential ID$|Credential ID was not base64url-encoded$|Unexpected credential type |Unexpected registration response type|Unexpected value for TokenBinding |Unexpected tokenBinding\.status |User presence was required|Authenticator data was \d+ bytes|Leftover bytes detected while parsing authenticator data$|Error decoding authenticator extensions: )/u.test(
				error.message,
			),
	},
];

function classifyVerificationFault(error: unknown): PasskeyRegistrationVerification {
	const thrown = readThrownError(error);
	if (thrown !== null)
		for (const { reason, matches } of knownCredentialFaults)
			if (matches(thrown)) return { kind: 'refused', reason };
	return { kind: 'verifier-failed', failure: error };
}

/**
 * Run the verifier the Better Auth passkey plugin will run, and name a known client fault instead of
 * throwing it. A failure no known credential error explains stays a verifier failure.
 */
export async function verifyPasskeyRegistrationResponse(props: {
	readonly response: unknown;
	readonly expected: PasskeyRegistrationExpectation;
}): Promise<PasskeyRegistrationVerification> {
	const wire = registrationResponseWireSchema.safeParse(props.response);
	if (!wire.success) return { kind: 'refused', reason: 'malformed' };
	try {
		const verification = await verifyRegistrationResponse({
			response: { ...wire.data, clientExtensionResults: {} },
			expectedChallenge: props.expected.challenge,
			expectedOrigin: props.expected.origin,
			expectedRPID: props.expected.rpId,
			requireUserVerification: false,
		});
		// A well-formed signature that does not verify (valid DER from the wrong key, say) is reported
		// as `verified: false`, not thrown. The attestation formats sign-in accepts report it the same way.
		return verification.verified ? { kind: 'verified' } : { kind: 'refused', reason: 'signature' };
	} catch (error) {
		return classifyVerificationFault(error);
	}
}

/** The message a client reads for each reason; exhaustive, so a new reason fails the build here. */
export function describePasskeyRegistrationRefusal(
	reason: PasskeyRegistrationRefusalReason,
): string {
	switch (reason) {
		case 'challenge':
			return 'The registration answers a different challenge.';
		case 'origin':
			return 'The registration was made for a different origin.';
		case 'rpId':
			return 'The registration was made for a different relying party.';
		case 'signature':
			return 'The registration signature does not verify.';
		case 'attestation':
			return 'The registration attestation is not acceptable.';
		case 'credentialData':
			return 'The registration carries no attested credential data.';
		case 'publicKey':
			return 'The registration public key is not an acceptable COSE key.';
		case 'malformed':
			return 'The registration response is malformed.';
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}
