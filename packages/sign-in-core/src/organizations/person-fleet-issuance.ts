import {
	personFleetApplicationClaimsSchema,
	personFleetSnapshotWindowMaximumMilliseconds,
	type PersonFleetApplicationClaims,
	type PersonFleetJwtInputClaims,
} from '#sign-in-core/contracts/person-fleet-token';
import type { EpochMilliseconds } from '#sign-in-core/contracts/sign-in-platform';
import type { FleetPermission } from '#sign-in-core/organizations/fleet-permission';
import type { SecondFactorConfirmation } from '#sign-in-core/second-factors/second-factor-step-up';
import { secondFactorTokenClaims } from '#sign-in-core/second-factors/second-factor-token-claims';

/**
 * One coherent primary read (r3 section 4): the live session joined with its verified person,
 * the membership in the session's active organization, the retained pair and the org fence.
 * Absent joins are null, so each missing authority is its own refusal.
 */
export interface PersonFleetAuthorizationSnapshot {
	readonly sessionExpiresAt: EpochMilliseconds;
	readonly organizationId: string | null;
	readonly confirmation: SecondFactorConfirmation;
	readonly memberRole: string | null;
	readonly subject: {
		readonly id: string;
		readonly revision: number;
		readonly state: 'active' | 'inactive';
	} | null;
	readonly organizationFence: {
		readonly revision: number;
		readonly state: 'active' | 'stopped' | 'deleted';
		readonly permissionPolicyDigest: string;
	} | null;
}

export type PersonFleetIssuanceRefusal =
	| 'no-session'
	| 'session-expired'
	| 'no-organization'
	| 'no-membership'
	| 'subject-missing'
	| 'subject-inactive'
	| 'organization-fence-missing'
	| 'organization-inactive'
	| 'policy-mismatch'
	| 'unknown-role'
	| 'invalid-window';
export type PersonFleetIssuance =
	| { readonly kind: 'issue'; readonly claims: PersonFleetApplicationClaims }
	| { readonly kind: 'refused'; readonly reason: PersonFleetIssuanceRefusal };

/**
 * Pure: decides from facts captured once. `snapshotAt` (S) was sampled before the read was
 * dispatched; the deadline is S + L and is never recomputed from a later clock.
 */
export function decidePersonFleetIssuance(props: {
	readonly snapshot: PersonFleetAuthorizationSnapshot | null;
	readonly snapshotAt: EpochMilliseconds;
	readonly tokenLifetimeMilliseconds: number;
	readonly loadedPolicyDigest: string;
	readonly permissionsForRole: (role: string) => readonly FleetPermission[] | null;
}): PersonFleetIssuance {
	const { snapshot, snapshotAt } = props;
	if (
		!Number.isSafeInteger(props.tokenLifetimeMilliseconds) ||
		props.tokenLifetimeMilliseconds <= 0 ||
		props.tokenLifetimeMilliseconds > personFleetSnapshotWindowMaximumMilliseconds
	)
		return refused('invalid-window');
	if (snapshot === null) return refused('no-session');
	// Equality is expired: the session must have been live at S.
	if (snapshot.sessionExpiresAt <= snapshotAt) return refused('session-expired');
	if (snapshot.organizationId === null) return refused('no-organization');
	if (snapshot.memberRole === null) return refused('no-membership');
	if (snapshot.subject === null) return refused('subject-missing');
	if (snapshot.subject.state !== 'active') return refused('subject-inactive');
	if (snapshot.organizationFence === null) return refused('organization-fence-missing');
	if (snapshot.organizationFence.state !== 'active') return refused('organization-inactive');
	// An old process must not sign the old mapping under the new fence.
	if (snapshot.organizationFence.permissionPolicyDigest !== props.loadedPolicyDigest)
		return refused('policy-mismatch');
	const permissions = props.permissionsForRole(snapshot.memberRole);
	if (permissions === null) return refused('unknown-role');
	const { second_factor_at, second_factor_method } = secondFactorTokenClaims(snapshot.confirmation);
	const claims = personFleetApplicationClaimsSchema.safeParse({
		token_profile: 'person-fleet',
		organization_id: snapshot.organizationId,
		authorization_subject_id: snapshot.subject.id,
		person_revision: snapshot.subject.revision,
		organization_revision: snapshot.organizationFence.revision,
		permission_policy_digest: snapshot.organizationFence.permissionPolicyDigest,
		permissions: [...permissions].toSorted(),
		session_expires_at_ms: snapshot.sessionExpiresAt,
		authorization_snapshot_at_ms: snapshotAt,
		authorization_snapshot_valid_until_ms: snapshotAt + props.tokenLifetimeMilliseconds,
		// The original confirmation time, never S: a new token is not a fresh factor.
		...(second_factor_at === undefined ? {} : { second_factor_at }),
		...(second_factor_method === undefined ? {} : { second_factor_method }),
	} satisfies PersonFleetJwtInputClaims);
	return claims.success ? { kind: 'issue', claims: claims.data } : refused('invalid-window');
}

function refused(reason: PersonFleetIssuanceRefusal): PersonFleetIssuance {
	return { kind: 'refused', reason };
}
