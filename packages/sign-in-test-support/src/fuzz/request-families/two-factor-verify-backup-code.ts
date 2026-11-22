import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/two-factor/verify-backup-code', (context) => ({
	code: context.backupCode,
}));
