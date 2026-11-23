import type { OAuthClaimExtensionInput } from '@better-auth/oauth-provider';
import { APIError } from 'better-auth/api';
import { z } from 'zod';

import type { MachineLoginProviderProps } from '#sign-in-core/better-auth/machine-login-provider-context';
import type { MachineTokenClaims } from '#sign-in-core/central-link/generated/central-sign-in.gen';
import {
	machineEnrollmentMetadataSchema,
	machineTokenDecisionSchema,
	parseMachineEnrollmentMetadata,
} from '#sign-in-core/machine-login/machine-login-contracts';
import { disableMachineEnrollmentClient } from '#sign-in-core/storage/machine-client-store';

/** The reference belongs to the persisted token family. No request field routes
 * a machine grant; the client metadata must independently name that reference. */
export async function contributeMachineTokenClaims(
	login: MachineLoginProviderProps,
	input: OAuthClaimExtensionInput,
): Promise<Record<string, unknown>> {
	const metadata = parseMachineEnrollmentMetadata(input.metadata);
	if (metadata === null) return {};
	const reference = z.string().parse(input.referenceId).split(':');
	const family = machineEnrollmentMetadataSchema
		.pick({ organizationId: true, enrollmentId: true })
		.parse({
			organizationId: reference.length === 2 ? reference[0] : undefined,
			enrollmentId: reference[1],
		});
	if (
		family.organizationId !== metadata.organizationId ||
		family.enrollmentId !== metadata.enrollmentId ||
		input.client.clientId !== metadata.enrollmentId ||
		input.resources?.length !== 1 ||
		input.resources[0] !== login.configuration.machineAudience
	)
		throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
	const reply = await login.decisions.decideMachineToken({
		...family,
		clientId: metadata.enrollmentId,
	});
	if (reply.kind !== 'answered')
		throw new APIError('SERVICE_UNAVAILABLE', { error: 'temporarily_unavailable' });
	const decision = machineTokenDecisionSchema.parse(reply.decision);
	if (decision.result === 'refuse') {
		if (['enrollmentNotActive', 'superseded', 'idleExpired'].includes(decision.reason.kind))
			await disableMachineEnrollmentClient({
				...login,
				...family,
				clientId: metadata.enrollmentId,
				clock: login.platform.clock,
			});
		throw new APIError('BAD_REQUEST', { error: 'invalid_grant', reason: decision.reason });
	}
	const now = Math.floor(login.platform.clock.now() / 1000);
	if (
		decision.enrollmentId !== family.enrollmentId ||
		decision.decidedAt > now ||
		now > decision.decidedAt + 60 ||
		decision.grantExpiresAt <= now ||
		decision.grantExpiresAt > decision.decidedAt + 3600
	)
		throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
	if (decision.superseded !== undefined)
		await disableMachineEnrollmentClient({
			...login,
			organizationId: family.organizationId,
			...decision.superseded,
			clock: login.platform.clock,
		});
	login.requestState.machineToken = {
		kind: 'granted',
		...family,
		machineId: decision.machineId,
		clientId: metadata.enrollmentId,
		decidedAt: decision.decidedAt,
		grantExpiresAt: decision.grantExpiresAt,
	};
	return {
		principal: {
			kind: 'machine',
			machine_id: decision.machineId,
			enrollment_id: family.enrollmentId,
		},
		organization_id: family.organizationId,
		grant_expires_at: decision.grantExpiresAt,
	} satisfies MachineTokenClaims;
}
