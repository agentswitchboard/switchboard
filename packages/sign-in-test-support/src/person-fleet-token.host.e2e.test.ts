import { createHash, randomBytes } from 'node:crypto';

import {
	fleetPermissionPolicyDigest,
	organizationAuthorizationRevisions as organizationFence,
	personOrganizationAuthorizationRevisions as personFence,
	session,
} from '@agent-collaboration/sign-in-core';
import { and, eq } from 'drizzle-orm';
import {
	calculateJwkThumbprint,
	createLocalJWKSet,
	decodeJwt,
	exportJWK,
	generateKeyPair,
	jwtVerify,
	SignJWT,
	type JWK,
} from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import { fleetAdminProofRedirectUri } from '#sign-in-test-support/test-fixtures/fleet-admin-client-proof';
import {
	fleetSnapshotHoldPoint,
	fleetSnapshotProbeHeader,
	type FleetSnapshotProbe,
} from '#sign-in-test-support/test-fixtures/fleet-snapshot-proof';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
const adminAudience = 'https://central.example.invalid/admin';
// PD 2530c3a3's route permissions and C3's `approval:decide`, sorted; an owner holds them all.
const ownerPermissions = [
	'approval:decide',
	'machine:enroll',
	'machine:revoke',
	'machine:setTokenLifetime',
	'organization:readAudit',
	'organization:view',
	'workspace:create',
	'workspaceAdmin:allowMachine',
	'workspaceAdmin:removeSession',
	'workspaceAdmin:withdrawMachine',
];

interface ProofKey {
	readonly privateKey: CryptoKey;
	readonly jwk: JWK;
	readonly thumbprint: string;
}
async function proofKey(): Promise<ProofKey> {
	const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
	const jwk = await exportJWK(publicKey);
	// Derived from the key independently of anything the issuer returns.
	return { privateKey, jwk, thumbprint: await calculateJwkThumbprint(jwk, 'sha256') };
}
async function dpopProof(harness: Harness, key: ProofKey): Promise<string> {
	return new SignJWT({
		htm: 'POST',
		htu: `${harness.issuer}/api/auth/oauth2/token`,
		jti: controlledSignInIds.nextId(),
		iat: Math.floor(controlledSignInClock.now() / 1000),
	})
		.setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: key.jwk })
		.sign(key.privateKey);
}

interface FleetAdminFixture {
	readonly harness: Harness;
	readonly ownerId: string;
	readonly organizationId: string;
	readonly ownerCookie: string;
	readonly clientId: string;
}
async function setup(): Promise<FleetAdminFixture> {
	const harness = await startLocalAuthHarness();
	try {
		const ownerId = await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const ownerCookie = harness.cookie();
		const clientId = controlledSignInIds.nextId();
		const registered = await harness.auth('/__auth-proof/fleet-admin-client', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: ownerCookie },
			body: JSON.stringify({ clientId }),
		});
		expect(registered.status).toBe(200);
		return { harness, ownerId, organizationId, ownerCookie, clientId };
	} catch (error) {
		await harness.close();
		throw error;
	}
}

/** Native authorization for the admin audience; returns the code and its PKCE verifier. */
async function authorizeFleetCode(props: {
	readonly harness: Harness;
	readonly cookie: string;
	readonly clientId: string;
}): Promise<{ readonly code: string; readonly verifier: string }> {
	const verifier = randomBytes(32).toString('base64url');
	const authorize = new URLSearchParams({
		response_type: 'code',
		client_id: props.clientId,
		redirect_uri: fleetAdminProofRedirectUri,
		scope: 'fleet:admin',
		state: controlledSignInIds.nextId(),
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		code_challenge_method: 'S256',
		resource: adminAudience,
	});
	const authorized = await props.harness.auth(`/api/auth/oauth2/authorize?${authorize}`, {
		headers: { cookie: props.cookie, 'sec-fetch-mode': 'navigate', accept: 'text/html' },
	});
	const location = authorized.headers.get('location');
	const code =
		location === null ? null : new URL(location, props.harness.issuer).searchParams.get('code');
	if (code === null)
		throw new Error(
			`Authorization issued no code: status=${authorized.status}; location=${location ?? ''}`,
		);
	return { code, verifier };
}

