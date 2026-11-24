import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';

import { authorizationFencedAdapter } from '#sign-in-core/better-auth/authorization-fenced-adapter';
import { signInJwtOptions } from '#sign-in-core/better-auth/native-jwt-options';
import type { SignInHttpConfiguration } from '#sign-in-core/better-auth/sign-in-http-handler';

/** Composes the native key publisher independently of sign-in plugins and their initialization. */
export function readSignInJwksResponse(
	props: Pick<SignInHttpConfiguration, 'configuration' | 'openDatabase' | 'platform' | 'secret'>,
): Promise<Response> {
	const provider = betterAuth({
		baseURL: props.configuration.issuer,
		basePath: '/api/auth',
		secret: props.secret,
		database: authorizationFencedAdapter({
			openDatabase: props.openDatabase,
			platform: props.platform,
		}),
		advanced: { database: { generateId: () => props.platform.ids.nextId() } },
		plugins: [jwt(signInJwtOptions(props.configuration))],
	});
	return provider.api.getJwks({ asResponse: true });
}
