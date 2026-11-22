import { queryFamily } from './request-family';

export const requestFamily = queryFamily('/api/auth/organization/people-list', (context) => ({
	organizationId: context.organizationId,
	offset: 0,
}));
