import type { ReachableRouteGroup } from '#sign-in-test-support/fuzz/route-classification-types';

// Transcribed from the machine handlers and permanent host proof.
export const machineRouteGroups: readonly ReachableRouteGroup[] = [
	{
		method: 'GET',
		paths: ['/.well-known/fleet-login'],
		exposure: ['signed-out', 'member', 'owner'],
		requestParts: ['query'],
		documentedAnswers: [200, 400, 429],
		disclosure:
			'The configured public Router client identifier and HTTPS organization link template.',
		permittedRefusalEffects: ['none'],
		evidence: 'sign-in-http-handler.ts; machine-request-admission.host.e2e.test.ts',
	},
	{
		method: 'GET',
		paths: ['/device'],
		exposure: ['signed-out', 'member', 'owner'],
		requestParts: ['query'],
		documentedAnswers: [200, 303, 400, 403, 429],
		disclosure:
			'Sign-in or approval page. The pending list is limited to the permitted approver and active organization.',
		permittedRefusalEffects: ['none', 'expired-session-cleanup', 'cookie-delete'],
		evidence: 'device-approval-page.ts; machine-device-login.host.e2e.test.ts',
	},
	{
		method: 'POST',
		paths: ['/api/auth/device/code'],
		exposure: ['signed-out', 'member', 'owner', 'cli'],
		requestParts: ['form', 'json'],
		documentedAnswers: [200, 400, 401, 403, 415, 429],
		disclosure:
			'A successful Router client request receives only its new device code, user code and verification metadata.',
		permittedRefusalEffects: ['none'],
		evidence:
			'machine-login-plugin.ts; machine-device-response.ts; machine-device-login.host.e2e.test.ts',
	},
	{
		method: 'GET',
		paths: ['/api/auth/device'],
		exposure: ['owner'],
		requestParts: ['query'],
		documentedAnswers: [200, 400, 401, 403, 429],
		disclosure:
			'The matched device approval context for an authorized approver in the active organization.',
		permittedRefusalEffects: ['none', 'expired-session-cleanup', 'cookie-delete'],
		evidence:
			'machine-login-plugin.ts; machine-login-provider-context.ts; machine-device-response.ts',
	},
	{
		method: 'POST',
		paths: ['/api/auth/machine-login/approve'],
		deviceDecisionRefusal: 'approve',
		exposure: ['owner'],
		requestParts: ['json'],
		documentedAnswers: [200, 400, 401, 403, 409, 415, 429],
		disclosure: 'Only the approved enrollment ID, display label and selected workspaces.',
		permittedRefusalEffects: ['none'],
		evidence:
			'machine-device-decisions.ts; machine-device-response.ts; machine-decision-claim.host.e2e.test.ts',
	},
	{
		method: 'POST',
		paths: ['/api/auth/machine-login/deny'],
		deviceDecisionRefusal: 'deny',
		exposure: ['owner'],
		requestParts: ['form', 'json'],
		documentedAnswers: [200, 400, 401, 403, 409, 415, 429],
		disclosure: 'Only acknowledgment of the caller’s denial.',
		permittedRefusalEffects: ['none'],
		evidence:
			'machine-device-decisions.ts; machine-device-response.ts; machine-decision-claim.host.e2e.test.ts',
	},
	{
		method: 'POST',
		paths: ['/api/auth/organization-admin/revoke-machine-enrollment'],
		exposure: ['member', 'owner'],
		requestParts: ['json'],
		documentedAnswers: [200, 400, 403, 429],
		disclosure:
			'The revocation result or a domain refusal. Only a caller with machine:revoke on that organization can end an enrollment.',
		permittedRefusalEffects: ['none'],
		evidence: 'fleet-admin-forwarding.ts; machine-device-login.host.e2e.test.ts',
	},
	{
		method: 'POST',
		paths: ['/api/auth/oauth2/revoke'],
		exposure: ['cli'],
		requestParts: ['form', 'json'],
		documentedAnswers: [200, 400, 401, 403, 415, 429],
		disclosure: 'An empty revocation acknowledgment or a credential-free refusal.',
		permittedRefusalEffects: ['none'],
		evidence:
			'machine-revocation-hook.ts; machine-device-response.ts; machine-device-login.host.e2e.test.ts',
	},
];
