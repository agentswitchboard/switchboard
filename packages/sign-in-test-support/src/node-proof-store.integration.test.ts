import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	member,
	organization,
	organizationIdSchema,
	createSignInStore,
	epochMillisecondsSchema,
	session,
	signInAudit,
	user,
} from '@agent-collaboration/sign-in-core';
import { openNodeSignInDatabase } from '@agent-collaboration/sign-in-host-node';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	organizationReadProjection,
	type PreparedDriverCall,
} from '#sign-in-test-support/test-fixtures/database-fault-identity';
import { decorateNodeProofStore } from '#sign-in-test-support/test-fixtures/node-proof-store';

useControlledSignInClock();

it('the unarmed Node store decorator preserves production results and stored rows', async () => {
	const observedCalls: PreparedDriverCall[] = [];
	const opened = await openNodeSignInDatabase({
		logger: {
			logQuery(query: string, parameters: unknown[]): void {
				observedCalls.push({ query, parameters });
			},
		},
		stateDirectory: await mkdtemp(path.join(tmpdir(), '2026-10-node-store-transparency-')),
	});
	if (opened.kind !== 'available') throw new Error('Database setup failed');
	const now = 2_208_988_800_000;
	const personId = '11111111-1111-7111-8111-111111111111';
	const sessionId = '22222222-2222-7222-8222-222222222222';
	const platform = {
		// This fixture claims isolated store wiring, outside the HTTP and central gates.
		centralClient: {
			readStatementDigest: async () => ({
				kind: 'unavailable' as const,
				reason: 'unavailable' as const,
			}),
			pushAuthorizationRevision: async () => ({
				kind: 'unknown' as const,
				reason: 'unavailable' as const,
			}),
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
			provisionOrganization: async () => ({
				kind: 'unknown' as const,
				reason: 'unavailable' as const,
			}),
		},
		requestLimiter: { allow: async () => ({ kind: 'allowed' as const }) },
		...createWebSignInCapabilities({ now: () => epochMillisecondsSchema.parse(now) }),
		runAtomically: opened.database.runAtomically,
		log: (): void => {},
	};
	const organizationId = organizationIdSchema.parse(platform.ids.nextId());
	const store = createSignInStore({
		openDatabase: opened.database.openDatabase,
		platform,
		ownerEmail: 'owner@example.invalid',
	});
	const decorated = decorateNodeProofStore({
		store,
		beforeAgentRead: async (): Promise<void> => {},
		beforeOwnerRead: async (): Promise<void> => {},
	});
	try {
		const database = opened.database.openDatabase();
		await database.insert(user).values({
			id: personId,
			name: 'Owner',
			email: 'owner@example.invalid',
			emailVerified: true,
			createdAt: new Date(now),
			updatedAt: new Date(now),
		});
		await database.insert(organization).values({
			id: organizationId,
			name: 'Owner organization',
			slug: 'owner',
			createdAt: new Date(now),
		});
		await database.insert(member).values({
			id: platform.ids.nextId(),
			organizationId,
			userId: personId,
			role: 'owner',
			createdAt: new Date(now),
		});
		await store.persons.ensurePersonActive(personId);
		await database.insert(session).values({
			id: sessionId,
			token: 'opaque-test-session',
			activeOrganizationId: organizationId,
			userId: personId,
			createdAt: new Date(now),
			updatedAt: new Date(now),
			expiresAt: new Date(now + 60_000),
		});
		const before = {
			memberships: await database.select().from(member),
			audit: await database.select().from(signInAudit),
			sessions: await database.select().from(session),
		};
		const ordinaryOwner = await store.persons.readOwnerSession(personId, sessionId);
		expect(ordinaryOwner).toMatchObject({
			kind: 'available',
			value: { user: { id: personId }, session: { id: sessionId } },
		});
		expect(await decorated.persons.readOwnerSession(personId, sessionId)).toEqual(ordinaryOwner);
		const ordinaryMembership = await store.organizations.readPersonMembershipFacts({
			organizationId,
			email: 'owner@example.invalid',
		});
		expect(ordinaryMembership).toEqual({
			kind: 'available',
			value: { kind: 'member', role: 'owner' },
		});
		expect(
			await decorated.organizations.readPersonMembershipFacts({
				organizationId,
				email: 'owner@example.invalid',
			}),
		).toEqual(ordinaryMembership);
		const ordinaryPeople = await store.organizations.listOrganizationPeople({
			organizationId,
			offset: 0,
		});
		expect(ordinaryPeople).toEqual({
			kind: 'available',
			value: {
				members: [{ name: 'Owner', email: 'owner@example.invalid', role: 'owner' }],
				memberTotal: 1,
				offset: 0,
				invitations: [],
			},
		});
		expect(
			await decorated.organizations.listOrganizationPeople({ organizationId, offset: 0 }),
		).toEqual(ordinaryPeople);
		expect(
			new Set(
				observedCalls.map(organizationReadProjection).filter((projection) => projection !== null),
			),
		).toEqual(
			new Set(['membership-facts', 'people-members', 'people-count', 'people-invitations']),
		);
		expect(await decorated.agents.read('missing-client')).toEqual(
			await store.agents.read('missing-client'),
		);
		expect({
			memberships: await database.select().from(member),
			audit: await database.select().from(signInAudit),
			sessions: await database.select().from(session),
		}).toEqual(before);
	} finally {
		opened.database.close();
	}
});
