import type { OrganizationOperation } from '#sign-in-test-support/fuzz/organization-model';
import {
	rowBytes,
	type RequestStorageSnapshot,
} from '#sign-in-test-support/fuzz/request-storage-snapshot';

/** Refusal effects are predicted from the command and pre-state, never the status:
 * expired actor cleanup advances every retained pair; native nonmembership
 * set-active clears only that actor's previous choice. Other columns stay exact.
 * All generated actor requests have valid bodies/origin and reach the uncached
 * session read in provider-configuration.ts:230 before endpoint policy checks. */
export function assertOrganizationRefusalEffects(props: {
	readonly operation: OrganizationOperation;
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
	readonly now: number;
}): void {
	const { operation, before, after, now } = props;
	const expired =
		'actorSessionId' in operation
			? (before.session ?? []).find(
					(current) =>
						current.id === operation.actorSessionId &&
						typeof current.expiresAt === 'number' &&
						current.expiresAt <= now,
				)
			: undefined;
	const refusedChoice =
		operation.kind === 'choose-organization' && expired === undefined
			? (before.session ?? []).find(
					(current) =>
						current.id === operation.actorSessionId &&
						!(before.member ?? []).some(
							(membership) =>
								membership.userId === current.userId &&
								membership.organizationId === operation.organizationId,
						),
				)
			: undefined;
	for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const original = before[table] ?? [];
		const current = after[table] ?? [];
		const expected =
			table === 'session' && expired !== undefined
				? original.filter((row) => row.id !== expired.id)
				: table === 'session' && refusedChoice !== undefined
					? original.map((row) =>
							row.id === refusedChoice.id ? { ...row, activeOrganizationId: null } : row,
						)
					: table === 'personOrganizationAuthorizationRevisions' && expired !== undefined
						? original.map((row) => {
								if (row.person_id !== expired.userId) return row;
								if (typeof row.revision !== 'number')
									throw new Error('S3-refusal-effects: invalid stored fence revision');
								return {
									...row,
									revision: row.revision + 1,
									next_attempt_at: now,
									updated_at: now,
								};
							})
						: original;
		const expectedBytes = expected.map(rowBytes).toSorted();
		const currentBytes = current.map(rowBytes).toSorted();
		if (JSON.stringify(expectedBytes) !== JSON.stringify(currentBytes))
			throw new Error(`S3-refusal-effects: unauthorized stored transition in ${table}`);
	}
}
