import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/two-factor/verify-totp', (context) => ({
	code: context.totpCode,
	trustDevice: false,
}));
