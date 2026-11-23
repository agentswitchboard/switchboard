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

export type PasskeyRegistrationVerification =
	| { readonly kind: 'verified' }
	| { readonly kind: 'refused'; readonly reason: PasskeyRegistrationRefusalReason };

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

/** Where each refusal reason is recognised: the message @simplewebauthn/server 13.3.3 throws. */
const refusalReasonByMessage: readonly {
	readonly reason: PasskeyRegistrationRefusalReason;
	readonly pattern: RegExp;
}[] = [
	{ reason: 'challenge', pattern: /^Unexpected registration response challenge /u },
	{ reason: 'origin', pattern: /^Unexpected registration response origin /u },
	{ reason: 'rpId', pattern: /^Unexpected RP ID hash$/u },
	{
		reason: 'credentialData',
		pattern: /^No (credential ID|public key|AAGUID) (was provided|was present)/u,
	},
	{
		reason: 'publicKey',
		// A key that decodes to something other than a COSE map fails on `.get` inside the verifier.
		pattern:
			/^(Credential public key was missing numeric alg|Unexpected public key alg |decodedPublicKey\.get is not a function)/u,
	},
	{
		reason: 'attestation',
		pattern:
			/^(Unsupported Attestation Format|None attestation had unexpected|No attestation |Attestation statement )|\((Packed|FIDOU2F|TPM|AndroidKey|AndroidSafetyNet|Apple)/u,
	},
];

function classifyVerificationFault(error: unknown): PasskeyRegistrationRefusalReason {
	if (!(error instanceof Error)) return 'malformed';
	for (const { reason, pattern } of refusalReasonByMessage)
		if (pattern.test(error.message)) return reason;
	return 'malformed';
}

/**
 * Run the verifier the Better Auth passkey plugin will run, and name a client fault instead of
 * throwing it. Every input here comes from the client, so a throw from verification is a refusal.
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
		// A signature or attestation statement that checks and fails is reported as unverified, not thrown.
		return verification.verified ? { kind: 'verified' } : { kind: 'refused', reason: 'signature' };
	} catch (error) {
		return { kind: 'refused', reason: classifyVerificationFault(error) };
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
