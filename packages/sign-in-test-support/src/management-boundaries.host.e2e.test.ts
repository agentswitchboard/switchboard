import * as signInTables from '@agent-collaboration/sign-in-core';
import { eq } from 'drizzle-orm';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { expectNoIssuedCredentials } from '#sign-in-test-support/test-fixtures/credential-free-refusal';
import { readCurrentBrowserSession } from '#sign-in-test-support/test-fixtures/current-browser-session';
import { createObservedProofJwks } from '#sign-in-test-support/test-fixtures/jwks-fetch-observation';
import {
	agentAudience,
	managementAudience,
	organizationOne,
	registeredClientId,
	registrationRequestId,
	startLocalAuthHarness,
	workspaceOne,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	readManagementClientRows,
	readManagementAuditRows,
	requireManagementRefusalReadback,
} from '#sign-in-test-support/test-fixtures/management-refusal-readback';
import { installedProviderEndpointInventory } from '#sign-in-test-support/test-fixtures/provider-endpoint-inventory';
import { storedRowProjection } from '#sign-in-test-support/test-fixtures/stored-row-projection';

useControlledSignInClock();

let harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
beforeAll(async () => {
	harness = await startLocalAuthHarness();
});
afterAll(async () => {
	await harness?.close();
});

interface ManagementReadback {
	readonly protectedState: readonly unknown[];
	readonly auditRows: unknown;
}
async function protectedRows(): Promise<ManagementReadback> {
	const protectedState = await Promise.all([
		readManagementClientRows(harness.database),
		harness.database
			.select(storedRowProjection(signInTables.oauthClientResource))
			.from(signInTables.oauthClientResource)
			.orderBy(
				signInTables.oauthClientResource.clientId,
				signInTables.oauthClientResource.resourceId,
			)
			.then((result) => result),
		harness.database
			.select(storedRowProjection(signInTables.oauthResource))
			.from(signInTables.oauthResource)
			.orderBy(signInTables.oauthResource.identifier)
			.then((result) => result),
		harness.database
			.select(storedRowProjection(signInTables.oauthConsent))
			.from(signInTables.oauthConsent)
			.orderBy(signInTables.oauthConsent.id)
			.then((result) => result),
		harness
			.gateway(`/__auth-proof?workspace=${workspaceOne}&client=${registeredClientId}`)
			.then((response) => response.json()),
	]);
	const auditRows = await readManagementAuditRows(harness.database);
	return { protectedState, auditRows };
}