/** The native token exchange, with an optional DPoP proof and proof-only hold header. */
async function exchangeFleetCode(props: {
	readonly harness: Harness;
	readonly clientId: string;
	readonly authorization: { readonly code: string; readonly verifier: string };
	readonly key: ProofKey | null;
	readonly snapshotProbe?: FleetSnapshotProbe;
}): Promise<Response> {
	return props.harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			...(props.key === null ? {} : { dpop: await dpopProof(props.harness, props.key) }),
			...(props.snapshotProbe === undefined
				? {}
				: { [fleetSnapshotProbeHeader]: JSON.stringify(props.snapshotProbe) }),
		},
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code: props.authorization.code,
			redirect_uri: fleetAdminProofRedirectUri,
			client_id: props.clientId,
			code_verifier: props.authorization.verifier,
			resource: adminAudience,
		}).toString(),
	});
}

async function requestFleetToken(props: {
	readonly harness: Harness;
	readonly cookie: string;
	readonly clientId: string;
	readonly key: ProofKey | null;
}): Promise<Response> {
	return exchangeFleetCode({ ...props, authorization: await authorizeFleetCode(props) });
}

/** A refusal carries an error status and nothing that could be a credential, at any depth;
 * its body names who refused, so a refusal for the wrong reason cannot pass. */
async function expectCredentialFreeRefusal(
	response: Response,
	expected: Readonly<Record<string, unknown>>,
): Promise<void> {
	expect(response.status).toBeGreaterThanOrEqual(400);
	const text = await response.text();
	const body: unknown = text === '' ? null : z.unknown().parse(JSON.parse(text));
	expectNoIssuedCredentials(body);
	expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\.eyJ/u);
	expect(body).toMatchObject(expected);
}

async function publicKeys(harness: Harness): Promise<ReturnType<typeof createLocalJWKSet>> {
	const keys = z
		.object({ keys: z.array(z.looseObject({ kty: z.string(), kid: z.string() })) })
		.parse(await (await harness.auth('/api/auth/jwks')).json());
	return createLocalJWKSet(keys);
}

it('person-fleet token: native issuance binds the key and carries the snapshot the fences held at S', async () => {
	// Arrange
	const { harness, ownerId, organizationId, ownerCookie, clientId } = await setup();
	try {
		const key = await proofKey();
		const snapshotAt = controlledSignInClock.now();
		// Act
		const response = await requestFleetToken({ harness, cookie: ownerCookie, clientId, key });
		// Assert: the token verifies against the issuer's published keys.
		expect(response.status).toBe(200);
		const body = z
			.object({ access_token: z.string(), token_type: z.string() })
			.parse(await response.json());
		expect(body.token_type.toLowerCase()).toBe('dpop');
		const verified = await jwtVerify(body.access_token, await publicKeys(harness), {
			issuer: harness.issuer,
			audience: adminAudience,
			typ: 'at+jwt',
			currentDate: new Date(snapshotAt),
		});
		const pair = (
			await harness.database
				.select()
				.from(personFence)
				.where(
					and(eq(personFence.personId, ownerId), eq(personFence.organizationId, organizationId)),
				)
		)[0];
		const fence = (
			await harness.database
				.select()
				.from(organizationFence)
				.where(eq(organizationFence.id, organizationId))
		)[0];
		const ownerSession = (
			await harness.database
				.select({
					id: session.id,
					expiresAt: session.expiresAt,
					secondFactorAt: session.secondFactorAt,
				})
				.from(session)
				.where(eq(session.id, z.string().parse(verified.payload.sid)))
		)[0];
		if (pair === undefined || fence === undefined || ownerSession === undefined)
			throw new Error('Fixture fences or session missing');
		expect(verified.payload).toMatchObject({
			sub: ownerId,
			cnf: { jkt: key.thumbprint },
			token_profile: 'person-fleet',
			organization_id: organizationId,
			authorization_subject_id: pair.id,
			person_revision: pair.revision,
			organization_revision: fence.revision,
			permission_policy_digest: fleetPermissionPolicyDigest,
			permissions: ownerPermissions,
			session_expires_at_ms: ownerSession.expiresAt.getTime(),
			authorization_snapshot_at_ms: snapshotAt,
			authorization_snapshot_valid_until_ms: snapshotAt + 300_000,
			second_factor_method: expect.any(String),
		});
		// Native iat/exp stay the AS's own: issued now, five minutes.
		expect(verified.payload.iat).toBe(Math.floor(snapshotAt / 1000));
		expect(verified.payload.exp).toBe(Math.floor(snapshotAt / 1000) + 300);
		// The factor time is the session's own confirmation, in seconds.
		expect(verified.payload.second_factor_at).toBe(
			Math.floor(z.number().parse(ownerSession.secondFactorAt) / 1000),
		);
	} finally {
		await harness.close();
	}
});

