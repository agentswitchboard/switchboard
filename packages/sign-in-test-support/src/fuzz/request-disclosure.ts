import {
	machineTokenClaimsSchema,
	machineTokenResponseSchema,
} from '@agent-collaboration/sign-in-core/better-auth';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { z } from 'zod';

import { fuzzMachineLogin } from '#sign-in-test-support/fuzz/machine-login-fixture';
import type { RequestCaseFixture } from '#sign-in-test-support/fuzz/request-case-fixture';
import type {
	GeneratedRequest,
	RequestFamilyContext,
} from '#sign-in-test-support/fuzz/request-families/index';
import {
	rowsAdded,
	storedCredentials,
	type RequestStorageSnapshot,
} from '#sign-in-test-support/fuzz/request-storage-snapshot';
import type {
	RouteCaller,
	RouteClassification,
} from '#sign-in-test-support/fuzz/route-classification';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';

export interface ObservedRequestAnswer {
	readonly status: number;
	readonly headers: Headers;
	readonly text: string;
	readonly body: unknown;
	/** Empty, parsed JSON, or another (nonempty, unparsed) body such as an HTML page. */
	readonly bodyKind: 'empty' | 'json' | 'other';
}

export async function observeRequestAnswer(response: Response): Promise<ObservedRequestAnswer> {
	const text = await response.text();
	let body: unknown = null;
	// better-call labels a body-less APIError or redirect application/json with an empty body
	// (to-response.mjs:58–67), so an empty refusal or redirect carries no JSON to parse. An empty
	// success claiming JSON is still malformed.
	const bodyless = text === '' && response.status >= 300;
	if (!bodyless && response.headers.get('content-type')?.includes('json')) {
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error('S2 documented-answer: response claims JSON but is malformed');
		}
	}
	const bodyKind = text === '' ? 'empty' : body === null && !isJsonLiteral(text) ? 'other' : 'json';
	return { status: response.status, headers: response.headers, text, body, bodyKind };
}

