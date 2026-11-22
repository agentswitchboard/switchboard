import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/link-social', (context) => ({
	provider: 'google',
	callbackURL: new URL('/owner-ready', context.issuer).toString(),
}));
