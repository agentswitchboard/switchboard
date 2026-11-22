import { z } from 'zod';

import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { parseDeviceUserCode } from '#sign-in-core/machine-login/device-user-code';
import { machineLabelSchema } from '#sign-in-core/machine-login/machine-login-contracts';

export const machineDeviceFields = {
	machine_id: uuid7Schema,
	machine_label: machineLabelSchema,
	organization_id: uuid7Schema,
};

export const revokeMachineEnrollmentPublicPath =
	'/api/auth/organization-admin/revoke-machine-enrollment';

const deviceCodeRequestSchema = z.strictObject({
	client_id: uuid7Schema,
	scope: z.literal('offline_access').optional(),
	...machineDeviceFields,
});

const userCodeSchema = z.string().refine((code) => parseDeviceUserCode(code) !== null);
export const verifyDeviceRequestSchema = z.strictObject({ user_code: userCodeSchema });
export const denyDeviceRequestSchema = z.strictObject({ userCode: userCodeSchema });
export const approveDeviceRequestSchema = denyDeviceRequestSchema.extend({
	allowedWorkspaces: z
		.array(uuid7Schema)
		.max(100)
		.refine((ids) => new Set(ids).size === ids.length),
});

const deviceTokenRequestSchema = z.strictObject({
	grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
	client_id: uuid7Schema,
	device_code: z.string().min(1).max(512),
});
const refreshMachineTokenRequestSchema = z.strictObject({
	grant_type: z.literal('refresh_token'),
	client_id: uuid7Schema,
	refresh_token: z.string().min(1).max(8192),
	resource: z.string().optional(),
	scope: z.literal('offline_access').optional(),
});
const machineRevocationRequestSchema = z.strictObject({
	client_id: z.string().min(1).optional(),
	token: z.string().min(1).max(8192),
	token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
});
const machineTokenRequestSchema = z.discriminatedUnion('grant_type', [
	deviceTokenRequestSchema,
	refreshMachineTokenRequestSchema,
]);

export function isMachineLoginRoute(pathname: string, method: string): boolean {
	switch (pathname) {
		case '/.well-known/fleet-login':
		case '/device':
		case '/api/auth/device':
			return method === 'GET';
		case '/api/auth/device/code':
		case '/api/auth/machine-login/approve':
		case '/api/auth/machine-login/deny':
		case revokeMachineEnrollmentPublicPath:
		case '/api/auth/oauth2/revoke':
			return method === 'POST';
		default:
			return false;
	}
}

export async function machineDeviceRequestIsValid(
	request: Request,
	machineToken: boolean,
): Promise<boolean> {
	const { pathname, searchParams } = new URL(request.url);
	switch (pathname) {
		case '/.well-known/fleet-login':
			return searchParams.size === 0;
		case '/device':
			return strictParameters(searchParams, verifyDeviceRequestSchema.partial());
		case '/api/auth/device':
			return strictParameters(searchParams, verifyDeviceRequestSchema);
		case '/api/auth/device/code':
			return await strictBody(request, deviceCodeRequestSchema);
		case '/api/auth/machine-login/approve':
			return await strictBody(request, approveDeviceRequestSchema);
		case '/api/auth/machine-login/deny':
			return await strictBody(request, denyDeviceRequestSchema);
		case '/api/auth/oauth2/revoke':
			return await strictBody(request, machineRevocationRequestSchema);
		case '/api/auth/oauth2/token':
			return !machineToken || (await strictBody(request, machineTokenRequestSchema));
		default:
			return true;
	}
}

function strictParameters(parameters: URLSearchParams, schema: z.ZodType): boolean {
	const entries = Array.from(parameters);
	return (
		new Set(entries.map(([name]) => name)).size === entries.length &&
		schema.safeParse(Object.fromEntries(entries)).success
	);
}

async function strictBody(request: Request, schema: z.ZodType): Promise<boolean> {
	const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
	try {
		if (contentType === 'application/json') {
			const body: unknown = await request.clone().json();
			return schema.safeParse(body).success;
		}
		if (contentType === 'application/x-www-form-urlencoded')
			return strictParameters(new URLSearchParams(await request.clone().text()), schema);
		return false;
	} catch {
		return false;
	}
}