it('person-fleet token: a member holds no Fleet permissions', async () => {
	const { harness, organizationId, ownerCookie, clientId } = await setup();
	try {
		const invited = await peoplePost(
			harness,
			'invite-member',
			{ organizationId, email: 'member@example.invalid', role: 'member' },
			ownerCookie,
		);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		await signInConfirmedPeopleBrowser({ harness, email: 'member@example.invalid' });
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		const response = await requestFleetToken({
			harness,
			cookie: harness.cookie(),
			clientId,
			key: await proofKey(),
		});
		expect(response.status).toBe(200);
		const token = z.object({ access_token: z.string() }).parse(await response.json()).access_token;
		expect(decodeJwt(token).permissions).toEqual([]);
	} finally {
		await harness.close();
	}
});

it.each(['no-proof', 'old-policy', 'removed-pair', 'stopped-organization'] as const)(
	'person-fleet token: refused with no credential: %s',
	async (mode) => {
		// Arrange: each mode removes one authority the snapshot requires.
		const { harness, ownerId, organizationId, ownerCookie, clientId } = await setup();
		try {
			if (mode === 'old-policy')
				await harness.database
					.update(organizationFence)
					.set({ permissionPolicyDigest: 'e'.repeat(64) })
					.where(eq(organizationFence.id, organizationId));
			if (mode === 'removed-pair')
				await harness.database
					.update(personFence)
					.set({ state: 'inactive' })
					.where(eq(personFence.personId, ownerId));
			if (mode === 'stopped-organization')
				await harness.database
					.update(organizationFence)
					.set({ state: 'stopped' })
					.where(eq(organizationFence.id, organizationId));
			// Act
			const response = await requestFleetToken({
				harness,
				cookie: ownerCookie,
				clientId,
				key: mode === 'no-proof' ? null : await proofKey(),
			});
			// Assert: the AS refuses an unbound request; the contributor names the missing authority.
			await expectCredentialFreeRefusal(
				response,
				mode === 'no-proof'
					? { error: 'invalid_dpop_proof' }
					: {
							error: 'invalid_grant',
							message:
								mode === 'old-policy'
									? 'policy-mismatch'
									: mode === 'removed-pair'
										? 'subject-inactive'
										: 'organization-inactive',
						},
			);
		} finally {
			await harness.close();
		}
	},
);

it('person-fleet token: the management audience keeps its own profile and never carries fleet claims', async () => {
	const { harness } = await setup();
	try {
		const managementToken = await harness.ownerToken();
		const claims = decodeJwt(managementToken);
		expect(claims.aud).not.toBe(adminAudience);
		expect(claims.token_profile).toBeUndefined();
		expect(claims.permissions).toBeUndefined();
	} finally {
		await harness.close();
	}
});

it('person-fleet token: a snapshot held until exactly S + L is never released', async () => {
	// Arrange: once the coherent read returns, the controlled clock reaches the signed deadline.
	const { harness, ownerCookie, clientId } = await setup();
	try {
		const authorization = await authorizeFleetCode({ harness, cookie: ownerCookie, clientId });
		// Act
		const response = await exchangeFleetCode({
			harness,
			clientId,
			authorization,
			key: await proofKey(),
			snapshotProbe: { mode: 'advance', milliseconds: 300_000 },
		});
		// Assert. In this issuer native iat is sampled before S, so native exp is at or before
		// S + L here too; the snapshot-only negative is the pure release unit's vector.
		// The release fence's own refusal: a bare invalid_grant.
		await expectCredentialFreeRefusal(response, { error: 'invalid_grant' });
	} finally {
		await harness.close();
	}
});

