import { formFamily } from './request-family';

export const requestFamily = formFamily(
	'/api/auth/callback/github',
	(context) => context.callbackQuery,
	true,
);
