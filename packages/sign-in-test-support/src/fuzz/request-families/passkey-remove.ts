import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/passkey/remove', (context) => ({
	id: context.passkeyId,
}));
