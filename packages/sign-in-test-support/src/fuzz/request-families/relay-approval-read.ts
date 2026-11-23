import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/organization-admin/v1/approval-read',
	(context) => ({ organization: context.organizationId, requestId: context.challengeId }),
);
