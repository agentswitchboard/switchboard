import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/two-factor/remove-app', () => ({
	code: '123456',
}));
