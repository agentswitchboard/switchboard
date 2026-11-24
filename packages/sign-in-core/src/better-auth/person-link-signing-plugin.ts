import { createAuthEndpoint } from 'better-auth/api';
import { signJWT } from 'better-auth/plugins/jwt';

import { signInJwtOptions } from '#sign-in-core/better-auth/native-jwt-options';
import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import {
	personLinkTokenClaimsSchema,
	personLinkTokenType,
} from '#sign-in-core/contracts/person-link-token';

type PersonLinkSigningEndpoint = ReturnType<
	typeof createAuthEndpoint.serverOnly<
		string,
		{ method: 'POST'; body: typeof personLinkTokenClaimsSchema },
		{ readonly token: string }
	>
>;

/**
 * C8 part B: the person-link token is signed by the provider's own signer, with the keys the JWKS
 * publishes, exactly as the person-fleet token and the organization statement are. Server-only
 * dispatch gives the signer its native context without an HTTP route.
 */
export function createPersonLinkSigningPlugin(props: {
	readonly configuration: Pick<SignInConfiguration, 'issuer'>;
}): {
	readonly id: 'person-link-signing';
	readonly endpoints: { readonly signPersonLinkToken: PersonLinkSigningEndpoint };
} {
	return {
		id: 'person-link-signing',
		endpoints: {
			signPersonLinkToken: createAuthEndpoint.serverOnly(
				{ method: 'POST', body: personLinkTokenClaimsSchema },
				async (context) => ({
					token: await signJWT(context, {
						options: signInJwtOptions(props.configuration),
						header: { typ: personLinkTokenType },
						payload: context.body,
					}),
				}),
			),
		},
	};
}
