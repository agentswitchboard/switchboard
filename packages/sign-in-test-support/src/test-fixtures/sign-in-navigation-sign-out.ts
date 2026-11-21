import {
	personOrganizationAuthorizationRevisions,
	session,
} from '@agent-collaboration/sign-in-core';
import { getSessionCookie } from 'better-auth/cookies';
import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { organizationBrowserCookie } from '#sign-in-test-support/test-fixtures/organization-browser-transport';
import { signInConfirmedPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { waitForBrowserEvent } from '#sign-in-test-support/test-fixtures/playwright-network';
import {
	navigationOwnerEmail,
	runNavigationSteps,
	signOutPath,
	visitNavigation,
	type NavigationBrowser,
} from '#sign-in-test-support/test-fixtures/sign-in-navigation-browser';

function signedBrowserToken(cookie: string): string | null {
	return getSessionCookie(new Headers({ cookie }));
}

async function sessionRow(
	browser: NavigationBrowser,
	id: string,
): Promise<{ readonly id: string; readonly token: string }> {
	const rows = await browser.harness.database
		.select({ id: session.id, token: session.token })
		.from(session)
		.where(eq(session.id, id));
	return z.object({ id: z.uuidv7(), token: z.string().min(1) }).parse(rows[0]);
}

async function readRetainedRevision(browser: NavigationBrowser): Promise<number> {
	const rows = await browser.harness.database
		.select({ revision: personOrganizationAuthorizationRevisions.revision })
		.from(personOrganizationAuthorizationRevisions)
		.where(
			and(
				eq(personOrganizationAuthorizationRevisions.personId, browser.ownerId),
				eq(personOrganizationAuthorizationRevisions.organizationId, browser.organization.id),
			),
		);
	return z.object({ revision: z.number().int() }).parse(rows[0]).revision;
}

export async function observeExpiredShellEntry(browser: NavigationBrowser): Promise<void> {
	const { harness, ownerCookie } = browser;
	const current = await readCurrentBrowserSession({
		cookie: ownerCookie,
		database: harness.database,
	});
	const expiredAt = new Date(controlledSignInClock.now() - 1);
	await harness.database
		.update(session)
		.set({ expiresAt: expiredAt })
		.where(eq(session.id, current.id));
	const retainedRevision = await readRetainedRevision(browser);
	await runNavigationSteps(['/me', '/people'], async (route): Promise<void> => {
		const refused = await harness.auth(route, { headers: { cookie: ownerCookie } });
		expect(refused.status).toBe(303);
		expect(refused.headers.get('location')).toBe('/sign-in');
		expect(refused.headers.getSetCookie()).toEqual([]);
		expect(
			await harness.database
				.select({ id: session.id, expiresAt: session.expiresAt })
				.from(session)
				.where(eq(session.id, current.id)),
		).toEqual([{ id: current.id, expiresAt: expiredAt }]);
		expect(await readRetainedRevision(browser)).toBe(retainedRevision);
	});
}

export async function observeInvalidShellCookie(browser: NavigationBrowser): Promise<void> {
	const { harness, ownerCookie } = browser;
	const current = await readCurrentBrowserSession({
		cookie: ownerCookie,
		database: harness.database,
	});
	async function readSessionFacts(): Promise<unknown> {
		return (
			await harness.database
				.select({
					id: session.id,
					personId: session.userId,
					activeOrganizationId: session.activeOrganizationId,
					expiresAt: session.expiresAt,
					updatedAt: session.updatedAt,
					confirmedAt: session.secondFactorAt,
					confirmationMethod: session.secondFactorMethod,
				})
				.from(session)
				.where(eq(session.id, current.id))
		)[0];
	}
	const sessionBefore = await readSessionFacts();
	const retainedRevision = await readRetainedRevision(browser);
	const invalid = changedSignature(ownerCookie);
	await runNavigationSteps(['/me', '/people'], async (route): Promise<void> => {
		const admitted = await harness.auth(route, { headers: { cookie: ownerCookie } });
		expect(admitted.status).toBe(200);
		const refused = await harness.auth(route, { headers: { cookie: invalid } });
		expect(refused.status).toBe(303);
		expect(refused.headers.get('location')).toBe('/sign-in');
		expect(refused.headers.getSetCookie()).toEqual([]);
		expect(
			await readCurrentBrowserSession({ cookie: ownerCookie, database: harness.database }),
		).toEqual(current);
		expect(await readSessionFacts()).toEqual(sessionBefore);
		expect(await readRetainedRevision(browser)).toBe(retainedRevision);
	});
}

export async function observeEndpointSignOutOrigin(browser: NavigationBrowser): Promise<void> {
	const { harness, ownerCookie } = browser;
	const current = await readCurrentBrowserSession({
		cookie: ownerCookie,
		database: harness.database,
	});
	const row = await sessionRow(browser, current.id);
	const retainedRevision = await readRetainedRevision(browser);
	await harness.setDatabaseFault({
		operation: 'select',
		table: 'session',
		projection: 'session-id-by-token',
		key: row.token,
		once: true,
	});
	// The provider canonicalizes trusted HTTP origins with URL.origin. Its
	// middleware admits this synthetic path-qualified origin; our guard must reject the actual header.
	const refusal = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: ownerCookie, origin: `${harness.issuer}/origin-proof` },
	});
	expect(refusal.status).toBe(403);
	expect(await refusal.json()).toEqual({ error: 'not-allowed' });
	expect(refusal.headers.getSetCookie()).toEqual([]);
	const invalidCookieRefusal = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: changedSignature(ownerCookie), origin: `${harness.issuer}/origin-proof` },
	});
	expect(invalidCookieRefusal.status).toBe(403);
	expect(await invalidCookieRefusal.json()).toEqual({ error: 'not-allowed' });
	expect(invalidCookieRefusal.headers.getSetCookie()).toEqual([]);
	// The first lookup still hits the one-use driver fault. If the
	// refused request consumed it, the matching legitimate POST deletes the row.
	const allowed = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: ownerCookie },
	});
	expect(allowed.status).toBe(503);
	expect(allowed.headers.getSetCookie()).toEqual([]);
	expect((await sessionRow(browser, current.id)).id).toBe(current.id);
	expect(await readRetainedRevision(browser)).toBe(retainedRevision);
}

