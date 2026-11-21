import { createHash } from 'node:crypto';

import {
	epochMillisecondsSchema,
	invitation,
	member,
	session,
	signInAudit,
	twoFactor,
	user,
} from '@agent-collaboration/sign-in-core';
import { organizationPersonTokenClaimsSchema } from '@agent-collaboration/sign-in-core/person-identity';
import { and, eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { renderSVG } from 'uqr';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { tokenForCurrentOwnerSession } from '#sign-in-test-support/test-fixtures/current-session-owner-token';
import { createObservedProofJwks } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import {
	peoplePost,
	signInPeopleBrowser,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();
const ownerEmail = 'owner@example.invalid';
type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;
function factorPost(
	harness: Harness,
	route: string,
	body: Readonly<Record<string, unknown>>,
): Promise<Response> {
	return harness.auth('/api/auth/two-factor/' + route, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}
async function setClock(harness: Harness, milliseconds: number): Promise<void> {
	expect(
		(
			await harness.auth('/__auth-proof/set-clock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ milliseconds }),
			})
		).status,
	).toBe(200);
}
async function appFlags(harness: Harness, personId: string): Promise<unknown> {
	return (
		await harness.database
			.select({ enabled: user.twoFactorEnabled, setAt: user.secondFactorSetAt })
			.from(user)
			.where(eq(user.id, personId))
	)[0];
}
async function codeFingerprint(harness: Harness, personId: string): Promise<string> {
	const rows = await harness.database
		.select({ codes: twoFactor.backupCodes })
		.from(twoFactor)
		.where(eq(twoFactor.userId, personId));
	return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

it('people: first app verification rotates the native session and its new token carries the recorded method and time', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInPeopleBrowser({ harness, email: ownerEmail });
		const before = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		const refused = await peoplePost(harness, 'create', { name: 'Too early', slug: 'too-early' });
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
		expect((await harness.auth('/api/auth/passkey/generate-register-options')).status).toBe(403);
		expect((await harness.totpAuthenticator.enrollApp(ownerEmail, harness.auth)).status).toBe(200);
		expect(harness.totpAuthenticator.recoveryCodeCount(ownerEmail)).toBeGreaterThan(0);
		expect(await appFlags(harness, personId)).toEqual({ enabled: false, setAt: null });
		const codes = await codeFingerprint(harness, personId);
		expect(
			(
				await factorPost(harness, 'verify-backup-code', {
					code: harness.totpAuthenticator.recoveryCode(ownerEmail),
				})
			).status,
		).toBe(403);
		expect(await codeFingerprint(harness, personId)).toBe(codes);
		const confirmed = await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth);
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).not.toHaveProperty('token');
		const after = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect(after.id).not.toBe(before.id);
		expect(
			await harness.database
				.select({ id: session.id })
				.from(session)
				.where(eq(session.id, before.id)),
		).toEqual([]);
		expect(after).toMatchObject({
			personId,
			secondFactorAt: controlledSignInClock.now(),
			secondFactorMethod: 'app',
		});
		expect(await appFlags(harness, personId)).toEqual({
			enabled: true,
			setAt: controlledSignInClock.now(),
		});
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const token = await tokenForCurrentOwnerSession(harness);
		const signed = await jwtVerify(
			token,
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{ issuer: harness.issuer, audience: harness.target.managementAudience },
		);
		const claims = organizationPersonTokenClaimsSchema.parse(signed.payload);
		expect(claims.sid).toBe(after.id);
		expect(claims.organization_id).toBe(organizationId);
		expect(claims.second_factor_at).toBe(Math.floor(controlledSignInClock.now() / 1000));
		expect(claims.second_factor_method).toBe('app');
		expect(Object.hasOwn(signed.payload, 'amr')).toBe(false);
	} finally {
		await harness.close();
	}
});

