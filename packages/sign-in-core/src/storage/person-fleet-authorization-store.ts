import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { epochMillisecondsSchema } from '#sign-in-core/contracts/sign-in-platform';
import type { PersonFleetAuthorizationSnapshot } from '#sign-in-core/organizations/person-fleet-issuance';
import { secondFactorConfirmationSchema } from '#sign-in-core/second-factors/second-factor-step-up';
import type {
	SignInDatabaseFactory,
	SignInStoreResult,
} from '#sign-in-core/storage/models/sign-in-database';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';
import {
	member,
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
	session,
	user,
} from '#sign-in-core/storage/sign-in-schema';
import { availableStoreValue, readStoreValue } from '#sign-in-core/storage/store-query-results';

export interface PersonFleetAuthorizationRecords {
	/**
	 * One statement, so every authority it returns was read at the same point in the store. The
	 * membership and fences are the session's active organization's, or the named organization's
	 * when one is given (C8: a person's link names its organization in the path).
	 */
	readonly readPersonFleetSnapshot: (
		personId: string,
		sessionId: string,
		organizationId?: OrganizationId,
	) => Promise<SignInStoreResult<PersonFleetAuthorizationSnapshot | null>>;
}

const snapshotRowSchema = z.strictObject({
	sessionExpiresAt: z.date(),
	organizationId: z.string().nullable(),
	secondFactorAt: z.number().int().nullable(),
	secondFactorMethod: z.string().nullable(),
	memberRole: z.string().nullable(),
	subjectId: z.string().nullable(),
	subjectRevision: z.number().int().nullable(),
	subjectState: z.enum(['active', 'inactive']).nullable(),
	organizationRevision: z.number().int().nullable(),
	organizationState: z.enum(['active', 'stopped', 'deleted']).nullable(),
	organizationPolicyDigest: z.string().nullable(),
});

export function createPersonFleetAuthorizationStore(
	openDatabase: SignInDatabaseFactory,
): PersonFleetAuthorizationRecords {
	return {
		async readPersonFleetSnapshot(personId, sessionId, organizationId) {
			const database = openDatabase();
			const scope = organizationId ?? session.activeOrganizationId;
			const rows = await readStoreValue(
				async () =>
					database
						.select({
							sessionExpiresAt: session.expiresAt,
							organizationId: session.activeOrganizationId,
							secondFactorAt: session.secondFactorAt,
							secondFactorMethod: session.secondFactorMethod,
							memberRole: member.role,
							subjectId: personFence.id,
							subjectRevision: personFence.revision,
							subjectState: personFence.state,
							organizationRevision: organizationFence.revision,
							organizationState: organizationFence.state,
							organizationPolicyDigest: organizationFence.permissionPolicyDigest,
						})
						.from(session)
						.innerJoin(user, and(eq(user.id, session.userId), eq(user.emailVerified, true)))
						.leftJoin(
							member,
							and(
								eq(member.userId, session.userId),
								eq(member.organizationId, scope),
							),
						)
						.leftJoin(
							personFence,
							and(
								eq(personFence.personId, session.userId),
								eq(personFence.organizationId, scope),
							),
						)
						.leftJoin(organizationFence, eq(organizationFence.id, scope))
						.where(and(eq(session.id, sessionId), eq(session.userId, personId)))
						.limit(1),
				z.array(snapshotRowSchema).max(1),
			);
			if (rows.kind === 'store-unavailable') return rows;
			const row = rows.value[0];
			if (row === undefined) return availableStoreValue(null);
			return availableStoreValue({
				sessionExpiresAt: epochMillisecondsSchema.parse(row.sessionExpiresAt.getTime()),
				organizationId: organizationId ?? row.organizationId,
				confirmation:
					row.secondFactorAt === null || row.secondFactorMethod === null
						? { kind: 'unconfirmed' }
						: secondFactorConfirmationSchema.parse({
								kind: 'confirmed',
								at: row.secondFactorAt,
								method: row.secondFactorMethod,
							}),
				memberRole: row.memberRole,
				subject:
					row.subjectId === null || row.subjectRevision === null || row.subjectState === null
						? null
						: { id: row.subjectId, revision: row.subjectRevision, state: row.subjectState },
				organizationFence:
					row.organizationRevision === null ||
					row.organizationState === null ||
					row.organizationPolicyDigest === null
						? null
						: {
								revision: row.organizationRevision,
								state: row.organizationState,
								permissionPolicyDigest: row.organizationPolicyDigest,
							},
			});
		},
	};
}
