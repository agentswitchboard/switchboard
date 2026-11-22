import type { BetterAuthPlugin, GenericEndpointContext } from '@better-auth/core';
import {
	APIError,
	createAuthEndpoint,
	formCsrfMiddleware,
	originCheckMiddleware,
} from 'better-auth/api';
import { z } from 'zod';

import {
	authorizeMachineDeviceAction,
	type MachineLoginProviderProps,
} from '#sign-in-core/better-auth/machine-login-provider-context';
import { decideDeviceApproval } from '#sign-in-core/machine-login/device-approval-rule';
import {
	approveDeviceRequestSchema,
	denyDeviceRequestSchema,
} from '#sign-in-core/machine-login/machine-device-requests';
import {
	decideDeviceLoginSchema,
	deviceLoginDecisionSchema,
	type MachineDeviceApprovalResult,
} from '#sign-in-core/machine-login/machine-login-contracts';
import { recordDeviceCodeDecision } from '#sign-in-core/storage/device-code-store';

export function machineDeviceDecisionEndpoints(
	login: MachineLoginProviderProps,
): NonNullable<BetterAuthPlugin['endpoints']> {
	const shared = { method: 'POST' as const, use: [originCheckMiddleware, formCsrfMiddleware] };
	return {
		approveMachineDevice: createAuthEndpoint(
			'/machine-login/approve',
			{ ...shared, body: approveDeviceRequestSchema },
			async (context): Promise<MachineDeviceApprovalResult> => {
				const action = await requireDeviceDecision(context, login, 'approve');
				const organizationId = action.record.organizationId;
				// The workspace list constrains a new approval. Central owns a replay's stored snapshot.
				if (action.record.status === 'pending') {
					const workspaces =
						context.request === undefined
							? { result: 'unavailable' as const }
							: await login.listWorkspaces({ request: context.request, organizationId });
					if (workspaces.result === 'unavailable')
						throw new APIError('SERVICE_UNAVAILABLE', { error: 'temporarily_unavailable' });
					if (workspaces.result === 'refused')
						throw new APIError('FORBIDDEN', { error: 'access_denied' });
					const activeIds = new Set(
						workspaces.workspaces
							.filter((row) => row.state === 'active')
							.map((row) => row.workspaceId),
					);
					if (context.body.allowedWorkspaces.some((workspaceId) => !activeIds.has(workspaceId)))
						throw new APIError('FORBIDDEN', {
							error: 'access_denied',
							reason: { kind: 'unknownWorkspace' },
						});
				}
				const request = decideDeviceLoginSchema.parse({
					organizationId,
					approver: action.approver,
					permissionChecked: 'machine:enroll',
					requestId: action.record.id,
					machineId: action.record.machineId,
					label: action.record.machineLabel,
					allowedWorkspaces: context.body.allowedWorkspaces,
					approverSecondFactorAt:
						action.secondFactorAt === null ? null : Math.floor(action.secondFactorAt / 1000),
					codeExpiresAt: Math.floor(action.record.expiresAt.getTime() / 1000),
				});
				const reply = await login.decisions.decideDeviceLogin(request);
				const parsed =
					reply.kind === 'answered' ? deviceLoginDecisionSchema.safeParse(reply.decision) : null;
				if (parsed === null || !parsed.success)
					throw new APIError('SERVICE_UNAVAILABLE', { error: 'temporarily_unavailable' });
				const decision = parsed.data;
				if (decision.result === 'refused')
					throw new APIError(
						decision.reason.kind === 'requestConflict' ? 'CONFLICT' : 'FORBIDDEN',
						{
							error: 'access_denied',
							reason: decision.reason,
						},
					);
				if (
					!(await recordDeviceCodeDecision({
						openDatabase: login.openDatabase,
						id: action.record.id,
						approver: action.approver,
						now: login.platform.clock.now(),
						decision: { kind: 'approve', enrollmentId: decision.enrollmentId },
					}))
				)
					throw new APIError('CONFLICT', { error: 'already_decided' });
				const result: MachineDeviceApprovalResult = {
					enrollmentId: decision.enrollmentId,
					label: decision.label,
					allowedWorkspaces: decision.allowedWorkspaces,
				};
				return context.json(result);
			},
		),
		denyMachineDevice: createAuthEndpoint(
			'/machine-login/deny',
			{ ...shared, body: denyDeviceRequestSchema },
			async (context): Promise<{ readonly success: true }> => {
				const action = await requireDeviceDecision(context, login, 'deny');
				if (
					!(await recordDeviceCodeDecision({
						openDatabase: login.openDatabase,
						id: action.record.id,
						approver: action.approver,
						now: login.platform.clock.now(),
						decision: { kind: 'deny' },
					}))
				)
					throw new APIError('CONFLICT', { error: 'already_decided' });
				return context.json({ success: true });
			},
		),
	};
}

async function requireDeviceDecision(
	context: GenericEndpointContext,
	login: MachineLoginProviderProps,
	action: 'approve' | 'deny',
): ReturnType<typeof authorizeMachineDeviceAction> {
	const { userCode } = z.object({ userCode: z.string() }).parse(context.body);
	const facts = await authorizeMachineDeviceAction({ context, login, userCode });
	const decision = decideDeviceApproval({
		...facts,
		action,
		code: facts.record,
		now: login.platform.clock.now(),
	});
	if (decision.kind === 'refuse') {
		switch (decision.reason.kind) {
			case 'notPermitted':
			case 'secondFactorRequired':
				throw new APIError('FORBIDDEN', { error: 'access_denied', reason: decision.reason });
			case 'alreadyDecided':
				throw new APIError('CONFLICT', { error: 'already_decided' });
			case 'deviceNotVerified':
				throw new APIError('BAD_REQUEST', { error: 'device_not_verified' });
			case 'expired':
				throw new APIError('BAD_REQUEST', { error: 'expired_token' });
			default:
				return decision.reason satisfies never;
		}
	}
	return facts;
}
