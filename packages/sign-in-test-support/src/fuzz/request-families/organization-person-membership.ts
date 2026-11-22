import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily('/api/auth/organization/person-membership', (context) => ({
	organizationId: context.organizationId,
	email: 'person@example.invalid',
}));
