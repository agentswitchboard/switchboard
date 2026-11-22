import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/two-factor/enable', () => ({
	password: 'synthetic-password',
}));
