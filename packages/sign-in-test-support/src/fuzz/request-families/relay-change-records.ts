import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/organization-admin/v1/change-records',
	(context) => ({ organizationId: context.organizationId, after: null, limit: 100 }),
);
