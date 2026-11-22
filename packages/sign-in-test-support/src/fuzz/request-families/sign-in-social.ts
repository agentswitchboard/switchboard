import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/sign-in/social',
	(context) => ({
		provider: 'google',
		callbackURL: new URL('/owner-ready', context.issuer).toString(),
	}),
	(context) => ({ 'x-captcha-response': context.captchaToken }),
);
