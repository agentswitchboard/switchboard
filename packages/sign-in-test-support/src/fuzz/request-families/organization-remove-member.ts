import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/remove-member', (context) => ({
	organizationId: context.organizationId,
	memberIdOrEmail: context.memberId,
}));
