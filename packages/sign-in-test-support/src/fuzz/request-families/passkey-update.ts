import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/passkey/update-passkey', (context) => ({
	id: context.passkeyId,
	name: 'Security key',
}));
