import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/api/auth/get-session', () => ({
	disableCookieCache: 'false',
}));
