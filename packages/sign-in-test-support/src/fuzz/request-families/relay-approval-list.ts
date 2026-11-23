import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/organization-admin/v1/approval-list',
	(context) => ({ organization: context.organizationId, filter: 'waiting', cursor: null }),
);
