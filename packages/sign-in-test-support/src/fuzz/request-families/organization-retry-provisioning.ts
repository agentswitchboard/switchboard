import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/retry-provisioning', (context) => ({
	organizationId: context.organizationId,
}));