it('people: later app confirmation stamps the injected clock on the same session and keeps first recorded enrollment time', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const first = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		const now = controlledSignInClock.now() + 1000;
		await setClock(harness, now);
		const confirmed = await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth);
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).not.toHaveProperty('token');
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toMatchObject({ id: first.id, secondFactorAt: now, secondFactorMethod: 'app' });
		expect(await appFlags(harness, personId)).toEqual({
			enabled: true,
			setAt: first.secondFactorAt,
		});
		await ensureLocalOwnerOrganization({ auth: harness.auth, database: harness.database });
		const remintAt = epochMillisecondsSchema.parse(controlledSignInClock.now() + 61_000);
		await setClock(harness, remintAt);
		const signed = await jwtVerify(
			await tokenForCurrentOwnerSession(harness, remintAt),
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{
				issuer: harness.issuer,
				audience: harness.target.managementAudience,
			},
		);
		const claims = organizationPersonTokenClaimsSchema.parse(signed.payload);
		expect(claims.iat).toBe(Math.floor(remintAt / 1000));
		expect(claims.second_factor_at).toBe(Math.floor(now / 1000));
		expect(claims.second_factor_method).toBe('app');
	} finally {
		await harness.close();
	}
});

it('people: recovery codes confirm once, refuse reuse without a new stamp, and never offer trustDevice or the app secret again', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		await ensureLocalOwnerOrganization({ auth: harness.auth, database: harness.database });
		const first = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		const code = harness.totpAuthenticator.recoveryCode(ownerEmail);
		const now = controlledSignInClock.now() + 1000;
		await setClock(harness, now);
		const confirmed = await factorPost(harness, 'verify-backup-code', { code });
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).not.toHaveProperty('token');
		expect(
			await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }),
		).toMatchObject({ id: first.id, secondFactorAt: now, secondFactorMethod: 'recoveryCode' });
		const signed = await jwtVerify(
			await tokenForCurrentOwnerSession(harness),
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{
				issuer: harness.issuer,
				audience: harness.target.managementAudience,
			},
		);
		expect(organizationPersonTokenClaimsSchema.parse(signed.payload).second_factor_method).toBe(
			'recoveryCode',
		);
		expect(Object.hasOwn(signed.payload, 'amr')).toBe(false);
		await setClock(harness, now + 1000);
		expect((await factorPost(harness, 'verify-backup-code', { code })).status).toBe(401);
		expect(
			(await readCurrentBrowserSession({ cookie: harness.cookie(), database: harness.database }))
				.secondFactorAt,
		).toBe(now);
		expect(
			(
				await factorPost(harness, 'verify-totp', {
					code: await harness.totpAuthenticator.currentCode(ownerEmail),
					trustDevice: true,
				})
			).status,
		).toBe(400);
		expect((await factorPost(harness, 'get-totp-uri', {})).status).toBe(404);
		expect((await factorPost(harness, 'disable', {})).status).toBe(404);
	} finally {
		await harness.close();
	}
});

it('people: a native app survives a lost stamp and recovery records the first known confirmation without settling old history', async () => {
	const harness = await startLocalAuthHarness();
	try {
		const personId = await signInPeopleBrowser({ harness, email: ownerEmail });
		expect((await harness.totpAuthenticator.enrollApp(ownerEmail, harness.auth)).status).toBe(200);
		const code = harness.totpAuthenticator.recoveryCode(ownerEmail);
		await harness.setDatabaseFault({
			operation: 'update',
			table: 'user',
			key: personId,
			column: 'secondFactorSetAt',
		});
		expect((await harness.totpAuthenticator.confirmApp(ownerEmail, harness.auth)).status).toBe(503);
		await harness.setDatabaseFault(null);
		expect(await appFlags(harness, personId)).toEqual({ enabled: true, setAt: null });
		expect(
			await harness.database
				.select({ verified: twoFactor.verified })
				.from(twoFactor)
				.where(eq(twoFactor.userId, personId)),
		).toEqual([{ verified: true }]);
		const oldIntent = z.object({ requestId: z.uuidv7() }).parse(
			(
				await harness.database
					.select({ requestId: signInAudit.requestId })
					.from(signInAudit)
					.where(
						and(
							eq(signInAudit.actorUserId, personId),
							eq(signInAudit.changeKind, 'app-confirmed'),
							eq(signInAudit.phase, 'intent'),
						),
					)
			)[0],
		);
		await signInPeopleBrowser({ harness, email: ownerEmail });
		const refused = await harness.auth('/api/auth/passkey/generate-register-options');
		expect(refused.status).toBe(403);
		expect(await refused.json()).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
		const now = controlledSignInClock.now() + 1000;
		await setClock(harness, now);
		expect((await factorPost(harness, 'verify-backup-code', { code })).status).toBe(200);
		expect(await appFlags(harness, personId)).toEqual({ enabled: true, setAt: now });
		expect(
			await harness.database
				.select({ phase: signInAudit.phase })
				.from(signInAudit)
				.where(eq(signInAudit.requestId, oldIntent.requestId)),
		).toEqual([{ phase: 'intent' }]);
	} finally {
		await harness.close();
	}
});

