import { createSignInHttpHandler } from '@agent-collaboration/sign-in-core/better-auth';
import { expect, it } from 'vitest';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { signInPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';
import { allSignInRowFingerprints } from '#sign-in-test-support/test-fixtures/stored-row-fingerprints';

useControlledSignInClock();

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

/** The one continuation the owner CLI may resume: its fixed client, loopback callback and scope. */
function ownerCliAuthorization(
	harness: Harness,
	overrides: Readonly<Record<string, string>> = {},
): string {
	const authorization = new URL('/api/auth/oauth2/authorize', harness.issuer);
	authorization.search = new URLSearchParams({
		client_id: harness.target.ownerCliClientId,
		redirect_uri: harness.target.ownerCliRedirectUri,
		response_type: 'code',
		scope: 'tool-portal:management',
		resource: harness.target.managementAudience,
		code_challenge_method: 'S256',
		code_challenge: 'owner-resume-regression',
		...overrides,
	}).toString();
	return authorization.toString();
}

function refusedContinuations(harness: Harness): readonly string[] {
	return [
		'not an authorization address',
		ownerCliAuthorization(harness, { client_id: 'another-client' }),
		ownerCliAuthorization(harness, { redirect_uri: 'https://elsewhere.example.invalid/callback' }),
	];
}

/** Both handler call sites: the owner pages, and a factor POST before any native factor mutation. */
function requestsWith(continuation: string): readonly [string, RequestInit][] {
	const authorize = new URLSearchParams({ authorize: continuation }).toString();
	return [
		[`/sign-in?${authorize}`, {}],
		[`/owner-ready?${authorize}`, {}],
		[
			`/api/auth/two-factor/enable?${authorize}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'text/html' },
				body: '{}',
			},
		],
	];
}

it('refuses a malformed owner CLI continuation with the generic 400 before any effect', async () => {
	// Arrange: signed in, so each page and factor route would otherwise read and mutate state.
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const before = await allSignInRowFingerprints(harness);
		const requests = [
			...refusedContinuations(harness).flatMap(requestsWith),
			// The page also derives a continuation from a bare authorization query.
			[`/sign-in?client_id=another-client`, {}] as const,
		];
		// Act
		const observed: unknown[] = [];
		for (const [pathname, init] of requests) {
			const response = await harness.auth(pathname, init);
			observed.push({
				pathname,
				status: response.status,
				body: await response.json(),
				cacheControl: response.headers.get('cache-control'),
				setCookie: response.headers.has('set-cookie'),
			});
		}
		// Assert: the handler's generic input refusal (`fleet-admin-forwarding.ts`).
		expect(observed).toEqual(
			requests.map(([pathname]) => ({
				pathname,
				status: 400,
				body: { error: 'invalid-request' },
				cacheControl: 'no-store',
				setCookie: false,
			})),
		);
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

it('still resumes a valid owner CLI continuation at both call sites', async () => {
	// Arrange
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const continuation = ownerCliAuthorization(harness);
		const carried = new URLSearchParams({ authorize: continuation }).toString();
		// Act
		const responses = await Promise.all(
			requestsWith(continuation).map(([pathname, init]) => harness.auth(pathname, init)),
		);
		// Assert: each page or factor response carries the validated continuation onward.
		for (const response of responses) {
			expect(response.status).not.toBe(400);
			expect(response.status).toBeLessThan(500);
			expect(await response.text()).toContain(carried);
		}
	} finally {
		await harness.close();
	}
});

function fleetCliAuthorization(harness: Harness): URL {
	const authorization = new URL('/api/auth/oauth2/authorize', harness.issuer);
	const redirect = new URL(harness.target.ownerCliRedirectUri);
	const { ownerFleetCliClientId, centralAdminAudience } = harness.target;
	if (ownerFleetCliClientId === undefined || centralAdminAudience === undefined)
		throw new Error('The host fixture has no Fleet authorization profile');
	redirect.port = '49152';
	authorization.search = new URLSearchParams({
		client_id: ownerFleetCliClientId,
		response_type: 'code',
		redirect_uri: redirect.toString(),
		scope: 'fleet:admin offline_access',
		resource: centralAdminAudience,
		code_challenge: 'b'.repeat(43),
		code_challenge_method: 'S256',
		state: 's'.repeat(43),
	}).toString();
	return authorization;
}

interface InvalidFleetRequest {
	readonly reason: string;
	readonly requests: readonly [string, RequestInit][];
}

function invalidFleetRequests(harness: Harness): readonly InvalidFleetRequest[] {
	const valid = fleetCliAuthorization(harness);
	const callback = new URL(harness.target.ownerCliRedirectUri);
	const changes = [
		['wrong client', 'client_id', 'unregistered-client'],
		['wrong response type', 'response_type', 'token'],
		['mixed management scope', 'scope', 'tool-portal:management'],
		['wrong scope order', 'scope', 'offline_access fleet:admin'],
		['wrong resource', 'resource', harness.target.managementAudience],
		['wrong S256 method', 'code_challenge_method', 'plain'],
		['empty challenge', 'code_challenge', ''],
		['empty state', 'state', ''],
		['behavior-changing prompt', 'prompt', 'none'],
		['response-mode override', 'response_mode', 'form_post'],
		['HTTPS callback', 'redirect_uri', `https://${callback.host}${callback.pathname}`],
		['non-loopback callback', 'redirect_uri', 'http://remote.example.invalid/callback'],
		['wrong loopback host', 'redirect_uri', `http://localhost${callback.pathname}`],
		['wrong callback path', 'redirect_uri', `${callback.origin}/another-callback`],
		['wrong callback query', 'redirect_uri', `${callback.origin}${callback.pathname}?extra=1`],
		['normalized callback path', 'redirect_uri', `${callback.origin}/extra/..${callback.pathname}`],
		[
			'callback user information',
			'redirect_uri',
			`http://user@${callback.host}${callback.pathname}`,
		],
		['empty callback fragment', 'redirect_uri', `${callback.toString()}#`],
		['callback fragment', 'redirect_uri', `${callback.toString()}#ignored`],
	] as const;
	const invalid = changes.map(([reason, field, value]): InvalidFleetRequest => {
		const authorization = new URL(valid);
		authorization.searchParams.set(field, value);
		return { reason, requests: requestsWith(authorization.toString()) };
	});
	for (const field of ['resource', 'state', 'code_challenge']) {
		const authorization = new URL(valid);
		authorization.searchParams.delete(field);
		invalid.push({ reason: `missing ${field}`, requests: requestsWith(authorization.toString()) });
	}
	for (const [field, value] of valid.searchParams) {
		const authorization = new URL(valid);
		authorization.searchParams.append(field, value);
		invalid.push({ reason: `repeated ${field}`, requests: requestsWith(authorization.toString()) });
	}
	const wrongAuthorizePath = new URL(valid);
	wrongAuthorizePath.pathname = '/unexpected';
	const authorizeUserInfo = new URL(valid);
	authorizeUserInfo.username = 'user';
	invalid.push(
		{
			reason: 'wrong authorize origin',
			requests: requestsWith(`https://elsewhere.example.invalid${valid.pathname}${valid.search}`),
		},
		{ reason: 'wrong authorize path', requests: requestsWith(wrongAuthorizePath.toString()) },
		{ reason: 'authorize user information', requests: requestsWith(authorizeUserInfo.toString()) },
		{ reason: 'authorize fragment', requests: requestsWith(`${valid.toString()}#`) },
	);
	const management = ownerCliAuthorization(harness);
	for (const [reason, other] of [
		['a flat continuation with a nested Fleet continuation', `&${valid.searchParams}`],
		['a device code with a Fleet continuation', '&device=ABCD-EFGH'],
		['a repeated nested continuation', `&${new URLSearchParams({ authorize: management })}`],
	] as const)
		invalid.push({
			reason,
			requests: requestsWith(valid.toString()).map(([path, init]) => [`${path}${other}`, init]),
		});
	invalid.push({
		reason: 'a Fleet continuation hidden behind a management continuation',
		requests: requestsWith(management).map(([path, init]) => [
			`${path}&${new URLSearchParams({ authorize: valid.toString() })}`,
			init,
		]),
	});
	return invalid;
}

it('rejects malformed Fleet continuations on both owner pages and before native factor handling', async () => {
	const harness = await startLocalAuthHarness();
	try {
		await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
		const before = await allSignInRowFingerprints(harness);
		await invalidFleetRequests(harness).reduce(async (previous, { reason, requests }) => {
			await previous;
			await Promise.all(
				requests.map(async ([pathname, init]): Promise<void> => {
					const response = await harness.auth(pathname, init);
					expect(response.status, reason).toBe(400);
					expect(await response.json(), reason).toEqual({ error: 'invalid-request' });
					expect(response.headers.get('cache-control')).toBe('no-store');
					expect(response.headers.has('set-cookie')).toBe(false);
				}),
			);
		}, Promise.resolve());
		expect(await allSignInRowFingerprints(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});

it.skipIf(process.env.SIGN_IN_TEST_HOST !== 'node')(
	'Fleet continuation validation runs before any session database open',
	async () => {
		const harness = await startLocalAuthHarness();
		try {
			await signInPeopleBrowser({ harness, email: 'owner@example.invalid' });
			const configuration = harness.providerConfiguration;
			if (configuration === undefined) throw new Error('Node Sign-in configuration is unavailable');
			let opens = 0;
			const handle = createSignInHttpHandler({
				...configuration,
				openDatabase: () => {
					opens += 1;
					return configuration.openDatabase();
				},
			});
			function request(path: string, init: RequestInit): Request {
				const headers = new Headers(init.headers);
				headers.set('cookie', harness.cookie());
				headers.set('origin', harness.issuer);
				return new Request(new URL(path, harness.issuer), { ...init, headers });
			}
			const results = await Promise.all(
				invalidFleetRequests(harness).flatMap(({ requests }) =>
					requests.map(([path, init]) => handle(request(path, init))),
				),
			);
			expect(results.every((response) => response.status === 400)).toBe(true);
			expect(opens).toBe(0);
			const validReady = new URL('/owner-ready', harness.issuer);
			validReady.searchParams.set('authorize', fleetCliAuthorization(harness).toString());
			expect((await handle(request(validReady.toString(), {}))).status).toBe(200);
			expect(opens).toBeGreaterThan(0);
		} finally {
			await harness.close();
		}
	},
);
