import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/set-active', (context) => ({
	organizationId: context.organizationId,
}));
