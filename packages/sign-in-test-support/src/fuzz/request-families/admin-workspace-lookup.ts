import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/organization-admin/workspace-lookup',
	(context) => ({ organizationId: context.organizationId, workspaceId: context.challengeId }),
);