function changedSignature(cookie: string): string {
	const sessionPair = cookie
		.split(';')
		.map((pair) => pair.trim())
		.find((pair) => /^(?:__Secure-)?better-auth[.-]session_token=/u.test(pair));
	if (sessionPair === undefined) throw new Error('Fixture has no signed cookie');
	const valueStart = sessionPair.indexOf('=') + 1;
	const signed = decodeURIComponent(sessionPair.slice(valueStart));
	const signatureStart = signed.lastIndexOf('.') + 1;
	if (signatureStart <= 0 || signatureStart >= signed.length)
		throw new Error('Fixture has no signature');
	const different = signed[signatureStart] === 'A' ? 'B' : 'A';
	const altered = `${signed.slice(0, signatureStart)}${different}${signed.slice(signatureStart + 1)}`;
	return cookie.replace(
		sessionPair,
		`${sessionPair.slice(0, valueStart)}${encodeURIComponent(altered)}`,
	);
}

export async function observeExpiredAndInvalidSignOut(browser: NavigationBrowser): Promise<void> {
	const { harness, ownerCookie } = browser;
	const current = await readCurrentBrowserSession({
		cookie: ownerCookie,
		database: harness.database,
	});
	const retainedRevision = await readRetainedRevision(browser);
	const invalid = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: changedSignature(ownerCookie) },
	});
	expect(invalid.status).toBe(401);
	expect(invalid.headers.getSetCookie()).toEqual([]);
	expect((await sessionRow(browser, current.id)).id).toBe(current.id);
	expect(await readRetainedRevision(browser)).toBe(retainedRevision);

	const expiredAt = new Date(controlledSignInClock.now() - 1);
	await harness.database
		.update(session)
		.set({ expiresAt: expiredAt })
		.where(eq(session.id, current.id));
	const exactExpiry = (
		await harness.database
			.select({ expiry: session.expiresAt })
			.from(session)
			.where(eq(session.id, current.id))
	)[0];
	expect(exactExpiry?.expiry).toEqual(expiredAt);
	const signedOut = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: ownerCookie },
	});
	expect(signedOut.status).toBe(303);
	expect(signedOut.headers.get('location')).toBe('/sign-in');
	expect(
		await harness.database
			.select({ id: session.id })
			.from(session)
			.where(eq(session.id, current.id)),
	).toEqual([]);
	expect(await readRetainedRevision(browser)).toBe(retainedRevision + 1);
	expect(
		signedOut.headers
			.getSetCookie()
			.some((cookie) => cookie.includes('session_token=') && /Max-Age=0/iu.test(cookie)),
	).toBe(true);
}

async function observeSignOutStatus(
	proof: NavigationBrowser['proof'],
	submit: () => Promise<void>,
): Promise<number> {
	// A manual redirect is opaque to Fetch. Observe the replay's wire
	// status through CDP's raw response headers, before the document is replaced.
	let replayRequestId: string | undefined;
	function rememberReplay(event: {
		readonly requestId: string;
		readonly request: { readonly method: string; readonly url: string };
	}): void {
		if (event.request.method === 'POST' && new URL(event.request.url).pathname === signOutPath)
			replayRequestId = event.requestId;
	}
	proof.protocol.on('Network.requestWillBeSent', rememberReplay);
	const replay = waitForBrowserEvent<{ readonly requestId: string; readonly statusCode: number }>({
		signal: proof.signal,
		subscribe(receive) {
			proof.protocol.on('Network.responseReceivedExtraInfo', receive);
			return (): void => {
				proof.protocol.off('Network.responseReceivedExtraInfo', receive);
			};
		},
		matches: (receipt) => receipt.requestId === replayRequestId,
	});
	try {
		await submit();
		return (await replay.completed).statusCode;
	} finally {
		replay.cancel();
		proof.protocol.off('Network.requestWillBeSent', rememberReplay);
	}
}

