import { jsonFamily } from './request-family';

export const requestFamily = jsonFamily(
	'/api/auth/organization-admin/v1/approval-decide',
	(context) => ({
		organization: context.organizationId,
		requestId: context.challengeId,
		operationId: context.challengeId,
		answer: { kind: 'unprovenCall', decision: 'allow' },
	}),
);
