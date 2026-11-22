import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/cancel-invitation', (context) => ({
	invitationId: context.invitationId,
}));