it('person-fleet token: a first membership created while a session deletion is held is in its fan-out, and the held issuance never releases', async () => {
	// Arrange: owner session with organization A; a code for it before anything is held.
	const { harness, ownerId, organizationId, ownerCookie, clientId } = await setup();
	try {
		const authorization = await authorizeFleetCode({ harness, cookie: ownerCookie, clientId });
		const ownerSession = (
			await harness.database
				.select({ id: session.id })
				.from(session)
				.where(eq(session.userId, ownerId))
		).at(-1);
		if (ownerSession === undefined) throw new Error('Owner session missing');
		const issuanceKey = controlledSignInIds.nextId();
		const deletionKey = controlledSignInIds.nextId();
		for (const key of [issuanceKey, deletionKey])
			expect(
				(await harness.auth(`/__auth-proof/hold/arm?key=${key}`, { method: 'POST' })).status,
			).toBe(200);
		// The issuance reads its snapshot while the session is live, then waits.
		const issuance = exchangeFleetCode({
			harness,
			clientId,
			authorization,
			key: await proofKey(),
			snapshotProbe: { mode: 'barrier', key: issuanceKey },
		});
		expect(
			await (await harness.auth(`/__auth-proof/hold/entered?key=${issuanceKey}`)).json(),
		).toEqual({ point: fleetSnapshotHoldPoint });
		// The session deletion's fixed batch is built, then waits before dispatch.
		const deletion = harness.auth('/__auth-proof/authorization-fence', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: ownerCookie },
			body: JSON.stringify({
				kind: 'delete',
				model: 'session',
				where: [{ field: 'id', value: ownerSession.id }],
				holdBeforeBatch: deletionKey,
			}),
		});
		expect(
			await (await harness.auth(`/__auth-proof/hold/entered?key=${deletionKey}`)).json(),
		).toEqual({ point: 'before-authorization-fence-batch' });
		// Act: a first membership in organization B is created while the session is still live.
		const created = await harness.auth('/__auth-proof/authorization-fence', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: ownerCookie },
			body: JSON.stringify({
				kind: 'native',
				path: 'organization/create',
				body: { name: 'Second organization', slug: 'second-organization' },
			}),
		});
		expect(created.status).toBe(200);
		const secondOrganizationId = z.object({ id: z.uuidv7() }).parse(await created.json()).id;
		const pairsBefore = await harness.database
			.select({ organizationId: personFence.organizationId, revision: personFence.revision })
			.from(personFence)
			.where(eq(personFence.personId, ownerId));
		expect(pairsBefore).toEqual(
			expect.arrayContaining([{ organizationId: secondOrganizationId, revision: 1 }]),
		);
		expect(
			(await harness.auth(`/__auth-proof/hold/release?key=${deletionKey}`, { method: 'POST' }))
				.status,
		).toBe(200);
		expect((await deletion).status).toBe(200);
		// Assert: the deletion's predicate, evaluated in its batch, saw the new pair.
		expect(
			await harness.database.select().from(session).where(eq(session.id, ownerSession.id)),
		).toEqual([]);
		const pairsAfter = await harness.database
			.select({ organizationId: personFence.organizationId, revision: personFence.revision })
			.from(personFence)
			.where(eq(personFence.personId, ownerId));
		for (const pair of pairsBefore)
			expect(pairsAfter).toContainEqual({
				organizationId: pair.organizationId,
				revision: pair.revision + 1,
			});
		expect(pairsAfter.find((pair) => pair.organizationId === organizationId)).toBeDefined();
		// And the issuance held across the deletion is refused at release.
		expect(
			(await harness.auth(`/__auth-proof/hold/release?key=${issuanceKey}`, { method: 'POST' }))
				.status,
		).toBe(200);
		await expectCredentialFreeRefusal(await issuance, { error: 'invalid_grant' });
	} finally {
		await harness.close();
	}
});

it('person-fleet token: a session deleted before the exchange leaves its code unable to mint', async () => {
	const { harness, ownerId, ownerCookie, clientId } = await setup();
	try {
		const authorization = await authorizeFleetCode({ harness, cookie: ownerCookie, clientId });
		const sessions = await harness.database
			.select({ id: session.id })
			.from(session)
			.where(eq(session.userId, ownerId));
		for (const row of sessions)
			expect(
				(
					await harness.auth('/__auth-proof/authorization-fence', {
						method: 'POST',
						headers: { 'content-type': 'application/json', cookie: ownerCookie },
						body: JSON.stringify({
							kind: 'delete',
							model: 'session',
							where: [{ field: 'id', value: row.id }],
						}),
					})
				).status,
			).toBe(200);
		await expectCredentialFreeRefusal(
			await exchangeFleetCode({ harness, clientId, authorization, key: await proofKey() }),
			// The native AS refuses a code whose session is gone before any claims are built.
			{ error: 'invalid_request' },
		);
	} finally {
		await harness.close();
	}
});