it('people: another social session cannot borrow a confirmation or replace factors from the first session', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const organizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const confirmedCookie = harness.cookie();
		const first = await readCurrentBrowserSession({
			cookie: confirmedCookie,
			database: harness.database,
		});
		await signInPeopleBrowser({ harness, email: ownerEmail });
		const current = await readCurrentBrowserSession({
			cookie: harness.cookie(),
			database: harness.database,
		});
		expect(current.id).not.toBe(first.id);
		expect(current.secondFactorAt).toBeNull();
		const signed = await jwtVerify(
			await tokenForCurrentOwnerSession(harness),
			createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
			{
				issuer: harness.issuer,
				audience: harness.target.managementAudience,
			},
		);
		const unconfirmed = organizationPersonTokenClaimsSchema.parse(signed.payload);
		expect(unconfirmed.sid).toBe(current.id);
		expect(Object.hasOwn(signed.payload, 'second_factor_at')).toBe(false);
		expect(Object.hasOwn(signed.payload, 'second_factor_method')).toBe(false);
		expect(Object.hasOwn(signed.payload, 'amr')).toBe(false);
		const responses = await Promise.all(
			['enable', 'generate-backup-codes', 'remove-app'].map((route) =>
				factorPost(
					harness,
					route,
					route === 'remove-app'
						? {}
						: { secondFactorAt: first.secondFactorAt, sessionId: first.id },
				),
			),
		);
		expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
		const bodies = await Promise.all(responses.map((response) => response.json()));
		for (const body of bodies) expect(body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
		expect((await harness.auth('/api/auth/passkey/generate-register-options')).status).toBe(403);
		const refused = await peoplePost(harness, 'invite-member', {
			organizationId,
			email: 'refused@example.invalid',
			role: 'member',
			secondFactorAt: first.secondFactorAt,
			sessionId: first.id,
		});
		expect(refused.status).toBe(403);
		expect(
			(
				await peoplePost(
					harness,
					'invite-member',
					{ organizationId, email: 'allowed@example.invalid', role: 'member' },
					confirmedCookie,
				)
			).status,
		).toBe(200);
	} finally {
		await harness.close();
	}
});

