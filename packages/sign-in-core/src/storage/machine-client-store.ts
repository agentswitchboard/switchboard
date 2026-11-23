import { and, eq } from 'drizzle-orm';

import type { SignInClock, SignInIdSource } from '#sign-in-core/contracts/sign-in-platform';
import {
	machineEnrollmentMetadataSchema,
	parseMachineEnrollmentMetadata,
} from '#sign-in-core/machine-login/machine-login-contracts';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';
import {
	oauthClient,
	oauthClientResource,
	oauthRefreshToken,
	oauthResource,
} from '#sign-in-core/storage/sign-in-schema';

export async function initializeRouterDeviceLoginClient(
	props: MachineClientStoreProps & { readonly routerClientId: string },
): Promise<void> {
	await props
		.openDatabase()
		.insert(oauthClient)
		.values({
			id: props.ids.nextId(),
			clientId: props.routerClientId,
			clientSecret: null,
			tokenEndpointAuthMethod: 'none',
			grantTypes: JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code']),
			scopes: JSON.stringify(['offline_access']),
			redirectUris: '[]',
			skipConsent: true,
			disabled: false,
			metadata: JSON.stringify({ kind: 'routerDeviceLogin' }),
			createdAt: new Date(props.clock.now()),
			updatedAt: new Date(props.clock.now()),
		})
		.onConflictDoNothing();
	const row = (
		await props
			.openDatabase()
			.select()
			.from(oauthClient)
			.where(eq(oauthClient.clientId, props.routerClientId))
	)[0];
	if (
		row === undefined ||
		row.disabled ||
		row.clientSecret !== null ||
		row.tokenEndpointAuthMethod !== 'none' ||
		row.grantTypes !== JSON.stringify(['urn:ietf:params:oauth:grant-type:device_code']) ||
		row.metadata !== JSON.stringify({ kind: 'routerDeviceLogin' })
	)
		throw new Error('Router device client identity conflict');
}

export interface MachineClientStoreProps {
	readonly openDatabase: SignInDatabaseFactory;
	readonly clock: SignInClock;
	readonly ids: SignInIdSource;
	readonly machineAudience: string;
}
export async function readMachineEnrollmentClient(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly clientId: string;
}): Promise<ReturnType<typeof parseMachineEnrollmentMetadata>> {
	const row = (
		await props
			.openDatabase()
			.select({ metadata: oauthClient.metadata })
			.from(oauthClient)
			.where(eq(oauthClient.clientId, props.clientId))
	)[0];
	return row === undefined ? null : parseMachineEnrollmentMetadata(row.metadata);
}

export async function readRefreshCredentialClient(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly credentialDigest: string;
}): Promise<string | null> {
	const [row] = await props
		.openDatabase()
		.select({ clientId: oauthRefreshToken.clientId })
		.from(oauthRefreshToken)
		.where(eq(oauthRefreshToken.token, props.credentialDigest))
		.limit(1);
	return row?.clientId ?? null;
}
/** Only trusted sign-in code writes machine client kind, identity and resource. */
export async function createMachineEnrollmentClient(
	props: MachineClientStoreProps & {
		readonly organizationId: string;
		readonly enrollmentId: string;
	},
): Promise<void> {
	const metadata = machineEnrollmentMetadataSchema.parse({
		kind: 'machineEnrollment',
		organizationId: props.organizationId,
		enrollmentId: props.enrollmentId,
	});
	const createdAt = new Date(props.clock.now());
	await props
		.openDatabase()
		.insert(oauthClient)
		.values({
			id: props.ids.nextId(),
			clientId: props.enrollmentId,
			clientSecret: null,
			tokenEndpointAuthMethod: 'none',
			grantTypes: JSON.stringify(['refresh_token']),
			scopes: JSON.stringify(['offline_access']),
			redirectUris: '[]',
			skipConsent: true,
			disabled: false,
			metadata: JSON.stringify(metadata),
			createdAt,
			updatedAt: createdAt,
		})
		.onConflictDoNothing();
	const row = (
		await props
			.openDatabase()
			.select()
			.from(oauthClient)
			.where(eq(oauthClient.clientId, props.enrollmentId))
	)[0];
	if (
		row === undefined ||
		row.disabled ||
		row.clientSecret !== null ||
		row.tokenEndpointAuthMethod !== 'none' ||
		row.grantTypes !== JSON.stringify(['refresh_token']) ||
		JSON.stringify(parseMachineEnrollmentMetadata(row.metadata)) !== JSON.stringify(metadata)
	)
		throw new Error('Machine client identity conflict');
	await props
		.openDatabase()
		.insert(oauthResource)
		.values({
			id: props.ids.nextId(),
			identifier: props.machineAudience,
			name: 'Fleet machine connection',
			accessTokenTtl: 3600,
			refreshTokenTtl: 2_592_000,
			allowedScopes: JSON.stringify(['offline_access']),
			createdAt,
			updatedAt: createdAt,
		})
		.onConflictDoNothing();
	await props
		.openDatabase()
		.insert(oauthClientResource)
		.values({
			id: props.ids.nextId(),
			clientId: props.enrollmentId,
			resourceId: props.machineAudience,
			createdAt,
		})
		.onConflictDoNothing();
}
export async function disableMachineEnrollmentClient(props: {
	readonly openDatabase: SignInDatabaseFactory;
	readonly clock: SignInClock;
	readonly organizationId: string;
	readonly enrollmentId: string;
	readonly clientId: string;
}): Promise<'disabled' | 'alreadyDisabled' | 'notThisEnrollment'> {
	const row = (
		await props
			.openDatabase()
			.select()
			.from(oauthClient)
			.where(eq(oauthClient.clientId, props.clientId))
	)[0];
	const metadata = row === undefined ? null : parseMachineEnrollmentMetadata(row.metadata);
	if (
		row === undefined ||
		metadata === null ||
		metadata.organizationId !== props.organizationId ||
		metadata.enrollmentId !== props.enrollmentId ||
		props.clientId !== props.enrollmentId
	)
		return 'notThisEnrollment';
	if (row.disabled) return 'alreadyDisabled';
	const updated = await props
		.openDatabase()
		.update(oauthClient)
		.set({ disabled: true, updatedAt: new Date(props.clock.now()) })
		.where(
			and(eq(oauthClient.clientId, props.clientId), eq(oauthClient.metadata, row.metadata ?? '')),
		)
		.returning({ id: oauthClient.id });
	return updated.length === 1 ? 'disabled' : 'notThisEnrollment';
}
