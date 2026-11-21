import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/api/auth/organization/people', (context) => ({
	organizationId: context.organizationId,
}));
