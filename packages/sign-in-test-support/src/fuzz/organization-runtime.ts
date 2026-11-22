import {
	invitation,
	member,
	organization,
	personIdSchema,
	personOrganizationAuthorizationRevisions,
	session,
	trustedSignInClientAddressHeader,
	user,
	uuid7Schema,
} from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import {
	canonicalOrganizationProjection,
	organizationProjectionSchema,
	type OrganizationOperation,
	type OrganizationProjection,
	type OrganizationReceipt,
} from '#sign-in-test-support/fuzz/organization-model';
import { assertOrganizationRefusalEffects } from '#sign-in-test-support/fuzz/organization-refusal-effects';
import { readRequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import { createOrganizationProofProvider } from '#sign-in-test-support/storage-cases/organization-provider-proof';
import {
	storageCaseOwnerEmail,
	type StorageCaseContext,
} from '#sign-in-test-support/storage-cases/storage-case-context';
import {
	createStoragePerson,
	resetStorageCase,
} from '#sign-in-test-support/storage-cases/storage-case-utilities';
import { storageProviderProperties } from '#sign-in-test-support/storage-cases/storage-provider-fixture';
import { initialSignInTestTime } from '#sign-in-test-support/test-fixtures/controlled-sign-in-time';

export interface OrganizationRuntime {
	readonly reset: () => Promise<OrganizationProjection>;
	readonly execute: (operation: OrganizationOperation) => Promise<OrganizationReceipt>;
}

/** Only initial people are seeded. Every sequence mutation uses native provider routes or
 * the production person-session service; the raw database is used for readback only. */
export function createOrganizationRuntime(props: {
	readonly context: StorageCaseContext;
	readonly setNativeTime: (milliseconds: number) => void;
}): OrganizationRuntime {
	const { context } = props;
	const cookies = new Map<string, string>();
	const peopleByEmail = new Map<string, string>();
	let requestNumber = 0;
	const fixtureOrganizationId = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000f1');
	function setTime(milliseconds: number): void {
		context.setTime(milliseconds);
		props.setNativeTime(milliseconds);
	}
	async function project(): Promise<OrganizationProjection> {
		const database = context.openDatabase();
		const [people, organizations, memberships, invites, sessions, fences] = await Promise.all([
			database.select({ id: user.id, email: user.email }).from(user),
			database.select({ id: organization.id }).from(organization),
			database
				.select({
					organizationId: member.organizationId,
					personId: member.userId,
					role: member.role,
				})
				.from(member),
			database
				.select({
					id: invitation.id,
					organizationId: invitation.organizationId,
					email: invitation.email,
					state: invitation.status,
					expiresAt: invitation.expiresAt,
				})
				.from(invitation),
			database
				.select({
					id: session.id,
					personId: session.userId,
					organizationId: session.activeOrganizationId,
					expiresAt: session.expiresAt,
				})
				.from(session),
			database
				.select({
					organizationId: personOrganizationAuthorizationRevisions.organizationId,
					personId: personOrganizationAuthorizationRevisions.personId,
					revision: personOrganizationAuthorizationRevisions.revision,
					state: personOrganizationAuthorizationRevisions.state,
				})
				.from(personOrganizationAuthorizationRevisions),
		]);
		return canonicalOrganizationProjection(
			organizationProjectionSchema.parse({
				people,
				organizations,
				memberships,
				fences,
				invitations: invites.map((invite) => {
					const personId = peopleByEmail.get(invite.email);
					if (personId === undefined)
						throw new Error('Sequence invitation targets an unseeded person');
					return {
						id: invite.id,
						organizationId: invite.organizationId,
						personId,
						state: invite.state,
						expiresAt: invite.expiresAt.getTime(),
					};
				}),
				sessions: sessions.map((current) => ({
					id: current.id,
					personId: current.personId,
					organizationId: current.organizationId,
					expiresAt: current.expiresAt.getTime(),
				})),
			}),
		);
	}
	async function providerRequest(requestProps: {
		readonly path: string;
		readonly actorSessionId?: string;
		readonly body?: Readonly<Record<string, unknown>>;
	}): Promise<Response> {
		const provider = createOrganizationProofProvider({
			context,
			organizationId: fixtureOrganizationId,
		});
		const issuer = storageProviderProperties(context, fixtureOrganizationId).configuration.issuer;
		// Storage properties are independent of abuse budgets. Give each synthetic request
		// its own trusted fixture client rather than depending on a limiter window.
		requestNumber += 1;
		const clientAddress = `10.${Math.floor(requestNumber / 65_536) % 256}.${Math.floor(requestNumber / 256) % 256}.${requestNumber % 256}`;
		return provider.handler(
			new Request(`${issuer}/api/auth/${requestProps.path}`, {
				method: requestProps.body === undefined ? 'GET' : 'POST',
				headers: {
					origin: issuer,
					[trustedSignInClientAddressHeader]: clientAddress,
					'content-type': 'application/json',
					cookie:
						requestProps.actorSessionId === undefined
							? ''
							: (cookies.get(requestProps.actorSessionId) ?? ''),
				},
				...(requestProps.body === undefined ? {} : { body: JSON.stringify(requestProps.body) }),
			}),
		);
	}
	async function execute(operation: OrganizationOperation): Promise<OrganizationReceipt> {
		const before = await readRequestStorageSnapshot(context.openDatabase());
		let response: Response;
		let created: OrganizationReceipt['created'] = { kind: 'none' };
		const actor = 'actorSessionId' in operation ? { actorSessionId: operation.actorSessionId } : {};
		switch (operation.kind) {
			case 'create-organization':
				response = await providerRequest({
					...actor,
					path: 'organization/create',
					body: { name: 'Sequence organization', slug: context.platform.ids.nextId() },
				});
				if (response.ok)
					created = {
						kind: 'organization',
						id: z.object({ id: uuid7Schema }).parse(await response.clone().json()).id,
					};
				break;
			case 'invite': {
				const email = [...peopleByEmail].find((entry) => entry[1] === operation.personId)?.[0];
				if (email === undefined) throw new Error('Sequence person has no fixture identity');
				response = await providerRequest({
					...actor,
					path: 'organization/invite-member',
					body: { organizationId: operation.organizationId, email, role: 'member' },
				});
				if (response.ok) {
					const createdInvitation = z
						.object({ id: uuid7Schema, expiresAt: z.coerce.date() })
						.parse(await response.clone().json());
					created = {
						kind: 'invitation',
						id: createdInvitation.id,
						expiresAt: createdInvitation.expiresAt.getTime(),
					};
				}
				break;
			}
			case 'accept':
				response = await providerRequest({
					...actor,
					path: 'organization/accept-invitation',
					body: { invitationId: operation.invitationId },
				});
				break;
			case 'cancel':
				response = await providerRequest({
					...actor,
					path: 'organization/cancel-invitation',
					body: { invitationId: operation.invitationId },
				});
				break;
			case 'remove-member': {
				const email = [...peopleByEmail].find((entry) => entry[1] === operation.personId)?.[0];
				if (email === undefined) throw new Error('Sequence person has no fixture identity');
				response = await providerRequest({
					...actor,
					path: 'organization/remove-member',
					body: { organizationId: operation.organizationId, memberIdOrEmail: email },
				});
				break;
			}
			case 'change-role': {
				const memberships = await context.openDatabase().select().from(member);
				const target = memberships.find(
					(candidate) =>
						candidate.userId === operation.personId &&
						candidate.organizationId === operation.organizationId,
				);
				// The native provider entry includes both its permission checks and the production
				// role hooks/fenced adapter. The outer public route is intentionally blocked.
				response = await providerRequest({
					...actor,
					path: 'organization/update-member-role',
					body: {
						organizationId: operation.organizationId,
						memberId: target?.id ?? operation.personId,
						role: operation.role,
					},
				});
				break;
			}
			case 'choose-organization':
				response = await providerRequest({
					...actor,
					path: 'organization/set-active',
					body: { organizationId: operation.organizationId },
				});
				break;
			case 'create-session': {
				response = await providerRequest({
					path: '__storage-proof/session',
					body: { personId: operation.personId },
				});
				if (response.ok) {
					const id = z.object({ id: uuid7Schema }).parse(await response.clone().json()).id;
					const cookie = response.headers
						.getSetCookie()
						.map((value) => value.split(';')[0])
						.join('; ');
					if (cookie.length === 0) throw new Error('Native sequence session issued no cookie');
					cookies.set(id, cookie);
					const stamped = await context.store.factors.stampSession({
						personId: personIdSchema.parse(operation.personId),
						sessionId: id,
						method: 'app',
					});
					if (stamped.kind !== 'available' || stamped.value.kind !== 'stamped')
						throw new Error('Sequence fixture second factor refused');
					const stored = z
						.object({ expiresAt: z.date() })
						.parse(
							(
								await context
									.openDatabase()
									.select({ expiresAt: session.expiresAt })
									.from(session)
									.where(eq(session.id, id))
							)[0],
						);
					created = { kind: 'session', id, expiresAt: stored.expiresAt.getTime() };
				}
				break;
			}
			case 'expire-session': {
				const current = (
					await context
						.openDatabase()
						.select({ expiresAt: session.expiresAt })
						.from(session)
						.where(eq(session.id, operation.sessionId))
				)[0];
				if (current !== undefined) {
					setTime(Math.max(context.platform.clock.now(), current.expiresAt.getTime() + 1));
					// The native read owns expired-session deletion and its retained-pair bumps.
					response = await providerRequest({
						path: 'get-session?disableCookieCache=true&disableRefresh=true',
						actorSessionId: operation.sessionId,
					});
					if ((await response.clone().json()) !== null)
						throw new Error('Expired native session was returned as live');
				} else response = Response.json(null);
				break;
			}
			case 'delete-person': {
				const result = await context.store.persons.cleanupUnboundPerson(operation.personId);
				if (result.kind !== 'available') throw new Error('Sequence person cleanup unavailable');
				response = Response.json(null);
				break;
			}
			default:
				return operation satisfies never;
		}
		if (!response.ok)
			assertOrganizationRefusalEffects({
				operation,
				before,
				after: await readRequestStorageSnapshot(context.openDatabase()),
				now: context.platform.clock.now(),
			});
		return {
			status: response.status,
			created,
			now: context.platform.clock.now(),
			projection: await project(),
		};
	}
	return {
		async reset(): Promise<OrganizationProjection> {
			await resetStorageCase(context);
			setTime(initialSignInTestTime);
			cookies.clear();
			peopleByEmail.clear();
			const people = await Promise.all(
				[
					storageCaseOwnerEmail,
					'sequence-member-one@example.invalid',
					'sequence-member-two@example.invalid',
				].map(async (email): Promise<readonly [string, string]> => [
					email,
					await createStoragePerson(context, email),
				]),
			);
			for (const [email, personId] of people) peopleByEmail.set(email, personId);
			return project();
		},
		execute,
	};
}