it('people: all four native people hooks accept exactly fifteen minutes and refuse the next millisecond without effects or records', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
		const ownerCookie = harness.cookie();
		const firstOrganizationId = await ensureLocalOwnerOrganization({
			auth: harness.auth,
			database: harness.database,
		});
		const secondOrganization = await peoplePost(
			harness,
			'create',
			{ name: 'Second', slug: 'second' },
			ownerCookie,
		);
		expect(secondOrganization.status).toBe(200);
		const secondOrganizationId = z
			.object({ id: z.uuidv7() })
			.parse(await secondOrganization.json()).id;
		async function invite(email: string, organizationId = firstOrganizationId): Promise<string> {
			const response = await peoplePost(
				harness,
				'invite-member',
				{ organizationId, email, role: 'member' },
				ownerCookie,
			);
			expect(response.status).toBe(200);
			return z.object({ id: z.uuidv7() }).parse(await response.json()).id;
		}
		async function establishMember(email: string): Promise<{
			readonly personId: string;
			readonly membershipId: string;
		}> {
			const invitationId = await invite(email);
			const personId = await signInConfirmedPeopleBrowser({ harness, email });
			expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
			const membership = z.object({ id: z.uuidv7() }).parse(
				(
					await harness.database
						.select({ id: member.id })
						.from(member)
						.where(and(eq(member.userId, personId), eq(member.organizationId, firstOrganizationId)))
				)[0],
			);
			return { personId, membershipId: membership.id };
		}
		const firstRemovePerson = await establishMember('remove-edge@example.invalid');
		const secondRemovePerson = await establishMember('remove-expired@example.invalid');
		const [firstCancel, secondCancel, firstAccept, secondAccept] = await Promise.all([
			invite('cancel-edge@example.invalid'),
			invite('cancel-expired@example.invalid'),
			invite('accept-edge@example.invalid'),
			invite('accept-edge@example.invalid', secondOrganizationId),
		]);
		if (
			firstCancel === undefined ||
			secondCancel === undefined ||
			firstAccept === undefined ||
			secondAccept === undefined
		)
			throw new Error('People edge fixture missing distinct targets');
		const acceptPerson = await signInConfirmedPeopleBrowser({
			harness,
			email: 'accept-edge@example.invalid',
		});
		const acceptCookie = harness.cookie();
		const at = controlledSignInClock.now();
		const initialRecords = await harness.database
			.select({ id: signInAudit.id })
			.from(signInAudit)
			.where(eq(signInAudit.kind, 'organization-people-changed'));
		// Different valid targets keep the refusal attributable to the age guard,
		// rather than a target already changed by the successful boundary request.
		await setClock(harness, at + 900_000);
		// Native memberIdOrEmail resolves a membership ID, not a person ID.
		// Keep this refusal as a control so a malformed target cannot masquerade
		// as an age refusal or be attributed to the concurrent operations below.
		const wrongTarget = await peoplePost(
			harness,
			'remove-member',
			{
				organizationId: firstOrganizationId,
				memberIdOrEmail: firstRemovePerson.personId,
			},
			ownerCookie,
		);
		expect(wrongTarget.status).toBe(400);
		expect(await wrongTarget.json()).toEqual({
			code: 'MEMBER_NOT_FOUND',
			message: 'Member not found',
		});
		const edge = await Promise.all([
			peoplePost(
				harness,
				'invite-member',
				{
					organizationId: firstOrganizationId,
					email: 'invite-edge@example.invalid',
					role: 'member',
				},
				ownerCookie,
			),
			peoplePost(harness, 'cancel-invitation', { invitationId: firstCancel }, ownerCookie),
			peoplePost(harness, 'accept-invitation', { invitationId: firstAccept }, acceptCookie),
			peoplePost(
				harness,
				'remove-member',
				{ organizationId: firstOrganizationId, memberIdOrEmail: firstRemovePerson.membershipId },
				ownerCookie,
			),
		]);
		expect(edge.map((response) => response.status)).toEqual([200, 200, 200, 200]);
		const edgeRecords = await harness.database
			.select({ id: signInAudit.id })
			.from(signInAudit)
			.where(eq(signInAudit.kind, 'organization-people-changed'))
			.orderBy(signInAudit.id);
		expect(edgeRecords.length - initialRecords.length).toBe(8);
		await setClock(harness, at + 900_001);
		const expired = await Promise.all([
			peoplePost(
				harness,
				'invite-member',
				{
					organizationId: firstOrganizationId,
					email: 'invite-expired@example.invalid',
					role: 'member',
				},
				ownerCookie,
			),
			peoplePost(harness, 'cancel-invitation', { invitationId: secondCancel }, ownerCookie),
			peoplePost(harness, 'accept-invitation', { invitationId: secondAccept }, acceptCookie),
			peoplePost(
				harness,
				'remove-member',
				{ organizationId: firstOrganizationId, memberIdOrEmail: secondRemovePerson.membershipId },
				ownerCookie,
			),
		]);
		expect(expired.map((response) => response.status)).toEqual([403, 403, 403, 403]);
		for (const body of await Promise.all(expired.map((response) => response.json())))
			expect(body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
		expect(
			await harness.database
				.select({ id: signInAudit.id })
				.from(signInAudit)
				.where(eq(signInAudit.kind, 'organization-people-changed'))
				.orderBy(signInAudit.id),
		).toEqual(edgeRecords);
		expect(
			await harness.database
				.select({ id: invitation.id })
				.from(invitation)
				.where(eq(invitation.email, 'invite-expired@example.invalid')),
		).toEqual([]);
		expect(
			await harness.database
				.select({ status: invitation.status })
				.from(invitation)
				.where(eq(invitation.id, secondCancel)),
		).toEqual([{ status: 'pending' }]);
		expect(
			await harness.database
				.select({ status: invitation.status })
				.from(invitation)
				.where(eq(invitation.id, secondAccept)),
		).toEqual([{ status: 'pending' }]);
		expect(
			await harness.database
				.select({ id: member.id })
				.from(member)
				.where(
					and(eq(member.organizationId, secondOrganizationId), eq(member.userId, acceptPerson)),
				),
		).toEqual([]);
		expect(
			await harness.database
				.select({ userId: member.userId })
				.from(member)
				.where(eq(member.userId, secondRemovePerson.personId)),
		).toEqual([{ userId: secondRemovePerson.personId }]);
	} finally {
		await harness.close();
	}
});

