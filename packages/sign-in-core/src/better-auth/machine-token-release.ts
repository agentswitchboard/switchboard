import { decodeJwt, decodeProtectedHeader } from 'jose';

import type { ProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import {
	machineTokenClaimsSchema,
	machineTokenResponseSchema,
	type MachineLoginConfiguration,
} from '#sign-in-core/machine-login/machine-login-contracts';
import { projectMachineDeviceResponse } from '#sign-in-core/response-release/machine-device-response';

/** Signing may await work after central decided. Recheck its fixed 60-second
 * redemption window at the response boundary; a delayed mint extends nothing. */
export async function releaseMachineTokenResponse(props: {
	readonly response: Response;
	readonly issuer: string;
	readonly configuration: MachineLoginConfiguration;
	readonly state: ProviderRequestState['machineToken'];
	readonly now: () => number;
}): Promise<Response> {
	if (!props.response.ok)
		return projectMachineDeviceResponse('/api/auth/oauth2/token', props.response);
	try {
		if (props.state.kind !== 'granted') throw new Error('Machine decision missing');
		const body = machineTokenResponseSchema.parse(await props.response.clone().json());
		if (decodeProtectedHeader(body.access_token).typ !== 'at+jwt')
			throw new Error('Wrong machine token type');
		const claims = machineTokenClaimsSchema.parse(decodeJwt(body.access_token));
		const now = Math.floor(props.now() / 1000);
		if (
			claims.iss !== props.issuer ||
			claims.aud !== props.configuration.machineAudience ||
			claims.exp <= now ||
			claims.exp <= claims.iat ||
			claims.exp - claims.iat > 3600 ||
			claims.iat > now ||
			now > props.state.decidedAt + 60 ||
			now < props.state.decidedAt ||
			now >= props.state.grantExpiresAt ||
			claims.grant_expires_at !== props.state.grantExpiresAt ||
			claims.principal.machine_id !== props.state.machineId ||
			claims.principal.enrollment_id !== props.state.enrollmentId ||
			claims.organization_id !== props.state.organizationId ||
			claims.client_id !== props.state.clientId ||
			claims.azp !== props.state.clientId ||
			body.machine_client_id !== props.state.clientId ||
			body.fleet_central.receiver !== props.configuration.fleetCentral.receiver ||
			body.fleet_central.relay !== props.configuration.fleetCentral.relay ||
			(Object.hasOwn(claims, 'sid') && claims['sid'] !== null) ||
			Object.hasOwn(claims, 'workspace_id')
		)
			throw new Error('Machine response does not match decision');
		const headers = new Headers(props.response.headers);
		headers.delete('content-length');
		headers.set('cache-control', 'no-store');
		return Response.json(body, { status: props.response.status, headers });
	} catch {
		return Response.json(
			{ error: 'invalid_grant' },
			{ status: 400, headers: { 'cache-control': 'no-store' } },
		);
	}
}
