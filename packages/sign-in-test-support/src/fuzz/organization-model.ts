import { z } from 'zod';

const identifier = z.uuidv7();
const actor = { actorSessionId: identifier };
const target = { organizationId: identifier, personId: identifier };
export const organizationOperationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('create-organization'), ...actor }),
	z.object({ kind: z.literal('invite'), ...actor, ...target }),
	z.object({ kind: z.literal('accept'), ...actor, invitationId: identifier }),
	z.object({ kind: z.literal('cancel'), ...actor, invitationId: identifier }),
	z.object({ kind: z.literal('remove-member'), ...actor, ...target }),
	z.object({
		kind: z.literal('change-role'),
		...actor,
		...target,
		role: z.enum(['owner', 'member']),
	}),
	z.object({ kind: z.literal('choose-organization'), ...actor, organizationId: identifier }),
	z.object({ kind: z.literal('create-session'), personId: identifier }),
	z.object({ kind: z.literal('expire-session'), sessionId: identifier }),
	z.object({ kind: z.literal('delete-person'), personId: identifier }),
]);
export type OrganizationOperation = z.infer<typeof organizationOperationSchema>;

export const organizationProjectionSchema = z.object({
	people: z.array(z.object({ id: identifier, email: z.email() })),
	organizations: z.array(z.object({ id: identifier })),
	memberships: z.array(z.object({ ...target, role: z.enum(['owner', 'member']) })),
	invitations: z.array(
		z.object({
			id: identifier,
			organizationId: identifier,
			personId: identifier,
			state: z.enum(['pending', 'accepted', 'canceled']),
			expiresAt: z.number(),
		}),
	),
	sessions: z.array(
		z.object({
			id: identifier,
			personId: identifier,
			organizationId: identifier.nullable(),
			expiresAt: z.number(),
		}),
	),
	fences: z.array(
		z.object({
			...target,
			revision: z.number().int().positive(),
			state: z.enum(['active', 'inactive']),
		}),
	),
});
export type OrganizationProjection = z.infer<typeof organizationProjectionSchema>;
export const organizationReceiptSchema = z.object({
	status: z.number().int(),
	created: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({ kind: z.literal('organization'), id: identifier }),
		z.object({ kind: z.literal('invitation'), id: identifier, expiresAt: z.number() }),
		z.object({ kind: z.literal('session'), id: identifier, expiresAt: z.number() }),
	]),
	now: z.number(),
	projection: organizationProjectionSchema,
});
export type OrganizationReceipt = z.infer<typeof organizationReceiptSchema>;
export interface OrganizationModel {
	projection: OrganizationProjection;
	now: number;
	readonly ownerPersonId: string;
}

export function canonicalOrganizationProjection(
	projection: OrganizationProjection,
): OrganizationProjection {
	return {
		people: projection.people.toSorted((left, right) => left.id.localeCompare(right.id)),
		organizations: projection.organizations.toSorted((left, right) =>
			left.id.localeCompare(right.id),
		),
		memberships: projection.memberships.toSorted((left, right) =>
			pairKey(left).localeCompare(pairKey(right)),
		),
		invitations: projection.invitations.toSorted((left, right) => left.id.localeCompare(right.id)),
		sessions: projection.sessions.toSorted((left, right) => left.id.localeCompare(right.id)),
		fences: projection.fences.toSorted((left, right) =>
			pairKey(left).localeCompare(pairKey(right)),
		),
	};
}

function pairKey(pair: { readonly organizationId: string; readonly personId: string }): string {
	return `${pair.organizationId}/${pair.personId}`;
}