it('people: the native setup form returns the exact URI as server SVG and never repeats its secret on other pages or observations', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: ownerEmail });
		const before = await harness.auth('/owner-ready');
		expect(await before.text()).toContain('Set up authenticator app');
		// The native router accepts JSON only. Keep this control so the page
		// transport cannot silently weaken or bypass its media-type check.
		const unsupported = await harness.auth('/api/auth/two-factor/enable', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
			body: new URLSearchParams({ method: 'totp' }).toString(),
		});
		expect(unsupported.status).toBe(415);
		const setup = await harness.auth('/api/auth/two-factor/enable', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/html' },
			body: JSON.stringify({ method: 'totp' }),
		});
		expect(setup.status).toBe(200);
		expect(setup.headers.get('content-type')).toContain('text/html');
		expect(setup.headers.get('cache-control')).toBe('no-store');
		const html = await setup.text();
		const encodedUri = z
			.string()
			.startsWith('otpauth://')
			.parse(/<code id="totp-uri">([^<]+)<\/code>/u.exec(html)?.[1]);
		const nativeUri = encodedUri.replaceAll('&amp;', '&');
		const secret = z.string().min(1).parse(new URL(nativeUri).searchParams.get('secret'));
		// People's authenticator app lists the account under Switchboard (A10).
		expect(new URL(nativeUri).searchParams.get('issuer')).toBe('Switchboard');
		expect(new URL(nativeUri).pathname.startsWith('/Switchboard:')).toBe(true);
		// Boolean assertions keep even a failure from printing the generated
		// secret, recovery codes, URI, or its machine-readable QR representation.
		expect(html.match(/<svg\b[\s\S]*?<\/svg>/u)?.[0] === renderSVG(nativeUri)).toBe(true);
		expect(html.includes(`<code id="totp-secret">${secret}</code>`)).toBe(true);
		const other = await Promise.all([harness.auth('/sign-in'), harness.auth('/owner-ready')]);
		for (const text of await Promise.all(other.map((response) => response.text()))) {
			expect(text.includes(secret)).toBe(false);
			expect(text.includes(nativeUri)).toBe(false);
		}
		expect((await factorPost(harness, 'get-totp-uri', {})).status).toBe(404);
		expect(JSON.stringify(await harness.captchaObservations()).includes(secret)).toBe(false);
	} finally {
		await harness.close();
	}
});