export async function observeNavigationSignOut(browser: NavigationBrowser): Promise<void> {
	const { harness, proof, ownerCookie, ownerId, organization } = browser;
	await visitNavigation(browser, '/me');
	const originalCookie = await organizationBrowserCookie(proof, harness.issuer);
	const original = await readCurrentBrowserSession({
		cookie: originalCookie,
		database: harness.database,
	});
	const row = await sessionRow(browser, original.id);

	await signInConfirmedPeopleBrowser({ harness, email: navigationOwnerEmail });
	const otherCookie = harness.cookie();
	const other = await readCurrentBrowserSession({
		cookie: otherCookie,
		database: harness.database,
	});
	expect(other.id).not.toBe(original.id);
	expect(other.personId).toBe(original.personId);

	async function facts(): Promise<{ readonly present: boolean; readonly revision: number }> {
		const [rows, revisions] = await Promise.all([
			harness.database.select({ id: session.id }).from(session).where(eq(session.token, row.token)),
			harness.database
				.select({ revision: personOrganizationAuthorizationRevisions.revision })
				.from(personOrganizationAuthorizationRevisions)
				.where(
					and(
						eq(personOrganizationAuthorizationRevisions.personId, ownerId),
						eq(personOrganizationAuthorizationRevisions.organizationId, organization.id),
					),
				),
		]);
		return {
			present: rows.length === 1,
			revision: z.object({ revision: z.number().int() }).parse(revisions[0]).revision,
		};
	}
	const before = await facts();
	expect(before.present).toBe(true);
	const native = await harness.auth('/api/auth/sign-out', {
		method: 'POST',
		headers: { cookie: ownerCookie },
	});
	expect(native.status).toBe(404);
	const crossOrigin = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: originalCookie, origin: 'https://foreign.example.invalid' },
	});
	expect(crossOrigin.status).toBe(403);
	expect(crossOrigin.headers.getSetCookie()).toEqual([]);
	expect(await facts()).toEqual(before);

	const button = proof.page.getByRole('button', { name: 'Sign out', exact: true });
	async function attemptFromBrowser(): Promise<void> {
		expect(await observeSignOutStatus(proof, () => button.click())).toBe(503);
		await proof.page.getByRole('alert').getByText("Couldn't sign you out; try again").waitFor();
		expect(
			signedBrowserToken(await organizationBrowserCookie(proof, harness.issuer)) ===
				signedBrowserToken(originalCookie),
		).toBe(true);
	}

	await harness.setDatabaseFault({
		operation: 'delete',
		table: 'session',
		key: row.token,
		once: true,
	});
	await attemptFromBrowser();
	expect(await facts()).toEqual(before);

	await harness.setDatabaseFault({
		operation: 'select',
		table: 'session',
		projection: 'session-id-by-token',
		key: row.token,
		once: true,
	});
	await attemptFromBrowser();
	expect(await facts()).toEqual(before);

	await harness.setDatabaseFault({
		operation: 'select',
		table: 'session',
		projection: 'session-id-by-token',
		key: row.token,
		skipMatches: 1,
		once: true,
	});
	await attemptFromBrowser();
	expect(await facts()).toEqual({ present: false, revision: before.revision + 1 });

	expect(
		await observeSignOutStatus(proof, () =>
			proof.afterNavigation('/sign-in', () => button.click()),
		),
	).toBe(303);
	expect(signedBrowserToken(await organizationBrowserCookie(proof, harness.issuer))).toBeNull();
	expect(await facts()).toEqual({ present: false, revision: before.revision + 1 });
	expect((await sessionRow(browser, other.id)).id).toBe(other.id);
	expect((await harness.auth('/me', { headers: { cookie: otherCookie } })).status).toBe(200);
	const signedOut = await harness.auth('/me', { headers: { cookie: originalCookie } });
	expect(signedOut.status).toBe(303);
	expect(signedOut.headers.get('location')).toBe('/sign-in');

	// With both reads available, a present row completes in one request.
	const otherSignOut = await harness.auth(signOutPath, {
		method: 'POST',
		headers: { cookie: otherCookie },
	});
	expect(otherSignOut.status).toBe(303);
	expect(otherSignOut.headers.get('location')).toBe('/sign-in');
	expect(
		otherSignOut.headers
			.getSetCookie()
			.some((cookie) => cookie.includes('session_token=') && /Max-Age=0/iu.test(cookie)),
	).toBe(true);
	expect(
		await harness.database.select({ id: session.id }).from(session).where(eq(session.id, other.id)),
	).toEqual([]);
	expect(await facts()).toEqual({ present: false, revision: before.revision + 2 });
}
