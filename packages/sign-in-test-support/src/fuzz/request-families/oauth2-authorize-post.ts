import { formFamily } from './request-family';

export const requestFamily = formFamily(
	'/api/auth/oauth2/authorize',
	(context) => ({
		response_type: 'code',
		client_id: context.oauthClientId,
		redirect_uri: context.oauthRedirectUri,
		resource: context.oauthResource,
		code_challenge: context.oauthCodeChallenge,
		code_challenge_method: 'S256',
		state: 'state',
	}),
	false,
);
