import { z } from 'zod';

import {
	fleetLoginDiscoveryResponseSchema,
	machineTokenResponseSchema,
} from '#sign-in-core/machine-login/machine-login-contracts';
import {
	machineDeviceCodeResponseSchema,
	machineDeviceErrorResponseSchema,
} from '#sign-in-core/response-release/machine-device-response';

const machineTokenPath = '/api/auth/oauth2/token';
const deviceCodePath = '/api/auth/device/code';

type MachineDeviceError = z.infer<typeof machineDeviceErrorResponseSchema>['error'];

const pollErrors = [
	'authorization_pending',
	'slow_down',
	'access_denied',
	'expired_token',
	'invalid_grant',
	'invalid_client',
	'invalid_request',
	'temporarily_unavailable',
] as const satisfies readonly MachineDeviceError[];

interface MachineDeviceFixtureSchema {
	readonly name: string;
	readonly status: number;
	readonly schema: z.ZodType;
	readonly projectAt?: string;
}

function errorFixtureSchema(error: MachineDeviceError): z.ZodType {
	return machineDeviceErrorResponseSchema.strict().extend({ error: z.literal(error) });
}

const tokenSuccess = machineTokenResponseSchema.strict();

export const machineDeviceFixtureSchemas: readonly MachineDeviceFixtureSchema[] = [
	{ name: 'discovery', status: 200, schema: fleetLoginDiscoveryResponseSchema },
	{
		name: 'device-code-start',
		status: 200,
		schema: machineDeviceCodeResponseSchema.strict(),
		projectAt: deviceCodePath,
	},
	...pollErrors.map((error) => ({
		name: `poll-${error}`,
		status: error === 'temporarily_unavailable' ? 503 : 400,
		schema: errorFixtureSchema(error),
		projectAt: machineTokenPath,
	})),
	{ name: 'token-success', status: 200, schema: tokenSuccess },
	{ name: 'refresh-success', status: 200, schema: tokenSuccess },
	{
		name: 'refresh-invalid_grant',
		status: 400,
		schema: errorFixtureSchema('invalid_grant'),
		projectAt: machineTokenPath,
	},
	{
		name: 'refresh-invalid_client',
		status: 400,
		schema: errorFixtureSchema('invalid_client'),
		projectAt: machineTokenPath,
	},
];

export const machineDeviceFixtureDirectory = new URL(
	'../../contract-fixtures/machine-device-login/',
	import.meta.url,
);