function bumpPersonPairs(model: OrganizationModel, personId: string, inactive = false): void {
	for (const pair of model.projection.fences) {
		if (pair.personId === personId) {
			pair.revision += 1;
			if (inactive) pair.state = 'inactive';
		}
	}
}
function joinOrganization(
	model: OrganizationModel,
	membership: OrganizationProjection['memberships'][number],
): void {
	model.projection.memberships.push(membership);
	const retained = model.projection.fences.find((pair) => pairKey(pair) === pairKey(membership));
	if (retained === undefined)
		model.projection.fences.push({
			organizationId: membership.organizationId,
			personId: membership.personId,
			revision: 1,
			state: 'active',
		});
	else {
		retained.revision += 1;
		retained.state = 'active';
	}
}
function deleteModelSession(model: OrganizationModel, sessionId: string): void {
	const session = model.projection.sessions.find((candidate) => candidate.id === sessionId);
	if (session === undefined) return;
	bumpPersonPairs(model, session.personId);
	model.projection.sessions = model.projection.sessions.filter(
		(candidate) => candidate.id !== sessionId,
	);
}

/** Expected policy and state transitions, independent of provider hooks and storage mutation helpers.
 * Opaque generated ids and expiration timestamps are bound from successful native creation receipts. */
export function applyOrganizationOperation(props: {
	readonly model: OrganizationModel;
	readonly operation: OrganizationOperation;
	readonly created: OrganizationReceipt['created'];
}): 'accepted' | 'refused' {
	const { model, operation, created } = props;
	const state = model.projection;
	const actorSession =
		'actorSessionId' in operation
			? state.sessions.find((candidate) => candidate.id === operation.actorSessionId)
			: undefined;
	if (
		'actorSessionId' in operation &&
		(actorSession === undefined || actorSession.expiresAt <= model.now)
	) {
		// Every generated actor operation has valid native input and enters /organization/*.
		// The production before-hook reads its uncached session before endpoint policy
		// (provider-configuration.ts:230); that read owns expired-row cleanup.
		if (actorSession !== undefined) deleteModelSession(model, actorSession.id);
		return 'refused';
	}
	const actorPersonId = actorSession?.personId;
	const isOwner = (organizationId: string): boolean =>
		state.memberships.some(
			(membership) =>
				membership.organizationId === organizationId &&
				membership.personId === actorPersonId &&
				membership.role === 'owner',
		);
	const invitation =
		'invitationId' in operation
			? state.invitations.find((candidate) => candidate.id === operation.invitationId)
			: undefined;
	const membership =
		'organizationId' in operation && 'personId' in operation
			? state.memberships.find((candidate) => pairKey(candidate) === pairKey(operation))
			: undefined;
	switch (operation.kind) {
		case 'create-organization': {
			if (actorPersonId !== model.ownerPersonId) return 'refused';
			if (created.kind !== 'organization')
				throw new Error('Accepted organization creation needs its native id');
			state.organizations.push({ id: created.id });
			joinOrganization(model, {
				organizationId: created.id,
				personId: model.ownerPersonId,
				role: 'owner',
			});
			if (actorSession !== undefined) actorSession.organizationId = created.id;
			return 'accepted';
		}
		case 'invite': {
			if (!isOwner(operation.organizationId) || membership !== undefined) return 'refused';
			if (
				state.invitations.some(
					(candidate) =>
						pairKey(candidate) === pairKey(operation) &&
						candidate.state === 'pending' &&
						candidate.expiresAt > model.now,
				)
			)
				return 'refused';
			if (created.kind !== 'invitation') throw new Error('Accepted invitation needs its native id');
			state.invitations.push({
				id: created.id,
				organizationId: operation.organizationId,
				personId: operation.personId,
				state: 'pending',
				expiresAt: created.expiresAt,
			});
			return 'accepted';
		}
		case 'accept': {
			if (
				invitation === undefined ||
				invitation.state !== 'pending' ||
				invitation.expiresAt <= model.now ||
				actorPersonId !== invitation.personId
			)
				return 'refused';
			if (state.memberships.some((candidate) => pairKey(candidate) === pairKey(invitation)))
				return 'refused';
			invitation.state = 'accepted';
			joinOrganization(model, {
				organizationId: invitation.organizationId,
				personId: invitation.personId,
				role: 'member',
			});
			if (actorSession !== undefined) actorSession.organizationId = invitation.organizationId;
			return 'accepted';
		}
		case 'cancel':
			if (invitation === undefined || !isOwner(invitation.organizationId)) return 'refused';
			// Native cancel accepts terminal invitations too; it never creates a membership.
			invitation.state = 'canceled';
			return 'accepted';
		case 'remove-member': {
			if (
				!isOwner(operation.organizationId) ||
				membership === undefined ||
				membership.role === 'owner'
			)
				return 'refused';
			state.memberships = state.memberships.filter(
				(candidate) => pairKey(candidate) !== pairKey(operation),
			);
			const pair = state.fences.find((candidate) => pairKey(candidate) === pairKey(operation));
			if (pair === undefined) throw new Error('Model membership has no authorization fence');
			pair.revision += 1;
			pair.state = 'inactive';
			// S3 R-choice and R-removed: a removed membership cannot remain a session's scope.
			for (const current of state.sessions) {
				if (
					current.personId === operation.personId &&
					current.organizationId === operation.organizationId
				)
					current.organizationId = null;
			}
			return 'accepted';
		}
		case 'change-role': {
			if (!isOwner(operation.organizationId) || membership === undefined) return 'refused';
			if (
				membership.role === 'owner' &&
				operation.role === 'member' &&
				state.memberships.filter(
					(candidate) =>
						candidate.organizationId === operation.organizationId && candidate.role === 'owner',
				).length === 1
			)
				return 'refused';
			if (membership.role !== operation.role) {
				membership.role = operation.role;
				const pair = state.fences.find((candidate) => pairKey(candidate) === pairKey(operation));
				if (pair === undefined) throw new Error('Model role change has no authorization fence');
				pair.revision += 1;
			}
			return 'accepted';
		}
		case 'choose-organization':
			if (
				!state.memberships.some(
					(candidate) =>
						candidate.personId === actorPersonId &&
						candidate.organizationId === operation.organizationId,
				)
			) {
				// Native set-active clears the caller's previous selection before its
				// nonmembership refusal (Better Auth crud-org.mjs, checkMembership).
				if (actorSession !== undefined) actorSession.organizationId = null;
				return 'refused';
			}
			if (actorSession !== undefined) actorSession.organizationId = operation.organizationId;
			return 'accepted';
		case 'create-session': {
			if (!state.people.some((person) => person.id === operation.personId)) return 'refused';
			if (
				operation.personId !== model.ownerPersonId &&
				!state.memberships.some((candidate) => candidate.personId === operation.personId) &&
				!state.invitations.some(
					(candidate) =>
						candidate.personId === operation.personId &&
						candidate.state === 'pending' &&
						candidate.expiresAt > model.now,
				)
			)
				return 'refused';
			if (created.kind !== 'session')
				throw new Error('Accepted session creation needs its native id');
			const memberships = state.memberships.filter(
				(candidate) => candidate.personId === operation.personId,
			);
			state.sessions.push({
				id: created.id,
				personId: operation.personId,
				organizationId: memberships.length === 1 ? (memberships[0]?.organizationId ?? null) : null,
				expiresAt: created.expiresAt,
			});
			return 'accepted';
		}
		case 'expire-session': {
			const expiring = state.sessions.find((candidate) => candidate.id === operation.sessionId);
			if (expiring !== undefined) {
				model.now = Math.max(model.now, expiring.expiresAt + 1);
				deleteModelSession(model, expiring.id);
			}
			return 'accepted';
		}
		case 'delete-person': {
			if (
				state.memberships.some((candidate) => candidate.personId === operation.personId) ||
				state.sessions.some((candidate) => candidate.personId === operation.personId) ||
				state.invitations.some(
					(candidate) =>
						candidate.personId === operation.personId &&
						candidate.state === 'pending' &&
						candidate.expiresAt > model.now,
				)
			)
				return 'accepted';
			if (state.people.some((candidate) => candidate.id === operation.personId)) {
				bumpPersonPairs(model, operation.personId, true);
				state.people = state.people.filter((candidate) => candidate.id !== operation.personId);
			}
			return 'accepted';
		}
		default:
			return operation satisfies never;
	}
}
