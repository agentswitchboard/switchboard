import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';

import type { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import type { SoftwarePasskeyAuthenticator } from '#sign-in-test-support/test-fixtures/software-passkey-authenticator';

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
export const passkeyConfirmationOptionsSchema = z.object({
	challengeId: z.uuidv7(),
	options: z.object({
		challenge: z.string().min(1),
		rpId: z.string().min(1),
		userVerification: z.literal('required'),
		allowCredentials: z.array(z.object({ id: z.string().min(1) })),
	}),
});
export function passkeyPost(
	harness: Harness,
	pathname: string,
	body: Readonly<Record<string, unknown>>,
): Promise<Response> {
	return harness.auth(`/api/auth/passkey/${pathname}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

/** Native registration options and the returned browser challenge cookie drive
 * the real registration verifier. No credential row is fabricated. */
export async function registerBrowserPasskey(props: {
	readonly harness: Harness;
	readonly authenticator: SoftwarePasskeyAuthenticator;
	readonly userVerified?: boolean;
	/** Derive a case from the valid response; omit for the valid ceremony itself. */
	readonly alterResponse?: (valid: RegistrationResponseJSON) => RegistrationResponseJSON;
}): Promise<Response> {
	const optionsResponse = await props.harness.auth('/api/auth/passkey/generate-register-options');
	if (!optionsResponse.ok) return optionsResponse;
	const options = z
		.object({
			challenge: z.string().min(1),
			rp: z.object({ id: z.string().min(1) }),
			authenticatorSelection: z.object({ userVerification: z.literal('required') }),
		})
		.parse(await optionsResponse.json());
	return passkeyPost(props.harness, 'verify-registration', {
		name: 'Controlled test passkey',
		response: (props.alterResponse ?? ((valid) => valid))(
			props.authenticator.registrationResponse({
				challenge: options.challenge,
				rpId: options.rp.id,
				origin: props.harness.issuer,
				...(props.userVerified === undefined ? {} : { userVerified: props.userVerified }),
			}),
		),
	});
}
