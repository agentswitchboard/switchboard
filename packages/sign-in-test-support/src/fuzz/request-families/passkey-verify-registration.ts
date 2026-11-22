import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/passkey/verify-registration', (context) => ({
	response: context.passkeyRegistrationResponse,
	name: 'Security key',
}));