function isJsonLiteral(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

function forbid(value: string, forbidden: readonly string[], property: string): void {
	if (forbidden.some((credential) => credential.length > 0 && value.includes(credential)))
		throw new Error(property);
}

function credentialFields(value: unknown, path = ''): readonly string[] {
	if (Array.isArray(value)) return value.flatMap((child) => credentialFields(child, path));
	const object = z.record(z.string(), z.unknown()).safeParse(value);
	if (!object.success) return [];
	const sensitive = new Set([
		'access_token',
		'accessToken',
		'refresh_token',
		'refreshToken',
		'id_token',
		'idToken',
		'client_secret',
		'clientSecret',
		'device_code',
		'deviceCode',
		'token',
		'password',
		'privateKey',
		'sessionToken',
	]);
	return Object.entries(object.data).flatMap(([key, child]) =>
		(sensitive.has(key) ? [`${path}/${key}`] : []).concat(
			credentialFields(child, `${path}/${key}`),
		),
	);
}

const deviceCodeRelease = z.strictObject({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.url(),
	verification_uri_complete: z.url(),
	expires_in: z.number().int().positive(),
	interval: z.number().int().positive(),
});

type MachineRefreshContext = Pick<
	RequestFamilyContext,
	'machineEnrollmentId' | 'machineId' | 'machineRefreshToken' | 'organizationId'
>;

export function isBoundMachineRefresh(
	context: Partial<MachineRefreshContext>,
	request: GeneratedRequest,
): boolean {
	const headers = new Headers(request.init.headers);
	if (
		request.pathname !== '/api/auth/oauth2/token' ||
		headers.get('content-type') !== 'application/x-www-form-urlencoded' ||
		headers.has('authorization') ||
		typeof request.init.body !== 'string' ||
		!context.machineRefreshToken
	)
		return false;
	const form = new URLSearchParams(request.init.body);
	return (
		Array.from(form).length === 3 &&
		form.get('grant_type') === 'refresh_token' &&
		form.get('client_id') === context.machineEnrollmentId &&
		form.get('refresh_token') === context.machineRefreshToken
	);
}

function redactedMachineRefresh(props: {
	readonly context: { readonly issuer: string } & Partial<MachineRefreshContext>;
	readonly request: GeneratedRequest;
	readonly answer: ObservedRequestAnswer;
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
}): string {
	const { context, request, answer, before, after } = props;
	if (!isBoundMachineRefresh(context, request))
		throw new Error('S2 credential-disclosure: machine refresh outside the input entitlement');
	const parsed = machineTokenResponseSchema.strict().safeParse(answer.body);
	if (!parsed.success) throw new Error('S2 credential-disclosure: unexpected machine token body');
	const { access_token, refresh_token, ...publicFields } = parsed.data;
	const claims = machineTokenClaimsSchema.safeParse(decodeJwt(access_token));
	if (
		!claims.success ||
		decodeProtectedHeader(access_token).typ !== 'at+jwt' ||
		claims.data.iss !== context.issuer ||
		claims.data.aud !== fuzzMachineLogin.machineAudience ||
		claims.data.client_id !== context.machineEnrollmentId ||
		claims.data.azp !== context.machineEnrollmentId ||
		claims.data.principal.machine_id !== context.machineId ||
		claims.data.principal.enrollment_id !== context.machineEnrollmentId ||
		claims.data.organization_id !== context.organizationId ||
		publicFields.machine_client_id !== context.machineEnrollmentId ||
		claims.data.exp <= claims.data.iat ||
		claims.data.exp - claims.data.iat > 3600 ||
		(claims.data.sid !== undefined && claims.data.sid !== null) ||
		Object.hasOwn(claims.data, 'workspace_id') ||
		refresh_token === context.machineRefreshToken ||
		answer.headers.has('set-cookie')
	)
		throw new Error('S2 credential-disclosure: machine refresh escaped its bound enrollment');
	const original = (before.oauthRefreshToken ?? []).filter(
		(row) =>
			row.clientId === context.machineEnrollmentId &&
			row.rotatedAt === null &&
			row.revoked === null,
	);
	const retained = (after.oauthRefreshToken ?? []).find((row) => row.id === original[0]?.id);
	const added = rowsAdded({
		before: before.oauthRefreshToken ?? [],
		after: after.oauthRefreshToken ?? [],
	});
	const replacesCredential = added.filter(
		(row) =>
			row.clientId === context.machineEnrollmentId &&
			row.rotatedAt === null &&
			row.revoked === null,
	);
	if (
		original.length !== 1 ||
		(retained !== undefined && retained.rotatedAt === null && retained.revoked === null) ||
		replacesCredential.length !== 1
	)
		throw new Error(
			'S2 refusal-effects: machine refresh did not replace its single live credential',
		);
	return JSON.stringify(publicFields);
}

function deviceIssuanceWithoutCredential(
	body: unknown,
	before: RequestStorageSnapshot,
	after: RequestStorageSnapshot,
): string {
	const parsed = deviceCodeRelease.safeParse(body);
	if (!parsed.success) throw new Error('S2 credential-disclosure: invalid device issuance body');
	const { device_code, ...verification } = parsed.data;
	const added = rowsAdded({ before: before.deviceCode ?? [], after: after.deviceCode ?? [] });
	if (
		added.length !== 1 ||
		added[0]?.deviceCode !== device_code ||
		added[0]?.userCode !== verification.user_code ||
		added[0]?.status !== 'pending' ||
		before.deviceCode?.some((row) => row.deviceCode === device_code)
	)
		throw new Error('S2 credential-disclosure: device code is outside the new issuance');
	return JSON.stringify(verification);
}

/** The decoded value of the session token cookie in a Cookie header, or null. */
function submittedSessionCookie(cookieHeader: string): string | null {
	for (const pair of cookieHeader.split('; ')) {
		const boundary = pair.indexOf('=');
		if (boundary > 0 && pair.slice(0, boundary).endsWith('session_token'))
			return decodeURIComponent(pair.slice(boundary + 1));
	}
	return null;
}

/**
 * The amended S2 exception for organization/set-active: the same session's cookie re-issued for the
 * caller's own live session (no new credential). The fixture's own session row, owned by the
 * caller and unexpired both before the request (the incoming row) and after it, with the same token; the re-issued value is exactly the
 * signed cookie the request submitted (a signature is deterministic), so an unsigned or
 * differently signed value, another session's token, or an expired session fails.
 */
function isOwnLiveSessionReissue(props: {
	readonly fixture: Pick<RequestCaseFixture, 'sessionId' | 'cookie'> & {
		readonly context: Pick<RequestFamilyContext, 'personId'>;
	};
	readonly value: string;
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
}): boolean {
	const { fixture, value } = props;
	const own = (props.after.session ?? []).find((row) => row.id === fixture.sessionId);
	const wasOwn = (props.before.session ?? []).find((row) => row.id === fixture.sessionId);
	const submitted = submittedSessionCookie(fixture.cookie);
	if (own === undefined || wasOwn === undefined || submitted === null) return false;
	if (typeof own.token !== 'string' || own.token.length === 0 || own.token !== wasOwn.token)
		return false;
	const now = controlledSignInClock.now();
	// The incoming row (before the request) must already be the caller's own and live: a request
	// that revives an expired row or takes over another person's row is not a re-issue.
	const incomingIsLive =
		wasOwn.userId === fixture.context.personId &&
		typeof wasOwn.expiresAt === 'number' &&
		wasOwn.expiresAt > now;
	return (
		incomingIsLive &&
		own.userId === fixture.context.personId &&
		typeof own.expiresAt === 'number' &&
		own.expiresAt > now &&
		value.startsWith(`${own.token}.`) &&
		value.length > own.token.length + 1 &&
		value === submitted
	);
}

/**
 * The accept-invitation exemption: the submitted invitation is the fixture's, the caller is its
 * invitee, and storage shows the acceptance (pending before, accepted after) and the caller's new
 * membership in that organization. The inviter and every other identity stay forbidden.
 */
function invitationWasAcceptedByItsInvitee(props: {
	readonly fixture: Pick<RequestCaseFixture, 'caller'> & {
		readonly invitedOrganizationId: string;
		readonly invitedPersonId: string;
		readonly context: Pick<RequestFamilyContext, 'personId' | 'invitationId'>;
	};
	readonly request: GeneratedRequest;
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
}): boolean {
	const { fixture } = props;
	const body = z
		.object({ invitationId: z.string() })
		.safeParse(
			typeof props.request.init.body === 'string' ? safeJson(props.request.init.body) : null,
		);
	if (!body.success || body.data.invitationId !== fixture.context.invitationId) return false;
	if (fixture.context.personId !== fixture.invitedPersonId) return false;
	const wasPending = (props.before.invitation ?? []).some(
		(row) => row.id === fixture.context.invitationId && row.status === 'pending',
	);
	const nowAccepted = (props.after.invitation ?? []).some(
		(row) =>
			row.id === fixture.context.invitationId &&
			row.status === 'accepted' &&
			row.organizationId === fixture.invitedOrganizationId,
	);
	const isMember = (snapshot: RequestStorageSnapshot): boolean =>
		(snapshot.member ?? []).some(
			(row) =>
				row.organizationId === fixture.invitedOrganizationId &&
				row.userId === fixture.context.personId,
		);
	return wasPending && nowAccepted && !isMember(props.before) && isMember(props.after);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The entitlement comes from the input fixture and release contract, never from the returned status alone. */
export function assertRequestDisclosure(props: {
	readonly fixture: Pick<
		RequestCaseFixture,
		| 'caller'
		| 'sessionId'
		| 'cookie'
		| 'forbiddenIdentities'
		| 'foreignIdentities'
		| 'issuedCredentials'
	> & {
		readonly invitedOrganizationId: string;
		/** The person the pending invitation is for: the only caller that may learn its organization. */
		readonly invitedPersonId: string;
		readonly context: Pick<
			RequestFamilyContext,
			| 'issuer'
			| 'personId'
			| 'oauthCode'
			| 'oauthCodeVerifier'
			| 'oauthClientId'
			| 'oauthResource'
			| 'oauthRedirectUri'
			| 'invitationId'
		> &
			Partial<MachineRefreshContext>;
	};
	readonly path: string;
	readonly request: GeneratedRequest;
	readonly answer: ObservedRequestAnswer;
	readonly before: RequestStorageSnapshot;
	readonly after: RequestStorageSnapshot;
}): void {
	const { fixture, path, answer, before, after } = props;
	const refusal =
		answer.status >= 400 || (answer.headers.get('location')?.includes('error=') ?? false);
	const tokenSuccess = path === '/api/auth/oauth2/token' && answer.status === 200;
	const machineRefreshSuccess = tokenSuccess && props.request.variant.flow === 'machine-refresh';
	const deviceCodeSuccess = path === '/api/auth/device/code' && answer.status === 200;
	const credentials = [
		...storedCredentials(before),
		...storedCredentials(after),
		...fixture.issuedCredentials,
	];
	const releasedBody = machineRefreshSuccess
		? redactedMachineRefresh({
				context: fixture.context,
				request: props.request,
				answer,
				before,
				after,
			})
		: deviceCodeSuccess
			? deviceIssuanceWithoutCredential(answer.body, before, after)
			: answer.text;
	forbid(releasedBody, credentials, 'S2 credential-disclosure: body contains a stored credential');
	for (const [name, value] of answer.headers) {
		if (name !== 'set-cookie')
			forbid(value, credentials, 'S2 credential-disclosure: header contains a stored credential');
		if (name === 'authorization' && value !== '')
			throw new Error('S2 credential-disclosure: authorization response header');
	}
	if (refusal) {
		expectNoIssuedCredentials(answer.body);
		if (credentialFields(answer.body).length > 0)
			throw new Error('S2 credential-disclosure: credential field in refusal');
	} else {
		const fields = credentialFields(answer.body);
		const allowed = machineRefreshSuccess
			? ['/access_token', '/refresh_token']
			: tokenSuccess
				? ['/access_token']
				: deviceCodeSuccess
					? ['/device_code']
					: [];
		if (fields.some((field) => !allowed.includes(field)))
			throw new Error('S2 credential-disclosure: output outside route entitlement');
	}
	if (tokenSuccess && !machineRefreshSuccess) {
		if (fixture.caller !== 'owner' || fixture.context.oauthCode === 'unissued-fixture-code')
			throw new Error('S2 credential-disclosure: token issued outside caller entitlement');
		const input = new URLSearchParams(
			typeof props.request.init.body === 'string' ? props.request.init.body : '',
		);
		for (const [name, value] of Object.entries({
			grant_type: 'authorization_code',
			client_id: fixture.context.oauthClientId,
			code: fixture.context.oauthCode,
			code_verifier: fixture.context.oauthCodeVerifier,
			redirect_uri: fixture.context.oauthRedirectUri,
			resource: fixture.context.oauthResource,
		})) {
			if (input.getAll(name).length !== 1 || input.get(name) !== value)
				throw new Error(
					'S2 credential-disclosure: token issued for a request outside input entitlement',
				);
		}
		const token = z
			.object({ access_token: z.string().min(1), refresh_token: z.never().optional() })
			.parse(answer.body);
		const claims = z
			.object({
				iss: z.literal(fixture.context.issuer),
				sub: z.literal(fixture.context.personId),
				sid: z.literal(fixture.sessionId),
				aud: z.literal(fixture.context.oauthResource),
				client_id: z.literal(fixture.context.oauthClientId),
				iat: z.number(),
				exp: z.number(),
			})
			.parse(decodeJwt(token.access_token));
		if (claims.exp <= claims.iat || claims.exp - claims.iat > 300)
			throw new Error('S2 credential-disclosure: invalid token release lifetime');
	}
	const identityExceptions =
		path === '/api/auth/organization/accept-invitation' &&
		!refusal &&
		invitationWasAcceptedByItsInvitee({ fixture, request: props.request, before, after })
			? // Accepting makes the invited organization one of the caller's own memberships.
				[fixture.context.invitationId, fixture.invitedOrganizationId]
			: [];
	const forbiddenIdentities = [...fixture.forbiddenIdentities, ...fixture.foreignIdentities].filter(
		(identity) => !identityExceptions.includes(identity),
	);
	forbid(
		answer.text,
		forbiddenIdentities,
		'S2 identity-disclosure: body exceeds caller and organization entitlement',
	);
	for (const [, value] of answer.headers)
		forbid(value, forbiddenIdentities, 'S2 identity-disclosure: header exceeds caller entitlement');
	for (const cookie of answer.headers.getSetCookie()) {
		const pair = cookie.split(';')[0] ?? '';
		const boundary = pair.indexOf('=');
		const name = pair.slice(0, boundary);
		const value = decodeURIComponent(pair.slice(boundary + 1));
		const deletion = value === '' && /(?:max-age=0|expires=Thu, 01 Jan 1970)/iu.test(cookie);
		if (deletion) continue;
		if (refusal) throw new Error('S2 credential-disclosure: refusal issues a cookie');
		if (name.endsWith('session_token')) {
			const mayIssueSession =
				path.startsWith('/api/auth/callback/') || path === '/api/auth/two-factor/verify-totp';
			const session = (after.session ?? []).find(
				(row) => typeof row.token === 'string' && value.startsWith(`${row.token}.`),
			);
			const issuedByNativeFlow =
				mayIssueSession && session !== undefined && session.userId === fixture.context.personId;
			// Native set-active re-sets the same session's cookie (crud-org.mjs:403,429), and nothing else.
			const reissuedSameSession =
				path === '/api/auth/organization/set-active' &&
				isOwnLiveSessionReissue({ fixture, value, before, after });
			if (!issuedByNativeFlow && !reissuedSameSession)
				throw new Error(
					'S2 credential-disclosure: session cookie outside native issuance contract',
				);
		} else if (
			![
				'/api/auth/sign-in/social',
				'/api/auth/link-social',
				'/api/auth/passkey/generate-register-options',
				'/api/auth/passkey/verify-registration',
			].includes(path)
		) {
			throw new Error('S2 credential-disclosure: cookie outside route entitlement');
		}
	}
}

/** The request is a JSON body whose named string field holds a value outside the supported ones. */
function requestCausesNativeRefusal(
	request: GeneratedRequest,
	when: { readonly jsonStringField: string; readonly notOneOf: readonly string[] },
): boolean {
	const contentType = new Headers(request.init.headers).get('content-type') ?? '';
	if (!contentType.startsWith('application/json') || typeof request.init.body !== 'string')
		return false;
	const body = z.record(z.string(), z.unknown()).safeParse(safeJson(request.init.body));
	if (!body.success) return false;
	const value = body.data[when.jsonStringField];
	return typeof value === 'string' && !when.notOneOf.includes(value);
}

/**
 * A native error status (the unknown-provider 404, a refused 409) is documented only together with
 * its exact body, the callers it is for and the input that causes it. Any condition missing, an
 * extra body field, another caller or a request that did not change the named field fails.
 */
export function assertDocumentedErrorBody(props: {
	readonly documentedErrorBodies: RouteClassification['documentedErrorBodies'];
	readonly answer: Pick<ObservedRequestAnswer, 'status' | 'body'>;
	readonly caller: RouteCaller;
	readonly request: GeneratedRequest;
}): void {
	const documented = props.documentedErrorBodies?.[props.answer.status];
	if (documented === undefined) return;
	const refuse = (why: string): never => {
		throw new Error(`S2 documented-answer: status ${props.answer.status} ${why}`);
	};
	if (documented.callers !== undefined && !documented.callers.includes(props.caller))
		refuse(`is not documented for the ${props.caller} caller`);
	if (
		documented.whenRequest !== undefined &&
		!requestCausesNativeRefusal(props.request, documented.whenRequest)
	)
		refuse('is not documented for a request that did not send its documented input');
	const actual = z.record(z.string(), z.unknown()).safeParse(props.answer.body);
	if (!actual.success) return refuse('has no documented error body');
	if (Object.entries(documented.values).some(([field, value]) => actual.data[field] !== value))
		refuse('has another error body than its documented one');
	const keys = Object.keys(actual.data).toSorted();
	if (JSON.stringify(keys) !== JSON.stringify([...documented.exactKeys].toSorted()))
		refuse(
			`carries body fields ${keys.join(',')} instead of exactly ${documented.exactKeys.join(',')}`,
		);
}

/**
 * A refusal's body is generic: empty, or an object of these error-describing keys with plain values.
 * `error_description` is the OAuth error field (RFC 6749 section 5.2) of the token and introspection routes.
 */
const genericRefusalKeys = new Set([
	'error',
	'error_description',
	'message',
	'code',
	'kind',
	'reason',
	'status',
]);

const deviceDecisionError = z.strictObject({
	error: z.literal('access_denied'),
	reason: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('notPermitted') }),
		z.strictObject({ kind: z.literal('secondFactorRequired'), withinSeconds: z.literal(900) }),
		z.strictObject({ kind: z.literal('unknownWorkspace') }),
		z.strictObject({ kind: z.literal('machineInAnotherOrganization') }),
		z.strictObject({ kind: z.literal('requestConflict') }),
	]),
});

