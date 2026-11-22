import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/invite-member', (context) => ({
	organizationId: context.organizationId,
	email: 'invitee@example.invalid',
	role: 'member',
}));
