import { SignJWT } from 'jose';
import { expect, it } from 'vitest';

import {
	assertDocumentedErrorBody,
	assertRequestDisclosure,
	observeRequestAnswer,
	type ObservedRequestAnswer,
} from '#sign-in-test-support/fuzz/request-disclosure';
import type { GeneratedRequest } from '#sign-in-test-support/fuzz/request-families/index';
import type { RequestStorageSnapshot } from '#sign-in-test-support/fuzz/request-storage-snapshot';

type DisclosureFixture = Parameters<typeof assertRequestDisclosure>[0]['fixture'];
const personId = '019a3dce-2000-7000-8000-000000000001';
const sessionId = '019a3dce-2000-7000-8000-000000000002';
const foreignId = '019a3dce-2000-7000-8000-000000000003';
const fixture: DisclosureFixture = {
	caller: 'owner',
	sessionId,
	forbiddenIdentities: [],
	foreignIdentities: [foreignId],
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
	expectation: 'success-or-refusal',
};
function answer(body: unknown, status = 403, headers = new Headers()): ObservedRequestAnswer {
	return { status, headers, body, text: JSON.stringify(body) };
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
const nativeSessionCookie = (token: string): Headers =>
	new Headers({ 'set-cookie': `better-auth.session_token=${token}.signature; Path=/; HttpOnly` });

it('permits the native set-active cookie only for the caller’s own live session on that route', (): void => {
	const body = { name: 'Organization' };
	expect(() =>
		check(answer(body, 200, nativeSessionCookie('session-secret')), { path: setActivePath }),
	).not.toThrow();
	// Wrong builds: an unknown token, another person's session, or the same cookie on another route.
	expect(() =>
		check(answer(body, 200, nativeSessionCookie('unissued-token')), { path: setActivePath }),
	).toThrow('session cookie outside native issuance contract');
	const othersSession: RequestStorageSnapshot = {
		session: [{ id: sessionId, userId: foreignId, token: 'session-secret' }],
	};
	expect(() =>
		assertRequestDisclosure({
			fixture,
			path: setActivePath,
			request,
			answer: answer(body, 200, nativeSessionCookie('session-secret')),
			before: othersSession,
			after: othersSession,
		}),
	).toThrow('session cookie outside native issuance contract');
	expect(() =>
		check(answer(body, 200, nativeSessionCookie('session-secret')), {
			path: '/api/auth/get-session',
		}),
	).toThrow('session cookie outside native issuance contract');
	expect(() =>
		check(answer(body, 403, nativeSessionCookie('session-secret')), { path: setActivePath }),
	).toThrow('credential-disclosure');
});

it('entitles the accepted invitation’s organization only on a successful accept', (): void => {
	const invitedOrganizationId = '019a3dce-2000-7000-8000-000000000005';
	const acceptFixture: DisclosureFixture = { ...fixture, invitedOrganizationId };
	const acceptPath = '/api/auth/organization/accept-invitation';
	expect(() =>
		check(answer({ invitation: { organizationId: invitedOrganizationId } }, 200), {
			callerFixture: acceptFixture,
			path: acceptPath,
		}),
	).not.toThrow();
	expect(() =>
		check(answer({ invitation: { organizationId: invitedOrganizationId } }, 403), {
			callerFixture: { ...acceptFixture, foreignIdentities: [invitedOrganizationId] },
			path: acceptPath,
		}),
	).toThrow('identity-disclosure');
	expect(() =>
		check(answer({ invitation: { organizationId: foreignId } }, 200), {
			callerFixture: acceptFixture,
			path: acceptPath,
		}),
	).toThrow('identity-disclosure');
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

it('documents a 404 or 5xx only with its native error body', (): void => {
	const documentedErrorBodies = {
		404: { code: 'PROVIDER_NOT_FOUND' },
		503: { kind: 'setting-up', reason: 'unavailable' },
	};
	const doc = (status: number, body: unknown): void =>
		assertDocumentedErrorBody({ documentedErrorBodies, answer: { status, body } });
	expect(() => doc(404, { code: 'PROVIDER_NOT_FOUND', message: 'x' })).not.toThrow();
	expect(() => doc(503, { kind: 'setting-up', reason: 'unavailable' })).not.toThrow();
	expect(() => doc(404, { code: 'SOMETHING_ELSE' })).toThrow('documented error body');
	expect(() => doc(404, null)).toThrow('documented error body');
	expect(() => doc(503, { kind: 'setting-up', reason: 'other' })).toThrow('documented error body');
	expect(() => doc(400, { anything: true })).not.toThrow();
});
