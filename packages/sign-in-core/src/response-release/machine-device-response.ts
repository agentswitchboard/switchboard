import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import {
	deviceLoginRefusalSchema,
	machineDeviceApprovalResultSchema,
	machineLabelSchema,
} from '#sign-in-core/machine-login/machine-login-contracts';

const deviceCodeResponse = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.url(),
	verification_uri_complete: z.url(),
	expires_in: z.number().int().positive(),
	interval: z.number().int().positive(),
});
const verifyDeviceResponse = z.object({
	user_code: z.string().min(1),
	status: z.enum(['pending', 'approved', 'denied']),
	machine_label: machineLabelSchema.optional(),
	organization_id: uuid7Schema.optional(),
	client_id: uuid7Schema.optional(),
	scope: z.literal('offline_access').optional(),
});
const knownDeviceError = z.enum([
	'invalid_request',
	'invalid_client',
	'invalid_grant',
	'invalid_target',
	'unsupported_grant_type',
	'expired_token',
	'unauthorized',
	'access_denied',
	'already_decided',
	'already_deciding',
	'device_not_verified',
	'authorization_pending',
	'slow_down',
	'machine_revocation_forbidden',
	'temporarily_unavailable',
]);
const deviceErrorBody = z.object({
	error: knownDeviceError,
	reason: deviceLoginRefusalSchema.optional(),
});

export async function projectMachineDeviceResponse(
	pathname: string,
	response: Response,
): Promise<Response> {
	const headers = machineResponseHeaders(response);
	if (!response.ok) {
		const parsed = deviceErrorBody.safeParse(await response.json().catch(() => null));
		const error = response.status >= 500 ? 'temporarily_unavailable' : 'invalid_request';
		return Response.json(parsed.success ? parsed.data : { error }, {
			status: response.status,
			headers,
		});
	}
	if (pathname === '/api/auth/oauth2/revoke') return new Response(null, { status: 200, headers });
	const schema = machineResponseSchema(pathname);
	if (schema === null) return response;
	const parsed = schema.safeParse(await response.json().catch(() => null));
	return parsed.success
		? Response.json(parsed.data, { status: response.status, headers })
		: Response.json({ error: 'temporarily_unavailable' }, { status: 503, headers });
}

/** Only protocol cache and retry headers cross from the native handler. */
export function machineResponseHeaders(response: Response): Headers {
	const headers = new Headers({ 'cache-control': 'no-store', pragma: 'no-cache' });
	const retry = response.headers.get('retry-after');
	if (retry !== null && /^\d+$/u.test(retry)) headers.set('retry-after', retry);
	return headers;
}

function machineResponseSchema(pathname: string): z.ZodType | null {
	switch (pathname) {
		case '/api/auth/device/code':
			return deviceCodeResponse;
		case '/api/auth/device':
			return verifyDeviceResponse;
		case '/api/auth/machine-login/approve':
			return machineDeviceApprovalResultSchema.strip();
		case '/api/auth/machine-login/deny':
			return z.object({ success: z.literal(true) });
		default:
			return null;
	}
}
