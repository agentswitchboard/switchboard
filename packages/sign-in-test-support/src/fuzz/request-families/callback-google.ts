import { queryFamily } from './request-family';

export const requestFamily = queryFamily(
	'/api/auth/callback/google',
	(context) => context.callbackQuery,
);
