import type { GenericEndpointContext, BetterAuthPlugin } from '@better-auth/core';
import {
	DEVICE_CODE_GRANT_TYPE,
	extendOAuthProvider,
	getOAuthProviderApi,
	type OAuthProviderExtension,
} from '@better-auth/oauth-provider';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import {
	deviceAuthorization,
	redeemDeviceCode,
	type DeviceAuthorizationGrant,
	type DeviceAuthorizationRequest,
} from 'better-auth/plugins/device-authorization';
import { z } from 'zod';

import { machineDeviceDecisionEndpoints } from '#sign-in-core/better-auth/machine-device-decisions';
import {
	authorizeMachineDeviceAction,
	machineDeviceRecordSchema,
	type MachineLoginProviderProps,
} from '#sign-in-core/better-auth/machine-login-provider-context';
import { contributeMachineTokenClaims } from '#sign-in-core/better-auth/machine-token-contributor';
import { providerMachineExtensionFields } from '#sign-in-core/better-auth/provider-machine-extension-fields';
import { machineDeviceFields } from '#sign-in-core/machine-login/machine-device-requests';
import {
	createMachineEnrollmentClient,
	initializeRouterDeviceLoginClient,
} from '#sign-in-core/storage/machine-client-store';

export function createMachineLoginPlugin(login: MachineLoginProviderProps): BetterAuthPlugin {
	const grant = {
		// The provider carries the grant fields to authorizeRequest for its policy check.
		requestSchemaFields: providerMachineExtensionFields,
		deviceCodeSchemaFields: {
			machineId: { type: 'string', required: true },
			machineLabel: { type: 'string', required: true },
			organizationId: { type: 'string', required: true },
			enrollmentId: { type: 'string', required: false },
		},
		async authorizeRequest({
			ctx,
			request,
		}: {
			ctx: GenericEndpointContext;
			request: DeviceAuthorizationRequest;
		}) {
			const parsed = z.object(machineDeviceFields).safeParse(request);
			if (!parsed.success) throw new APIError('BAD_REQUEST', { error: 'invalid_request' });
			const fields = parsed.data;
			if (
				request.client_id !== login.configuration.routerClientId ||
				request.user_id !== undefined ||
				(request.scope !== undefined && request.scope !== 'offline_access')
			)
				throw new APIError('BAD_REQUEST', { error: 'invalid_request' });
			const client = await getOAuthProviderApi(
				ctx,
				login.providerOptions(),
				DEVICE_CODE_GRANT_TYPE,
			).authenticateClient({ scopes: ['offline_access'], requireCredentials: false });
			if (client.clientId !== login.configuration.routerClientId)
				throw new APIError('BAD_REQUEST', { error: 'invalid_client' });
			request.scope = 'offline_access';
			return {
				clientId: client.clientId,
				deviceCodeFields: {
					machineId: fields.machine_id,
					machineLabel: fields.machine_label,
					organizationId: fields.organization_id,
				},
			};
		},
		assertSessionRedemption(): never {
			throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
		},
		getVerificationContext(record) {
			const code = machineDeviceRecordSchema.parse(record);
			return { machine_label: code.machineLabel, organization_id: code.organizationId };
		},
	} satisfies DeviceAuthorizationGrant;
	const native = deviceAuthorization({
		grant,
		expiresIn: '10m',
		interval: '5s',
		verificationUri: '/device',
	});
	const extension: OAuthProviderExtension = {
		metadata: ({ ctx }) => ({
			device_authorization_endpoint: `${ctx.context.baseURL}/device/code`,
		}),
		claims: { accessToken: (input) => contributeMachineTokenClaims(login, input) },
		grants: {
			[DEVICE_CODE_GRANT_TYPE]: async ({ ctx, provider }) => {
				const body = z.object({ device_code: z.string(), client_id: z.string() }).parse(ctx.body);
				const calling = await provider.authenticateClient({ requireCredentials: false });
				if (
					calling.clientId !== login.configuration.routerClientId ||
					body.client_id !== calling.clientId
				)
					throw new APIError('BAD_REQUEST', { error: 'invalid_client' });
				const redeemed = await redeemDeviceCode({
					ctx,
					deviceCode: body.device_code,
					authorizeRedemption: (record) => {
						const code = machineDeviceRecordSchema.parse(record);
						if (code.clientId !== calling.clientId)
							throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
						return {
							ownershipWhere: { field: 'clientId', value: calling.clientId },
							context: code,
						};
					},
					prepareRedemption: (_record, code) => {
						if (code.expiresAt.getTime() <= login.platform.clock.now())
							throw new APIError('BAD_REQUEST', { error: 'expired_token' });
						if (code.enrollmentId === undefined || code.enrollmentId === null)
							throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
						return { organizationId: code.organizationId, enrollmentId: code.enrollmentId };
					},
				});
				const reference = redeemed.redemptionContext;
				await createMachineEnrollmentClient({
					...login,
					...reference,
					ids: login.platform.ids,
					clock: login.platform.clock,
					machineAudience: login.configuration.machineAudience,
				});
				const client = await provider.getClient(reference.enrollmentId);
				if (client === null || client.disabled)
					throw new APIError('BAD_REQUEST', { error: 'invalid_client' });
				return provider.issueTokens({
					client,
					user: redeemed.user,
					scopes: ['offline_access'],
					resources: [login.configuration.machineAudience],
					referenceId: `${reference.organizationId}:${reference.enrollmentId}`,
					tokenResponse: {
						machine_client_id: reference.enrollmentId,
						fleet_central: login.configuration.fleetCentral,
					},
				});
			},
		},
	};
	return {
		...native,
		endpoints: { ...native.endpoints, ...machineDeviceDecisionEndpoints(login) },
		async init(context): Promise<void> {
			await initializeRouterDeviceLoginClient({
				...login,
				ids: login.platform.ids,
				clock: login.platform.clock,
				machineAudience: login.configuration.machineAudience,
				routerClientId: login.configuration.routerClientId,
			});
			extendOAuthProvider(context, extension);
		},
		hooks: {
			before: [
				{
					matcher: (context) => context.path === '/device',
					handler: createAuthMiddleware(async (context) => {
						const query = z.object({ user_code: z.string() }).parse(context.query);
						const action = await authorizeMachineDeviceAction({
							context,
							login,
							userCode: query.user_code,
						});
						if (
							!action.permitted ||
							(action.record.userId !== null && action.record.userId !== action.approver)
						)
							throw new APIError('FORBIDDEN', { error: 'access_denied' });
						if (
							action.record.status !== 'pending' ||
							action.record.expiresAt.getTime() <= login.platform.clock.now()
						)
							throw new APIError('BAD_REQUEST', { error: 'invalid_request' });
					}),
				},
			],
		},
	};
}
