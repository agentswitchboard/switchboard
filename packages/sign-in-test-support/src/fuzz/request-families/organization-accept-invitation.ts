import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/accept-invitation', (context) => ({
	invitationId: context.invitationId,
}));
