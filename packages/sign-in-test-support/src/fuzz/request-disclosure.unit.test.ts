import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
	assertDocumentedErrorBody,
	assertGenericRefusalBody,
	assertRequestDisclosure,
	observeRequestAnswer,
	type ObservedRequestAnswer,
} from '#sign-in-test-support/fuzz/request-disclosure';
import type { GeneratedRequest } from '#sign-in-test-support/fuzz/request-families/index';
import type { RequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';
import {
	documentedAnswersFor,
	routeClassification,
	supportedSocialProviders,
	type RouteClassification,
} from '#sign-in-test-support/fuzz/route-classification';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

type DisclosureFixture = Parameters<typeof assertRequestDisclosure>[0]['fixture'];
const personId = '019a3dce-2000-7000-8000-000000000001';
const sessionId = '019a3dce-2000-7000-8000-000000000002';
const foreignId = '019a3dce-2000-7000-8000-000000000003';
const fixture: DisclosureFixture = {
	caller: 'owner',
	sessionId,
	forbiddenIdentities: [],
	foreignIdentities: [foreignId],
	cookie: 'better-auth.session_token=session-secret.signature; other=1',
	invitedPersonId: personId,
	invitedOrganizationId: '019a3dce-2000-7000-8000-000000000006',
	issuedCredentials: ['issued-secret'],
	context: {
		issuer: 'https://issuer.example.invalid',
		personId,
		oauthCode: 'fixture-code',
		oauthCodeVerifier: 'fixture-verifier',
		oauthClientId: 'fixture-client',
		oauthResource: 'https://resource.example.invalid',
		oauthRedirectUri: 'http://127.0.0.1:49152/callback',
		invitationId: '019a3dce-2000-7000-8000-000000000004',
	},
};
const before: RequestStorageSnapshot = {
	session: [{ id: sessionId, userId: personId, token: 'session-secret' }],
	account: [
		{ accessToken: 'access-secret', refreshToken: 'refresh-secret', clientSecret: 'client-secret' },
	],
};
const request: GeneratedRequest = {
	pathname: '/api/auth/get-session',
	init: { method: 'GET' },
	label: 'valid',
	variant: { encoding: 'json', field: null, mutation: 'valid' },
	expectation: 'success-or-refusal',
};
function answer(body: unknown, status = 403, headers = new Headers()): ObservedRequestAnswer {
	return { status, headers, body, text: JSON.stringify(body), bodyKind: 'json' };
}
function check(
	response: ObservedRequestAnswer,
	options: {
		readonly callerFixture?: DisclosureFixture;
		readonly path?: string;
		readonly input?: GeneratedRequest;
	} = {},
): void {
	assertRequestDisclosure({
		fixture: options.callerFixture ?? fixture,
		path: options.path ?? request.pathname,
		request: options.input ?? request,
		answer: response,
		before,
		after: before,
	});
}

it('rejects stored or issued credentials in refusal bodies and headers', (): void => {
	for (const credential of [
		'session-secret',
		'access-secret',
		'refresh-secret',
		'client-secret',
		'issued-secret',
	]) {
		expect(() => check(answer({ message: credential }))).toThrow('credential-disclosure');
		expect(() =>
			check(answer({ message: 'refused' }, 403, new Headers({ 'x-result': credential }))),
		).toThrow('credential-disclosure');
	}
	for (const key of ['sessionToken', 'access_token', 'refresh_token', 'client_secret']) {
		expect(() => check(answer({ nested: { [key]: 'new-credential' } }))).toThrow();
	}
});

it('allows the caller identity but rejects a foreign identity in body or headers', (): void => {
	expect(() => check(answer({ id: personId }, 200))).not.toThrow();
	expect(() => check(answer({ id: foreignId }, 200))).toThrow('identity-disclosure');
	expect(() => check(answer({}, 200, new Headers({ 'x-identity': foreignId })))).toThrow(
		'identity-disclosure',
	);
});

it('permits cookie deletion on refusal but rejects issuance', (): void => {
	expect(() =>
		check(answer({}, 403, new Headers({ 'set-cookie': 'auth.session_token=; Max-Age=0; Path=/' }))),
	).not.toThrow();
	expect(() =>
		check(answer({}, 403, new Headers({ 'set-cookie': 'auth.session_token=new-cookie; Path=/' }))),
	).toThrow('refusal issues a cookie');
});

it('accepts only the entitled token input and matching declared claims', async (): Promise<void> => {
	const token = await new SignJWT({ sid: sessionId, client_id: fixture.context.oauthClientId })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(fixture.context.issuer)
		.setSubject(personId)
		.setAudience(fixture.context.oauthResource)
		.setIssuedAt(100)
		.setExpirationTime(300)
		.sign(new TextEncoder().encode('synthetic-test-key-only-32-bytes'));
	const form = new URLSearchParams({
		grant_type: 'authorization_code',
		client_id: fixture.context.oauthClientId,
		code: fixture.context.oauthCode,
		code_verifier: fixture.context.oauthCodeVerifier,
		redirect_uri: fixture.context.oauthRedirectUri,
		resource: fixture.context.oauthResource,
	});
	const tokenRequest: GeneratedRequest = {
		pathname: '/api/auth/oauth2/token',
		init: { method: 'POST', body: form.toString() },
		label: 'valid',
		variant: { encoding: 'json', field: null, mutation: 'valid' },
		expectation: 'success-or-refusal',
	};
	const response = answer({ access_token: token }, 200);
	expect(() => check(response, { path: tokenRequest.pathname, input: tokenRequest })).not.toThrow();
	expect(() =>
		check(response, {
			path: tokenRequest.pathname,
			input: tokenRequest,
			callerFixture: { ...fixture, caller: 'member' },
		}),
	).toThrow('outside caller entitlement');
	expect(() =>
		check(response, {
			path: tokenRequest.pathname,
			input: tokenRequest,
			callerFixture: { ...fixture, caller: 'signed-out' },
		}),
	).toThrow('outside caller entitlement');
	expect(() =>
		check(response, {
			path: tokenRequest.pathname,
			input: tokenRequest,
			callerFixture: {
				...fixture,
				context: { ...fixture.context, oauthCode: 'unissued-fixture-code' },
			},
		}),
	).toThrow('outside caller entitlement');
	form.set('code_verifier', 'wrong-verifier');
	expect(() =>
		check(response, {
			path: tokenRequest.pathname,
			input: { ...tokenRequest, init: { method: 'POST', body: form.toString() } },
		}),
	).toThrow('outside input entitlement');
	const foreignToken = await new SignJWT({
		sid: sessionId,
		client_id: fixture.context.oauthClientId,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(fixture.context.issuer)
		.setSubject(foreignId)
		.setAudience(fixture.context.oauthResource)
		.setIssuedAt(100)
		.setExpirationTime(300)
		.sign(new TextEncoder().encode('synthetic-test-key-only-32-bytes'));
	expect(() =>
		check(answer({ access_token: foreignToken }, 200), {
			path: tokenRequest.pathname,
			input: tokenRequest,
		}),
	).toThrow();
});

const setActivePath = '/api/auth/organization/set-active';
const nativeSessionCookie = (value: string): Headers =>
	new Headers({ 'set-cookie': `better-auth.session_token=${value}; Path=/; HttpOnly` });
const liveSession = {
	id: sessionId,
	userId: personId,
	token: 'session-secret',
	expiresAt: controlledSignInClock.now() + 60_000,
};

function checkSetActive(props: {
	readonly cookieValue: string;
	readonly status?: number;
	readonly before?: RequestStorageSnapshot;
	readonly after?: RequestStorageSnapshot;
	readonly path?: string;
}): void {
	const snapshot: RequestStorageSnapshot = { session: [liveSession] };
	assertRequestDisclosure({
		fixture,
		path: props.path ?? setActivePath,
		request,
		answer: answer(
			{ name: 'Organization' },
			props.status ?? 200,
			nativeSessionCookie(props.cookieValue),
		),
		before: props.before ?? snapshot,
		after: props.after ?? snapshot,
	});
}

it('permits the set-active cookie only as the caller’s own live session re-issued with its submitted signature', (): void => {
	expect(() => checkSetActive({ cookieValue: 'session-secret.signature' })).not.toThrow();
	const expectsRefusal = 'session cookie outside native issuance contract';
	// The same person's OTHER session: another row, another token, and the fixture's session still present.
	const otherSession = {
		id: '019a3dce-2000-7000-8000-000000000007',
		userId: personId,
		token: 'other-secret',
		expiresAt: liveSession.expiresAt,
	};
	const withOther: RequestStorageSnapshot = { session: [liveSession, otherSession] };
	expect(() =>
		checkSetActive({ cookieValue: 'other-secret.signature', before: withOther, after: withOther }),
	).toThrow(expectsRefusal);
	// An expired row, even with the right token and signature.
	const expired: RequestStorageSnapshot = {
		session: [{ ...liveSession, expiresAt: controlledSignInClock.now() - 1 }],
	};
	expect(() =>
		checkSetActive({ cookieValue: 'session-secret.signature', before: expired, after: expired }),
	).toThrow(expectsRefusal);
	// An unsigned cookie and a cookie with another signature.
	expect(() => checkSetActive({ cookieValue: 'session-secret' })).toThrow(expectsRefusal);
	expect(() => checkSetActive({ cookieValue: 'session-secret.' })).toThrow(expectsRefusal);
	expect(() => checkSetActive({ cookieValue: 'session-secret.forged-signature' })).toThrow(
		expectsRefusal,
	);
	// The token changed between the snapshots (a different session under the fixture's id).
	const rotated: RequestStorageSnapshot = {
		session: [{ ...liveSession, token: 'rotated-secret' }],
	};
	expect(() => checkSetActive({ cookieValue: 'rotated-secret.signature', after: rotated })).toThrow(
		expectsRefusal,
	);
	// Another person's session, another route, a refusal.
	const othersSession: RequestStorageSnapshot = {
		session: [{ ...liveSession, userId: foreignId }],
	};
	expect(() =>
		checkSetActive({
			cookieValue: 'session-secret.signature',
			before: othersSession,
			after: othersSession,
		}),
	).toThrow(expectsRefusal);
	expect(() =>
		checkSetActive({ cookieValue: 'session-secret.signature', path: '/api/auth/get-session' }),
	).toThrow(expectsRefusal);
	expect(() => checkSetActive({ cookieValue: 'session-secret.signature', status: 403 })).toThrow(
		'credential-disclosure',
	);
});

const acceptPath = '/api/auth/organization/accept-invitation';
const invitedOrganizationId = '019a3dce-2000-7000-8000-000000000005';
const invitationId = '019a3dce-2000-7000-8000-000000000004';
const acceptFixture: DisclosureFixture = { ...fixture, invitedOrganizationId };
const acceptRequest = (id = invitationId): GeneratedRequest => ({
	pathname: acceptPath,
	init: { method: 'POST', body: JSON.stringify({ invitationId: id }) },
	label: 'valid',
	variant: { encoding: 'json', field: null, mutation: 'valid' },
	expectation: 'success-or-refusal',
});
const pendingBefore: RequestStorageSnapshot = {
	invitation: [{ id: invitationId, organizationId: invitedOrganizationId, status: 'pending' }],
	member: [],
};
const acceptedAfter: RequestStorageSnapshot = {
	invitation: [{ id: invitationId, organizationId: invitedOrganizationId, status: 'accepted' }],
	member: [{ organizationId: invitedOrganizationId, userId: personId }],
};

function checkAccept(props: {
	readonly callerFixture?: DisclosureFixture;
	readonly request?: GeneratedRequest;
	readonly before?: RequestStorageSnapshot;
	readonly after?: RequestStorageSnapshot;
	readonly body?: unknown;
	readonly status?: number;
}): void {
	assertRequestDisclosure({
		fixture: {
			...(props.callerFixture ?? acceptFixture),
			foreignIdentities: [invitedOrganizationId, foreignId],
		},
		path: acceptPath,
		request: props.request ?? acceptRequest(),
		answer: answer(
			props.body ?? { invitation: { organizationId: invitedOrganizationId } },
			props.status ?? 200,
		),
		before: props.before ?? pendingBefore,
		after: props.after ?? acceptedAfter,
	});
}

it('entitles the invited organization only to the invitee whose submitted invitation was stored as accepted with a membership', (): void => {
	expect(() => checkAccept({})).not.toThrow();
	const leaks = 'identity-disclosure';
	// Wrong builds: another invitation submitted, a caller who is not the invitee, no stored
	// acceptance, no membership, an already-accepted or already-member before-state, a refusal,
	// and the inviter or another organization in an otherwise entitled answer.
	expect(() =>
		checkAccept({ request: acceptRequest('019a3dce-2000-7000-8000-0000000000aa') }),
	).toThrow(leaks);
	expect(() =>
		checkAccept({ callerFixture: { ...acceptFixture, invitedPersonId: foreignId } }),
	).toThrow(leaks);
	expect(() => checkAccept({ after: pendingBefore })).toThrow(leaks);
	expect(() => checkAccept({ after: { ...acceptedAfter, member: [] } })).toThrow(leaks);
	expect(() =>
		checkAccept({
			after: { ...acceptedAfter, member: [{ organizationId: foreignId, userId: personId }] },
		}),
	).toThrow(leaks);
	expect(() => checkAccept({ before: acceptedAfter })).toThrow(leaks);
	expect(() => checkAccept({ status: 403 })).toThrow(leaks);
	expect(() => checkAccept({ body: { invitation: { organizationId: foreignId } } })).toThrow(leaks);
	expect(() =>
		checkAccept({
			callerFixture: { ...acceptFixture, forbiddenIdentities: ['inviter-person-id'] },
			body: {
				invitation: { organizationId: invitedOrganizationId, inviterId: 'inviter-person-id' },
			},
		}),
	).toThrow(leaks);
});

it('parses an empty refusal or redirect but not an empty success that claims JSON', async (): Promise<void> => {
	const json = { 'content-type': 'application/json' };
	await expect(
		observeRequestAnswer(new Response('', { status: 401, headers: json })),
	).resolves.toMatchObject({ status: 401, body: null });
	await expect(
		observeRequestAnswer(new Response('', { status: 302, headers: { ...json, location: '/x' } })),
	).resolves.toMatchObject({ status: 302, body: null });
	await expect(
		observeRequestAnswer(new Response('', { status: 200, headers: json })),
	).rejects.toThrow('malformed');
	await expect(
		observeRequestAnswer(new Response('<html>', { status: 401, headers: json })),
	).rejects.toThrow('malformed');
});

describe('documented error answers', (): void => {
	const documentedErrorBodies = {
		404: {
			values: { code: 'PROVIDER_NOT_FOUND' },
			exactKeys: ['code', 'message'],
			whenRequest: { jsonStringField: 'provider', notOneOf: supportedSocialProviders },
		},
		409: {
			values: { kind: 'refused' },
			exactKeys: ['kind', 'reason'],
			callers: ['member', 'owner'],
		},
	} as const;
	/** What the generator's own mutations of the provider field actually send. */
	const jsonRequest = (fields: Record<string, unknown>): GeneratedRequest => ({
		pathname: '/api/auth/sign-in/social',
		init: {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(fields),
		},
		label: 'request',
		variant: { encoding: 'json', field: null, mutation: 'valid' },
		expectation: 'success-or-refusal',
	});
	const unknownProviderRequest = jsonRequest({ provider: 'no-such-provider', callbackURL: '/x' });
	const documented = (props: {
		readonly status: number;
		readonly body: unknown;
		readonly caller?: 'signed-out' | 'member' | 'owner';
		readonly request?: GeneratedRequest;
	}): void =>
		assertDocumentedErrorBody({
			documentedErrorBodies,
			answer: { status: props.status, body: props.body },
			caller: props.caller ?? 'owner',
			request: props.request ?? unknownProviderRequest,
		});

	it('accepts the native answer for its caller and input, and nothing else', (): void => {
		const notFound = { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' };
		expect(() => documented({ status: 404, body: notFound })).not.toThrow();
		// The generator's other string mutations of the provider (an empty or an oversized value) are unknown providers too.
		for (const provider of ['', 'x'.repeat(4096), 'invalid'])
			expect(() =>
				documented({ status: 404, body: notFound, request: jsonRequest({ provider }) }),
			).not.toThrow();
		expect(() =>
			documented({ status: 409, body: { kind: 'refused', reason: 'stale' } }),
		).not.toThrow();
		// Wrong answers: another code, an extra field, a missing field, no body, the right body for a
		// request that did not change the documented input (valid, another field, no field), and for
		// another caller.
		expect(() =>
			documented({ status: 404, body: { code: 'SOMETHING_ELSE', message: 'x' } }),
		).toThrow('another error body');
		expect(() => documented({ status: 404, body: { ...notFound, detail: 'extra' } })).toThrow(
			'instead of exactly',
		);
		expect(() => documented({ status: 404, body: { code: 'PROVIDER_NOT_FOUND' } })).toThrow(
			'instead of exactly',
		);
		expect(() => documented({ status: 404, body: null })).toThrow('no documented error body');
		// Requests that did not send an unknown provider value: a supported one, null (the generator's
		// wrong-type), a number, an absent field, another field, and a non-JSON encoding.
		const form = {
			...jsonRequest({}),
			init: {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'provider=no-such-provider',
			},
		};
		for (const request of [
			jsonRequest({ provider: 'google' }),
			jsonRequest({ provider: 'github' }),
			jsonRequest({ provider: null }),
			jsonRequest({ provider: 7 }),
			jsonRequest({ callbackURL: '/x' }),
			jsonRequest({ other: 'no-such-provider' }),
			form,
		])
			expect(() => documented({ status: 404, body: notFound, request })).toThrow(
				'did not send its documented input',
			);
		expect(() =>
			documented({ status: 409, body: { kind: 'refused', reason: 'stale' }, caller: 'signed-out' }),
		).toThrow('not documented for the signed-out caller');
		expect(() =>
			documented({ status: 409, body: { kind: 'refused', reason: 'stale', extra: 1 } }),
		).toThrow('instead of exactly');
		expect(() => documented({ status: 400, body: { anything: true } })).not.toThrow();
	});

	const refusal = (
		status: number,
		body: unknown,
	): Parameters<typeof assertGenericRefusalBody>[0] => ({
		status,
		headers: new Headers(),
		body,
		bodyKind: body === null ? 'empty' : 'json',
	});

	it('requires a refusal body to be a generic error', (): void => {
		expect(() => assertGenericRefusalBody(refusal(403, { kind: 'refused' }))).not.toThrow();
		expect(() => assertGenericRefusalBody(refusal(401, null))).not.toThrow();
		expect(() =>
			assertGenericRefusalBody(refusal(400, { error: 'invalid_request', error_description: 'x' })),
		).not.toThrow();
		expect(() => assertGenericRefusalBody(refusal(200, { people: [] }))).not.toThrow();
		// A refusal that carries data (or a nested value) is not generic.
		expect(() =>
			assertGenericRefusalBody(refusal(403, { kind: 'refused', people: [{ id: 'x' }] })),
		).toThrow('beyond a generic error');
		expect(() => assertGenericRefusalBody(refusal(400, { message: { nested: true } }))).toThrow(
			'beyond a generic error',
		);
		expect(() => assertGenericRefusalBody(refusal(400, ['list']))).toThrow(
			'not a generic error object',
		);
	});
});

describe('per-caller answers', (): void => {
	it('refuses a member the owner People reads and the People page, and still allows the owner', (): void => {
		const row = (path: string): RouteClassification => {
			const found = routeClassification.find((candidate) => candidate.path === path);
			if (found === undefined) throw new Error(`${path} not classified`);
			return found;
		};
		for (const path of [
			'/api/auth/organization/people-list',
			'/api/auth/organization/people',
			'/api/auth/organization/person-membership',
			'/people',
		]) {
			expect(documentedAnswersFor(row(path), 'member'), path).not.toContain(200);
			expect(documentedAnswersFor(row(path), 'owner'), path).toContain(200);
		}
		// A route without its own list gives every caller the route-wide answers.
		expect(documentedAnswersFor(row('/me'), 'member')).toContain(200);
	});
});

it('set-active: the incoming session row must already be the caller’s own live one; a request cannot revive or hand over an expired or foreign row', (): void => {
	const expectsRefusal = 'session cookie outside native issuance contract';
	const now = controlledSignInClock.now();
	// A wrong set-active: it accepts an expired incoming session, extends that row's expiry and
	// re-issues its existing cookie. Before: expired. After: live again.
	expect(() =>
		checkSetActive({
			cookieValue: 'session-secret.signature',
			before: { session: [{ ...liveSession, expiresAt: now - 1 }] },
			after: { session: [{ ...liveSession, expiresAt: now + 60_000 }] },
		}),
	).toThrow(expectsRefusal);
	// A wrong set-active that hands the incoming row of another person to the caller.
	expect(() =>
		checkSetActive({
			cookieValue: 'session-secret.signature',
			before: { session: [{ ...liveSession, userId: foreignId }] },
			after: { session: [{ ...liveSession }] },
		}),
	).toThrow(expectsRefusal);
	// The positive same-session re-issue (live before and after) still passes.
	expect(() => checkSetActive({ cookieValue: 'session-secret.signature' })).not.toThrow();
});

describe('S2 closure: the documented refusals are bound to the actual input and body', (): void => {
	const unknownProvider404 = { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' };
	const socialErrorBodies = {
		404: {
			values: { code: 'PROVIDER_NOT_FOUND' },
			exactKeys: ['code', 'message'],
			whenRequest: { jsonStringField: 'provider', notOneOf: supportedSocialProviders },
		},
	} as const;
	const socialRequest = (provider: unknown): GeneratedRequest => ({
		pathname: '/api/auth/sign-in/social',
		init: {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			// What the generator's wrong-type mutation sends is null; its tag is not the input.
			body: JSON.stringify({ provider }),
		},
		label: 'wrong-type:provider',
		variant: { encoding: 'json', field: 'provider', mutation: 'wrong-type' },
		expectation: 'success-or-refusal',
	});
	const documented404 = (request: GeneratedRequest): void =>
		assertDocumentedErrorBody({
			documentedErrorBodies: socialErrorBodies,
			answer: { status: 404, body: unknownProvider404 },
			caller: 'owner',
			request,
		});

	it('does not document the unknown-provider 404 for a provider set to null, even with the wrong-type tag', (): void => {
		expect(() => documented404(socialRequest(null))).toThrow('did not send its documented input');
		expect(() => documented404(socialRequest('no-such-provider'))).not.toThrow();
	});

	it('does not treat a nonempty non-JSON refusal body as empty, and keeps a documented HTML refusal', async (): Promise<void> => {
		const page = await observeRequestAnswer(
			new Response('<html><body>secret page content</body></html>', {
				status: 403,
				headers: { 'content-type': 'text/html' },
			}),
		);
		expect(page.bodyKind).toBe('other');
		expect(() => assertGenericRefusalBody(page)).toThrow('nonempty refusal body');
		// A route that documents an HTML refusal may send one; a non-HTML nonempty body never.
		expect(() => assertGenericRefusalBody(page, { htmlRefusalDocumented: true })).not.toThrow();
		const text = await observeRequestAnswer(
			new Response('plain secret text', { status: 403, headers: { 'content-type': 'text/plain' } }),
		);
		expect(() => assertGenericRefusalBody(text, { htmlRefusalDocumented: true })).toThrow(
			'nonempty refusal body',
		);
		// An empty refusal, labelled JSON or not, is still generic.
		const empty = await observeRequestAnswer(new Response('', { status: 403 }));
		expect(empty.bodyKind).toBe('empty');
		expect(() => assertGenericRefusalBody(empty)).not.toThrow();
	});
});

it('allows only the structured machine refusal the route and status document', async (): Promise<void> => {
	const notPermitted = await observeRequestAnswer(
		Response.json({ error: 'access_denied', reason: { kind: 'notPermitted' } }, { status: 403 }),
	);
	expect(() =>
		assertGenericRefusalBody(notPermitted, { deviceDecisionRefusal: 'deny' }),
	).not.toThrow();
	expect(() => assertGenericRefusalBody(notPermitted)).toThrow('beyond a generic error');
	const unknownWorkspace = await observeRequestAnswer(
		Response.json(
			{ error: 'access_denied', reason: { kind: 'unknownWorkspace' } },
			{ status: 403 },
		),
	);
	expect(() =>
		assertGenericRefusalBody(unknownWorkspace, { deviceDecisionRefusal: 'approve' }),
	).not.toThrow();
	expect(() =>
		assertGenericRefusalBody(unknownWorkspace, { deviceDecisionRefusal: 'deny' }),
	).toThrow('beyond a generic error');
	const unexpected = await observeRequestAnswer(
		Response.json(
			{ error: 'access_denied', reason: { kind: 'notPermitted', token: 'fixture-token' } },
			{ status: 403 },
		),
	);
	expect(() => assertGenericRefusalBody(unexpected, { deviceDecisionRefusal: 'approve' })).toThrow(
		'beyond a generic error',
	);
});
