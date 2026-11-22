import type { OrganizationProjection } from '#sign-in-test-support/fuzz/organization-model';

/** These predicates read actual stored projections, before model/answer comparison, so the
 * wrong-build receipt names the domain rule that broke rather than a generic deep diff. */
export function assertOrganizationInvariants(props: {
	readonly projection: OrganizationProjection;
	readonly previous: OrganizationProjection;
	readonly now: number;
}): void {
	const { projection, previous, now } = props;
	for (const organization of projection.organizations) {
		if (
			!projection.memberships.some(
				(membership) =>
					membership.organizationId === organization.id && membership.role === 'owner',
			)
		)
			throw new Error(`R-owner: organization ${organization.id} has no owner`);
	}
	for (const session of projection.sessions) {
		if (
			session.organizationId !== null &&
			!projection.memberships.some(
				(membership) =>
					membership.organizationId === session.organizationId &&
					membership.personId === session.personId,
			)
		)
			throw new Error(`R-choice: session ${session.id} selects a non-membership`);
	}
	for (const pair of projection.fences) {
		if (
			pair.state === 'inactive' &&
			projection.sessions.some(
				(session) =>
					session.personId === pair.personId &&
					session.organizationId === pair.organizationId &&
					session.expiresAt > now,
			)
		)
			throw new Error(
				`R-removed: inactive pair ${pair.organizationId}/${pair.personId} has a live scoped session`,
			);
	}
	for (const retained of previous.fences) {
		const current = projection.fences.find(
			(pair) =>
				pair.organizationId === retained.organizationId && pair.personId === retained.personId,
		);
		if (current === undefined || current.revision < retained.revision)
			throw new Error(
				`R-fence: retained pair ${retained.organizationId}/${retained.personId} disappeared or decreased`,
			);
	}
	for (const invitation of previous.invitations) {
		const current = projection.invitations.find((candidate) => candidate.id === invitation.id);
		if (
			current === undefined ||
			(invitation.state !== 'pending' &&
				current.state !== invitation.state &&
				current.state !== 'canceled')
		)
			throw new Error(`R-invite: invitation ${invitation.id} left its documented lifecycle`);
	}
}
