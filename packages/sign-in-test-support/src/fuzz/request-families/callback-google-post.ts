import { formFamily } from './request-family';

export const requestFamily = formFamily(
	'/api/auth/callback/google',
	(context) => context.callbackQuery,
	true,
);
