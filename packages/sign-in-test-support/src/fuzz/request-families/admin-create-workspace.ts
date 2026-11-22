import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/organization-admin/create-workspace',
	(context) => ({
		organizationId: context.organizationId,
		operationId: context.challengeId,
		name: 'research',
		description: '',
	}),
);
