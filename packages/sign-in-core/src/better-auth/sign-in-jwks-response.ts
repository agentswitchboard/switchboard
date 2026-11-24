import { createSignInProvider } from '#sign-in-core/better-auth/provider-configuration';
import { createProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import type { SignInHttpConfiguration } from '#sign-in-core/better-auth/sign-in-http-handler';

/** Reads the native public key set with the publisher's original response headers. */
export function readSignInJwksResponse(configuration: SignInHttpConfiguration): Promise<Response> {
	const provider = createSignInProvider({
		...configuration,
		authority: { kind: 'public' },
		requestState: createProviderRequestState(),
	});
	return provider.api.getJwks({ asResponse: true });
}
