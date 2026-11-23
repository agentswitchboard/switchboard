import { organization } from '@agent-collaboration/sign-in-core';
import { createSignInProvider } from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { nativeProofCookie } from '#sign-in-test-support/storage-cases/organization-provider-proof';
import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import { createStoragePerson } from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

/** Native plugin insertion and the real stored state; central remains a named
 * controlled stand-in. This claims no Fleet-central integration. */
export async function nativeOrganizationProvisioning(
	context: StorageCaseContext,
): Promise<unknown> {
	const previousTime = context.platform.clock.now();
	context.setTime(controlledSignInClock.now());
	try {
		const ownerId = await createStoragePerson(context, storageCaseOwnerEmail);
		const cookie = await nativeProofCookie({
			context,
			personId: ownerId,
			organizationId: context.platform.ids.nextId(),
			confirmation: 'app',
		});
		const answers = [
			{ kind: 'unknown', reason: 'unavailable' },
			{ kind: 'unknown', reason: 'timeout' },
			{ kind: 'unknown', reason: 'malformed-reply' },
			{ kind: 'provisioned' },
		] as const;
		const observations = await Promise.all(
			answers.map(async (answer) => {
				let observedBeforeReply = 'absent';
				const properties = storageProviderProperties(context, context.platform.ids.nextId());
				const provider = createSignInProvider({
					...properties,
					authority: { kind: 'public' },
					platform: {
						...context.platform,
						centralClient: {
							readStatementDigest: async () => ({ kind: 'unavailable', reason: 'unavailable' }),
							pushAuthorizationRevision: async () => ({ kind: 'unknown', reason: 'unavailable' }),
							sendFleetAdminRequest: async () => ({
								kind: 'unknown' as const,
								reason: 'unavailable' as const,
							}),
							relayFleetAdminRequest: async () => ({
								kind: 'unknown' as const,
								reason: 'unavailable' as const,
							}),
							sendApprovalPersonRequest: async () => ({
								kind: 'unknown' as const,
								reason: 'unavailable' as const,
							}),
							relayApprovalPersonRequest: async () => ({
								kind: 'unknown' as const,
								reason: 'unavailable' as const,
							}),
							async provisionOrganization(request) {
								const row = (
									await context
										.openDatabase()
										.select({ state: organization.fleetState })
										.from(organization)
										.where(eq(organization.id, request.organizationId))
								)[0];
								observedBeforeReply = row?.state ?? 'absent';
								return answer;
							},
						},
					},
				});
				const created = z.object({ id: z.uuidv7() }).parse(
					await provider.api.createOrganization({
						headers: new Headers({ cookie, origin: properties.configuration.issuer }),
						body: {
							name: 'Provisioning proof',
							slug: context.platform.ids.nextId(),
						},
					}),
				);
				const row = (
					await context
						.openDatabase()
						.select({ state: organization.fleetState })
						.from(organization)
						.where(eq(organization.id, created.id))
				)[0];
				return { observedBeforeReply, state: row?.state ?? 'absent', id: created.id };
			}),
		);
		return {
			observedBeforeReply: observations.map((observation) => observation.observedBeforeReply),
			states: observations.map((observation) => observation.state),
			distinctRequests: new Set(observations.map((observation) => observation.id)).size,
		};
	} finally {
		context.setTime(previousTime);
	}
}
