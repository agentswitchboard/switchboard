import { formFamily, jsonFamily, queryFamily, type RequestFamilyContext } from './request-family';

function issuerOrigin(context: RequestFamilyContext): Readonly<Record<string, string>> {
	return { origin: new URL(context.issuer).origin };
}

export const machineLoginFamilies = [
	queryFamily('/.well-known/fleet-login', () => ({})),
	queryFamily('/device', (context) => ({ user_code: context.machineUserCode })),
	queryFamily('/api/auth/device', (context) => ({ user_code: context.machineUserCode })),
	formFamily(
		'/api/auth/device/code',
		(context) => ({
			client_id: context.machineRouterClientId,
			machine_id: context.machineId,
			machine_label: 'Fuzz machine',
			organization_id: context.organizationId,
			scope: 'offline_access',
		}),
		true,
		issuerOrigin,
	),
	jsonFamily('/api/auth/machine-login/approve', (context) => ({
		userCode: context.machineUserCode,
		allowedWorkspaces: [],
	})),
	formFamily(
		'/api/auth/machine-login/deny',
		(context) => ({ userCode: context.machineUserCode }),
		true,
		issuerOrigin,
	),
	jsonFamily('/api/auth/organization-admin/revoke-machine-enrollment', (context) => ({
		organizationId: context.organizationId,
		enrollmentId: context.machineEnrollmentId,
	})),
	formFamily(
		'/api/auth/oauth2/revoke',
		(context) => ({
			client_id: context.machineEnrollmentId,
			token: 'unissued-machine-token',
			token_type_hint: 'refresh_token',
		}),
		true,
	),
] as const;
