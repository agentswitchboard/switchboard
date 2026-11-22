import type { GenericEndpointContext } from '@better-auth/core';
import { decodeBasicCredentials } from '@better-auth/core/oauth2';
import type { OAuthProviderApi } from '@better-auth/oauth-provider';
import { APIError } from 'better-auth/api';
import { z } from 'zod';

import { readRefreshCredentialClient } from '#sign-in-core/storage/machine-client-store';
import type { SignInDatabaseFactory } from '#sign-in-core/storage/models/sign-in-database';

const clientKindSchema = z.object({ kind: z.enum(['machineEnrollment', 'routerDeviceLogin']) });

function isMachineClientMetadata(metadata: unknown): boolean {
	const value: unknown = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
	return clientKindSchema.safeParse(value).success;
}

/** Revoke's native replay branch acts on the requesting client before checking
 * the token's client. Both immutable client facts must be checked before it. */
export async function refuseMachineRevocation(props: {
	readonly context: GenericEndpointContext;
	readonly provider: Pick<OAuthProviderApi, 'getClient' | 'hashToken'>;
	readonly routerClientId: string;
	readonly openDatabase: SignInDatabaseFactory;
}): Promise<void> {
	if (props.context.path !== '/oauth2/revoke') return;
	const body = z
		.object({ client_id: z.string().optional(), token: z.string() })
		.parse(props.context.body);
	const authorization = props.context.headers?.get('authorization');
	let basicClientId: string | undefined;
	if (authorization !== undefined && authorization !== null && /^Basic +/iu.test(authorization)) {
		try {
			basicClientId = decodeBasicCredentials(authorization).clientId;
		} catch {
			throw new APIError('BAD_REQUEST', { error: 'invalid_client' });
		}
	}
	const requestingClientIds = [body.client_id, basicClientId];
	const requestingMachine = await Promise.all(
		requestingClientIds.map(async (clientId): Promise<boolean> => {
			if (clientId === undefined) return false;
			const client = await props.provider.getClient(clientId);
			return (
				clientId === props.routerClientId ||
				(client !== null && isMachineClientMetadata(client.metadata))
			);
		}),
	);
	if (requestingMachine.some(Boolean))
		throw new APIError('FORBIDDEN', { error: 'machine_revocation_forbidden' });
	const clientId = await readRefreshCredentialClient({
		openDatabase: props.openDatabase,
		credentialDigest: await props.provider.hashToken(body.token, 'refresh_token'),
	});
	if (clientId === null) return;
	const tokenClient = await props.provider.getClient(clientId);
	if (tokenClient !== null && isMachineClientMetadata(tokenClient.metadata))
		throw new APIError('FORBIDDEN', { error: 'machine_revocation_forbidden' });
}
