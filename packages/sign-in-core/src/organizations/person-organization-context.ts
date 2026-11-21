import { z } from 'zod';

import {
	personOrganizationContextSchema,
	type OrganizationChoice,
	type PersonOrganizationContext,
} from '#sign-in-core/contracts/organization-membership';
import {
	liveOwnerSessionSchema,
	tokenlessPersonSessionSchema,
} from '#sign-in-core/storage/models/person-session-records';
import type { OrganizationId } from '#sign-in-core/storage/models/sign-in-store';
import type { OrganizationMembershipRecords } from '#sign-in-core/storage/organization-membership-store';

// This portable shape keeps the exported context reader independent of Better Auth.
export const organizationReadSessionSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('signed-out') }),
	z.strictObject({ kind: z.literal('unavailable') }),
	z.strictObject({ kind: z.literal('session'), value: liveOwnerSessionSchema }),
]);
export type ReadSession = z.infer<typeof organizationReadSessionSchema>;
export const nativeLiveSessionViewSchema = tokenlessPersonSessionSchema;
export const organizationSessionViewSchema = z.discriminatedUnion('kind', [
	organizationReadSessionSchema.options[0],
	organizationReadSessionSchema.options[1],
	organizationReadSessionSchema.options[2].extend({ value: nativeLiveSessionViewSchema }),
]);
export type OrganizationSessionView = z.infer<typeof organizationSessionViewSchema>;

export function currentSelectionAmong(
	choices: readonly OrganizationChoice[],
	storedOrganizationId: string | null,
): OrganizationId | null {
	return (
		choices.find((choice) => choice.organizationId === storedOrganizationId)?.organizationId ?? null
	);
}

export async function readPersonOrganizationContext(props: {
	readonly session: OrganizationSessionView;
	readonly store: Pick<OrganizationMembershipRecords, 'membershipsForPerson'>;
}): Promise<PersonOrganizationContext> {
	switch (props.session.kind) {
		case 'signed-out':
		case 'unavailable':
			return props.session;
		case 'session': {
			const memberships = await props.store.membershipsForPerson(props.session.value.user.id);
			if (memberships.kind === 'store-unavailable') return { kind: 'unavailable' };
			const choices = memberships.value
				.map(({ organizationId, organizationName, role }) => ({
					organizationId,
					organizationName,
					role,
				}))
				.toSorted((left, right) => left.organizationId.localeCompare(right.organizationId));
			return personOrganizationContextSchema.parse({
				kind: 'available',
				choices,
				activeOrganizationId: currentSelectionAmong(
					choices,
					props.session.value.session.activeOrganizationId,
				),
			});
		}
		default:
			return props.session satisfies never;
	}
}