it('agent: every management boundary refuses real E10 and signed management no-sid identity before protected reads or effects', async () => {
	const owner = await harness.ownerToken();
	const person = z
		.object({ sub: z.string(), sid: z.string(), iat: z.number(), exp: z.number() })
		.parse(decodeJwt(owner));
	expect(person.exp - person.iat).toBeLessThanOrEqual(300);
	const endpoint = `/management/workspaces/${workspaceOne}/agents`;
	const registered = await harness.gateway(endpoint, {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' },
		body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
	});
	expect(registered.status).toBe(200);
	const client = z
		.object({ clientId: z.literal(registeredClientId), clientSecret: z.string() })
		.parse(await registered.json());
	const minted = await harness.auth('/api/auth/oauth2/token', {
		method: 'POST',
		headers: {
			authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'client_credentials',
			resource: agentAudience,
			scope: 'tool-portal:agent',
		}),
	});
	expect(minted.status).toBe(200);
	const agent = z.object({ access_token: z.string() }).parse(await minted.json()).access_token;
	const negative = await harness.auth('/api/auth/__proof/without-sid', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ subject: person.sub, clientId: person.sid }),
	});
	expect(negative.status).toBe(200);
	const withoutSid = z.object({ token: z.string() }).parse(await negative.json()).token;
	const checked = await jwtVerify(
		withoutSid,
		createObservedProofJwks(new URL('/api/auth/jwks', harness.issuer)),
		{ issuer: harness.issuer, audience: managementAudience },
	);
	expect(decodeProtectedHeader(withoutSid).typ).toBe('at+jwt');
	expect(Object.hasOwn(checked.payload, 'sid')).toBe(false);
	const before = await protectedRows();
	const storedCredentialHashes = z
		.array(z.object({ clientSecret: z.string().nullable() }))
		.parse(before.protectedState[0])
		.flatMap((row) => (row.clientSecret === null ? [] : [row.clientSecret]));
	async function requireUnchangedProtectedState(): Promise<void> {
		const after = await protectedRows();
		requireManagementRefusalReadback({
			beforeProtected: before.protectedState,
			afterProtected: after.protectedState,
			beforeAudit: before.auditRows,
			afterAudit: after.auditRows,
			attributableActors: [person.sub, client.clientId],
			forbiddenValues: [
				owner,
				agent,
				withoutSid,
				client.clientSecret,
				harness.cookie(),
				...storedCredentialHashes,
			],
		});
	}

	const binding = { SIGN_IN: await harness.signInManagement() };
	// This calls the real named RPC binding. No HTTP route or 404 can satisfy these oracles.
	expect(await binding.SIGN_IN.isLiveOwner({ token: owner, organizationId: organizationOne })).toBe(
		true,
	);
	await Promise.all(
		[agent, withoutSid].map(async (token) => {
			expect(await binding.SIGN_IN.isLiveOwner({ token, organizationId: organizationOne })).toBe(
				false,
			);
			expect(
				await binding.SIGN_IN.ownsAgentClient({
					token,
					organizationId: organizationOne,
					clientId: registeredClientId,
				}),
			).toBe(false);
			const refused = await Promise.all([
				binding.SIGN_IN.registerAndLink({
					token,
					workspaceId: workspaceOne,
					organizationId: organizationOne,
					requestId: controlledSignInIds.nextId(),
				}),
				binding.SIGN_IN.link({
					token,
					organizationId: organizationOne,
					workspaceId: workspaceOne,
					clientId: registeredClientId,
					requestId: controlledSignInIds.nextId(),
				}),
				binding.SIGN_IN.unlink({
					token,
					organizationId: organizationOne,
					workspaceId: workspaceOne,
					clientId: registeredClientId,
					requestId: controlledSignInIds.nextId(),
				}),
				binding.SIGN_IN.disable({
					token,
					organizationId: organizationOne,
					clientId: registeredClientId,
					requestId: controlledSignInIds.nextId(),
				}),
			]);
			expect(refused).toEqual([
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
				{ kind: 'refused', reason: 'not-owner' },
			]);
		}),
	);
	await requireUnchangedProtectedState();
	const gatewayResponses = await Promise.all(
		[agent, withoutSid].flatMap((token) => [
			harness.gateway(endpoint, {
				method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: registrationRequestId, persona: 'operator' }),
			}),
			harness.gateway(`${endpoint}/${registeredClientId}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
			harness.gateway(`${endpoint}/${registeredClientId}`, {
				method: 'DELETE',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ requestId: controlledSignInIds.nextId() }),
			}),
		]),
	);
	expect(gatewayResponses.map((response) => response.status)).toEqual([
		403, 403, 403, 403, 403, 403,
	]);
	const gatewayBodies: readonly unknown[] = await Promise.all(
		gatewayResponses.map((response: Response): Promise<unknown> => response.json()),
	);
	// Independent S1 contract: do not filter this inventory through the product's allowlist.
	const publicProviderPaths = new Set([
		'/api/auth/sign-in/social',
		'/api/auth/organization/create',
		'/api/auth/organization/invite-member',
		'/api/auth/organization/cancel-invitation',
		'/api/auth/organization/accept-invitation',
		'/api/auth/organization/remove-member',
		'/api/auth/organization/set-active',
		// Cookie-only setup retry (B2): probed below with a valid body and each bearer identity.
		'/api/auth/organization/retry-provisioning',
		'/api/auth/two-factor/enable',
		'/api/auth/two-factor/verify-totp',
		'/api/auth/two-factor/verify-backup-code',
		'/api/auth/two-factor/generate-backup-codes',
		'/api/auth/two-factor/remove-app',
		'/api/auth/passkey/generate-register-options',
		'/api/auth/passkey/list-user-passkeys',
		'/api/auth/passkey/verify-registration',
		'/api/auth/passkey/update-passkey',
		'/api/auth/passkey/remove',
		'/api/auth/passkey/confirm-options',
		'/api/auth/passkey/confirm',
		'/api/auth/link-social', // B3 opens only the audited redirect POST; other methods stay closed.
		'/api/auth/callback/google',
		'/api/auth/callback/github',
		'/api/auth/oauth2/authorize',
		'/api/auth/oauth2/token',
		'/api/auth/oauth2/introspect',
		'/api/auth/jwks',
		'/api/auth/.well-known/oauth-authorization-server',
		'/api/auth/.well-known/openid-configuration',
	]);
	const publicProviderMethods = new Set([
		// Owner decision (12 Nov): these cookie-bound page reads open only GET.
		'GET /api/auth/get-session',
		'GET /api/auth/list-accounts',
		// S1 opens exactly these passkey methods; every other method remains in the refusal matrix.
		'GET /api/auth/passkey/generate-authenticate-options',
		'POST /api/auth/passkey/verify-authentication',
	]);
	const { httpRoutes: installedRoutes, noHttpPathApis } = await installedProviderEndpointInventory(
		harness.miniflare,
		harness.providerConfiguration,
	);
	// Native addMember is pathless, not SERVER_ONLY: it is a server API with no URL route.
	expect(noHttpPathApis).toEqual([
		{ endpointName: 'addMember', serverOnly: false },
		{ endpointName: 'generateTOTP', serverOnly: true },
		// The stamp guard, WS7 recovery, key-change re-sign and signing run only through server
		// dispatch (no route).
		{ endpointName: 'prepareOrganizationFleetCall', serverOnly: true },
		{ endpointName: 'readShellSession', serverOnly: true },
		{ endpointName: 'recoverForgottenOrganization', serverOnly: true },
		{ endpointName: 'reSignOrganizationsForKeyChange', serverOnly: true },
		{ endpointName: 'setPassword', serverOnly: true },
		{ endpointName: 'signJWT', serverOnly: true },
		{ endpointName: 'signOrganizationStatement', serverOnly: true },
		{ endpointName: 'verifyJWT', serverOnly: true },
		{ endpointName: 'viewBackupCodes', serverOnly: true },
	]);
	expect(installedRoutes.length).toBeGreaterThan(0);
	for (const requiredPath of [
		'/api/auth/organization/leave',
		'/api/auth/organization/update-member-role',
		'/api/auth/organization/delete',
		'/api/auth/organization/list',
		'/api/auth/organization/get-full-organization',
		'/api/auth/organization/get-organization',
		'/api/auth/organization/list-members',
		'/api/auth/organization/list-invitations',
		'/api/auth/organization/get-invitation',
		'/api/auth/organization/list-user-invitations',
		'/api/auth/organization/get-active-member',
		'/api/auth/organization/get-active-member-role',
		'/api/auth/get-session',
		'/api/auth/list-sessions',
		'/api/auth/list-accounts',
		'/api/auth/revoke-other-sessions',
		'/api/auth/sign-out',
		'/api/auth/switchboard/sign-out',
		'/api/auth/get-access-token',
	])
		expect(installedRoutes.some((route) => route.path === requiredPath)).toBe(true);
	const routes = installedRoutes
		.map((route) => ({
			...route,
			path: route.path.replace(/:([^/]+)/gu, (_parameter: string, name: string): string =>
				encodeURIComponent(name.includes('client') ? registeredClientId : `missing-${name}`),
			),
		}))
		.filter(
			(route) =>
				!publicProviderPaths.has(route.path) &&
				!publicProviderMethods.has(`${route.method} ${route.path}`),
		);
	const cookieOnlySignOutPath = '/api/auth/switchboard/sign-out';
	expect(
		routes.filter((route) => route.path === cookieOnlySignOutPath && route.method === 'POST'),
	).toHaveLength(1);
	const cookieSnapshot = harness.cookie();
	const cookieOwner = await readCurrentBrowserSession({
		cookie: cookieSnapshot,
		database: harness.database,
	});
	expect({ personId: cookieOwner.personId, sessionId: cookieOwner.id }).toEqual({
		personId: person.sub,
		sessionId: person.sid,
	});
	const organizationReadMethods = new Map([
		['/api/auth/organization/self-context', 'GET'],
		['/api/auth/organization/person-membership', 'POST'],
		['/api/auth/organization/people-list', 'GET'],
		['/api/auth/organization/people', 'GET'],
	]);
	for (const [path, method] of organizationReadMethods)
		expect(routes.filter((route) => route.path === path && route.method === method)).toHaveLength(
			1,
		);
	// Compare the cookie holder's own stored projection, never a bearer subject or configured org.
	const choices = z.array(signInTables.organizationChoiceSchema).parse(
		await harness.database
			.select({
				organizationId: signInTables.member.organizationId,
				organizationName: signInTables.organization.name,
				role: signInTables.member.role,
			})
			.from(signInTables.member)
			.innerJoin(
				signInTables.organization,
				eq(signInTables.member.organizationId, signInTables.organization.id),
			)
			.where(eq(signInTables.member.userId, person.sub))
			.orderBy(signInTables.member.organizationId),
	);
	const [cookieSession] = await harness.database
		.select({ activeOrganizationId: signInTables.session.activeOrganizationId })
		.from(signInTables.session)
		.where(eq(signInTables.session.id, person.sid));
	if (cookieSession === undefined)
		throw new Error('Owner cookie session missing from matrix setup');
	const activeOrganizationId =
		choices.find((choice) => choice.organizationId === cookieSession.activeOrganizationId)
			?.organizationId ?? null;
	if (activeOrganizationId === null)
		throw new Error('Owner cookie has no current organization for valid read probes');
	const expectedSelfContext = { kind: 'available', choices, activeOrganizationId };
	async function readCookieAuthority(): Promise<readonly unknown[]> {
		const rows = await harness.database
			.select({
				id: signInTables.session.id,
				expiresAt: signInTables.session.expiresAt,
				activeOrganizationId: signInTables.session.activeOrganizationId,
			})
			.from(signInTables.session)
			.where(eq(signInTables.session.id, cookieOwner.id));
		const revisions = await harness.database
			.select({
				organizationId: signInTables.personOrganizationAuthorizationRevisions.organizationId,
				revision: signInTables.personOrganizationAuthorizationRevisions.revision,
			})
			.from(signInTables.personOrganizationAuthorizationRevisions)
			.where(
				eq(signInTables.personOrganizationAuthorizationRevisions.personId, cookieOwner.personId),
			)
			.orderBy(signInTables.personOrganizationAuthorizationRevisions.organizationId);
		return [rows, revisions];
	}
	const authorityBefore = await readCookieAuthority();
	const centralArrivalsBeforeAttacks = [...harness.centralProvisioning.arrivals];
	const pathlessUrls = await Promise.all(
		['GET', 'POST'].map((method) =>
			harness.auth('/api/auth/organization/add-member', {
				method,
				headers: {
					cookie: cookieSnapshot,
					authorization: `Bearer ${agent}`,
					'content-type': 'application/json',
				},
				...(method === 'POST'
					? {
							body: JSON.stringify({
								userId: person.sub,
								role: 'member',
								organizationId: organizationOne,
							}),
						}
					: {}),
			}),
		),
	);
	expect(pathlessUrls.map((response) => response.status)).toEqual([404, 404]);
	expect(await Promise.all(pathlessUrls.map((response) => response.json()))).toEqual([
		{ error: 'not-found' },
		{ error: 'not-found' },
	]);
	const observations = await Promise.all(
		[agent, withoutSid].flatMap((token) =>
			[false, true].flatMap((withCookie) =>
				routes.map(async (route) => {
					// Four independent attack clients keep stable addresses across
					// the entire inventory. Their bearer/cookie payloads are unchanged;
					// none rotates an address or disables a limit between probes.
					const browserKey = `management-${token === agent ? 'E10' : 'no-sid'}-${withCookie ? 'cookie' : 'no-cookie'}`;
					// Only these exact method/path pairs are public; all other inventory rows keep 404.
					const organizationRead = organizationReadMethods.get(route.path) === route.method;
					const cookieOnlySignOut = route.path === cookieOnlySignOutPath && route.method === 'POST';
					let requestPath = route.path;
					let requestBody: Readonly<Record<string, unknown>> = {
						client_id: registeredClientId,
						actor: person.sub,
						owner: true,
						organizationId: organizationOne,
					};
					let expectedStatus = 404;
					let expectedBody: unknown = { error: 'not-found' };
					if (organizationRead) {
						switch (route.path) {
							case '/api/auth/organization/self-context':
								expectedStatus = withCookie ? 200 : 401;
								expectedBody = withCookie ? expectedSelfContext : { kind: 'signed-out' };
								break;
							case '/api/auth/organization/person-membership':
								requestBody = {
									organizationId: activeOrganizationId,
									email: 'owner@example.invalid',
								};
								expectedStatus = 401;
								expectedBody = { kind: 'refused' };
								break;
							case '/api/auth/organization/people-list':
								requestPath = `${route.path}?organizationId=${activeOrganizationId}&offset=0`;
								expectedStatus = 401;
								expectedBody = { kind: 'refused' };
								break;
							case '/api/auth/organization/people':
								requestPath = `${route.path}?organizationId=${activeOrganizationId}`;
								expectedStatus = 303;
								expectedBody = '';
								break;
							default:
								throw new Error('Unclassified public organization read');
						}
					}
					if (cookieOnlySignOut) {
						expectedStatus = 403;
						expectedBody = { error: 'not-allowed' };
					}
					const response = await harness.authAsBrowser(browserKey, requestPath, {
						method: route.method,
						headers: {
							authorization: `Bearer ${token}`,
							cookie: withCookie ? cookieSnapshot : '',
							'content-type': 'application/json',
							'x-owner-id': person.sub,
							'x-organization-id': organizationOne,
						},
						...(['GET', 'HEAD'].includes(route.method)
							? {}
							: {
									body: JSON.stringify(requestBody),
								}),
					});
					const pageRedirect = organizationRead && route.path === '/api/auth/organization/people';
					const body: unknown =
						route.method === 'HEAD'
							? null
							: pageRedirect
								? await response.text()
								: await response.json();
					expectNoIssuedCredentials(body);
					if (organizationRead || cookieOnlySignOut) {
						expect(body).toEqual(expectedBody);
						if (cookieOnlySignOut) expect(response.headers.getSetCookie()).toEqual([]);
						expect(response.headers.get('cache-control')).toBe('no-store');
						if (pageRedirect) expect(response.headers.get('location')).toBe('/sign-in');
					}
					return {
						...route,
						withCookie,
						identity: token === agent ? 'E10' : 'no-sid',
						status: response.status,
						expectedStatus,
						exactRefusal:
							route.method === 'HEAD' ||
							(organizationRead || cookieOnlySignOut
								? response.status === expectedStatus
								: z.strictObject({ error: z.literal('not-found') }).safeParse(body).success),
					};
				}),
			),
		),
	);
	expect(
		observations.filter((observation) => observation.status !== observation.expectedStatus),
	).toEqual([]);
	expect(observations.filter((observation) => !observation.exactRefusal)).toEqual([]);
	await Promise.all(
		[agent, withoutSid].flatMap((token) =>
			[false, true].map(async (withCookie) => {
				const browserKey = `management-${token === agent ? 'E10' : 'no-sid'}-${withCookie ? 'cookie' : 'no-cookie'}`;
				const refusedBootstrap = await harness.authAsBrowser(
					browserKey,
					'/api/auth/owner/bootstrap',
					{
						method: 'POST',
						headers: {
							authorization: `Bearer ${token}`,
							cookie: withCookie ? cookieSnapshot : '',
							'content-type': 'application/json',
						},
						body: '{}',
					},
				);
				expect(refusedBootstrap.status).toBe(403);
				// The setup retry admits only the owner's cookie: a bearer identity is refused
				// with a body it would accept, so the refusal is the credential check itself.
				const refusedRetry = await harness.authAsBrowser(
					browserKey,
					'/api/auth/organization/retry-provisioning',
					{
						method: 'POST',
						headers: {
							authorization: `Bearer ${token}`,
							cookie: withCookie ? cookieSnapshot : '',
							origin: harness.issuer,
							'content-type': 'application/json',
						},
						body: JSON.stringify({ organizationId: organizationOne }),
					},
				);
				expect(refusedRetry.status).toBe(403);
				const retryBody = await refusedRetry.text();
				const retryPayload: unknown = retryBody === '' ? null : JSON.parse(retryBody);
				expectNoIssuedCredentials(retryPayload);
			}),
		),
	);
	expect(harness.centralProvisioning.arrivals).toEqual(centralArrivalsBeforeAttacks);
	expect(await readCookieAuthority()).toEqual(authorityBefore);
	await requireUnchangedProtectedState();
	expect(harness.effects).toHaveLength(0);
	for (const body of gatewayBodies) expectNoIssuedCredentials(body);
	const ownerRead = await harness.gateway(`${endpoint}/${registeredClientId}`, {
		headers: { authorization: `Bearer ${owner}` },
	});
	expect(await ownerRead.json()).toEqual({
		kind: 'member',
		clientId: registeredClientId,
		workspaceId: workspaceOne,
	});
	const personAtAgentEdge = await harness.gateway(`/workspaces/${workspaceOne}/mcp`, {
		method: 'POST',
		headers: { authorization: `Bearer ${owner}` },
	});
	expect(personAtAgentEdge.status).toBe(401);
	expect(await personAtAgentEdge.json()).toEqual({ error: 'unknown-caller' });
	const noHook = await harness.auth('/__auth-proof/no-hook');
	expect(noHook.status).toBe(200);
	expect(await noHook.json()).toEqual({ refused: true });
});
