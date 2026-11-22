import type { GenericEndpointContext } from '@better-auth/core';
import type { OAuthOptions, Scope } from '@better-auth/oauth-provider';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { z } from 'zod';

import { checkOrganizationPermission } from '#sign-in-core/better-auth/organization-permission-check';
import type { ProviderRequestState } from '#sign-in-core/better-auth/provider-request-state';
import { requireStoredValue } from '#sign-in-core/better-auth/store-result-adapters';
import type { ListWorkspaces } from '#sign-in-core/central-link/list-workspaces';
import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import { normalizeDeviceUserCode } from '#sign-in-core/machine-login/device-user-code';
import {
	machineLabelSchema,
	type MachineLoginConfiguration,
	type MachineLoginDecisions,
} from '#sign-in-core/machine-login/machine-login-contracts';
import { readDeviceCodeForDecision } from '#sign-in-core/storage/device-code-store';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import {
	organizationIdSchema,
	personIdSchema,
	type SignInStore,
} from '#sign-in-core/storage/models/sign-in-store';

export interface MachineLoginProviderProps {
	readonly configuration: MachineLoginConfiguration;
	readonly decisions: MachineLoginDecisions;
	readonly listWorkspaces: ListWorkspaces;
	readonly platform: Pick<SignInPlatform, 'clock' | 'ids'>;
	readonly openDatabase: SignInDatabaseFactory;
	readonly store: SignInStore;
	readonly requestState: ProviderRequestState;
	readonly providerOptions: () => OAuthOptions<Scope[]>;
}
export const machineDeviceRecordSchema = z.object({
	id: uuid7Schema,
	deviceCode: z.string(),
	userCode: z.string(),
	clientId: z.string(),
	status: z.enum(['pending', 'approved', 'denied']),
	userId: z.string().nullable().default(null),
	expiresAt: z.date(),
	machineId: uuid7Schema,
	machineLabel: machineLabelSchema,
	organizationId: organizationIdSchema,
	enrollmentId: uuid7Schema.nullable().optional(),
});
export type MachineDeviceRecord = z.infer<typeof machineDeviceRecordSchema>;

/** The native verify handler claims the user's slot only after this live check. */
export async function authorizeMachineDeviceAction(props: {
	readonly context: GenericEndpointContext;
	readonly login: MachineLoginProviderProps;
	readonly userCode: string;
}): Promise<{
	readonly record: MachineDeviceRecord;
	readonly approver: z.infer<typeof uuid7Schema>;
	readonly permitted: boolean;
	readonly secondFactorAt: number | null;
}> {
	if (props.context.headers?.has('authorization')) throw new APIError('FORBIDDEN');
	const stored = await readDeviceCodeForDecision({
		openDatabase: props.login.openDatabase,
		userCode: normalizeDeviceUserCode(props.userCode),
	});
	if (stored === null) throw new APIError('BAD_REQUEST', { error: 'invalid_request' });
	const record = machineDeviceRecordSchema.parse(stored);
	if (record.clientId !== props.login.configuration.routerClientId)
		throw new APIError('BAD_REQUEST', { error: 'invalid_request' });
	const current = await getSessionFromCtx(props.context, { disableCookieCache: true });
	if (current === null || !current.user.emailVerified) throw new APIError('UNAUTHORIZED');
	const approver = personIdSchema.parse(current.user.id);
	const sessionId = uuid7Schema.parse(current.session.id);
	const live = requireStoredValue(
		await props.login.store.persons.readPersonSession(approver, sessionId),
	);
	if (live === null) throw new APIError('UNAUTHORIZED');
	if (live.session.activeOrganizationId !== record.organizationId)
		throw new APIError('FORBIDDEN', { error: 'access_denied' });
	const permitted = requireStoredValue(
		await checkOrganizationPermission({
			context: props.context,
			personId: approver,
			organizationId: record.organizationId,
			permission: 'machine:enroll',
			readMemberRole: props.login.store.organizations.readMemberRole,
		}),
	);
	const factor = requireStoredValue(
		await props.login.store.factors.readSession(approver, sessionId),
	);
	if (factor === null) throw new APIError('UNAUTHORIZED');
	return {
		record,
		approver,
		permitted,
		secondFactorAt: factor.confirmation.kind === 'confirmed' ? factor.confirmation.at : null,
	};
}