function isDocumentedDeviceDecisionError(
	answer: Pick<ObservedRequestAnswer, 'status' | 'body'>,
	action: 'approve' | 'deny',
): boolean {
	const parsed = deviceDecisionError.safeParse(answer.body);
	if (!parsed.success) return false;
	const reason = parsed.data.reason.kind;
	if (answer.status === 409) return action === 'approve' && reason === 'requestConflict';
	return (
		answer.status === 403 &&
		(reason === 'notPermitted' ||
			(action === 'approve' &&
				(reason === 'secondFactorRequired' ||
					reason === 'unknownWorkspace' ||
					reason === 'machineInAnotherOrganization')))
	);
}

export function assertGenericRefusalBody(
	answer: Pick<ObservedRequestAnswer, 'status' | 'body' | 'bodyKind' | 'headers'>,
	options: {
		readonly htmlRefusalDocumented?: boolean;
		readonly deviceDecisionRefusal?: 'approve' | 'deny';
	} = {},
): void {
	if (answer.status < 400 || answer.bodyKind === 'empty') return;
	// A nonempty body that is not JSON is a page, not a generic error: only a route that documents
	// an HTML refusal for that status may send one.
	if (answer.bodyKind === 'other') {
		if (
			options.htmlRefusalDocumented === true &&
			(answer.headers.get('content-type') ?? '').startsWith('text/html')
		)
			return;
		throw new Error('S2 documented-answer: a nonempty refusal body is not a generic error object');
	}
	if (
		options.deviceDecisionRefusal !== undefined &&
		isDocumentedDeviceDecisionError(answer, options.deviceDecisionRefusal)
	)
		return;
	const record = z.record(z.string(), z.unknown()).safeParse(answer.body);
	if (!record.success)
		throw new Error('S2 documented-answer: a refusal body is not a generic error object');
	for (const [key, value] of Object.entries(record.data))
		if (!genericRefusalKeys.has(key) || !['string', 'number', 'boolean'].includes(typeof value))
			throw new Error(
				`S2 documented-answer: a refusal body carries ${key}, beyond a generic error`,
			);
}
