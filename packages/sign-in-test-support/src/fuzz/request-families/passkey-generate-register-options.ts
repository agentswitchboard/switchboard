import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/api/auth/passkey/generate-register-options', () => ({
	name: 'Security key',
}));
