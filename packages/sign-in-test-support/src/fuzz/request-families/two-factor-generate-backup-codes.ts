import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/two-factor/generate-backup-codes', () => ({
	password: 'synthetic-password',
}));
