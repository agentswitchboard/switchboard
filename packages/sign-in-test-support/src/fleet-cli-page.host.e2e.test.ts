import {
	fleetAdminProofKeyThumbprint,
	organization,
	signInSchema,
} from '@agent-collaboration/sign-in-core';
import {
	createMemoryProofKeyStore,
	requireFleetTarget,
	signInFleetCli,
} from '@agent-collaboration/sign-in-owner-cli';
import { jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import {
	fleetCliIoFor,
	ownerEmail,
	publicKeys,
	setupFleetCli,
	type FleetFixture,
} from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';
import {
	createServedOwnerBrowser,
	type ServedOwnerObservation,
} from '#sign-in-test-support/test-fixtures/served-owner-browser';

useControlledSignInClock();
const firstOrganization = { name: 'First Fleet', slug: 'first-fleet' };

async function systemRegistrations(harness: FleetFixture['harness']): Promise<unknown> {
	const { oauthClient, oauthClientResource } = signInSchema;
	return {
		clients: await harness.database.select().from(oauthClient).orderBy(oauthClient.clientId),
		links: await harness.database
			.select()
			.from(oauthClientResource)
			.orderBy(oauthClientResource.clientId),
	};
}

async function chooseOrganizationFromReadyPage(
	harness: FleetFixture['harness'],
	ready: URL,
	organizationId: string,
): Promise<void> {
	const response = await harness.auth(ready.toString());
	expect(response.status).toBe(200);
	const dom = createIsolatedPageDom(await response.text(), ready.toString());
	try {
		const { document, HTMLButtonElement } = dom.window;
		expect(document.querySelector('h1')?.textContent).toBe('Choose your organization');
		expect(document.querySelector('[data-fleet-cli-continuation]')?.textContent).toContain(
			'codex-router CLI',
		);
		expect(document.querySelector('#owner-sign-in button')?.hasAttribute('disabled')).toBe(true);
		const choice = document.querySelector(`#choose-organization button[value="${organizationId}"]`);
		if (!(choice instanceof HTMLButtonElement))
			throw new Error('The selected organization is missing from the served chooser');
		// The controlled browser supplies the rendered choice to the same native endpoint as the island.
		expect((await peoplePost(harness, 'set-active', { organizationId: choice.value })).status).toBe(
			200,
		);
	} finally {
		dom.window.close();
	}
}

it.each(['signed-out', 'signed-in', 'owner-ready'] as const)(
	'Fleet CLI from %s follows served pages and completes the original loopback exchange',
	async (entry): Promise<void> => {
		const fixture = entry === 'signed-out' ? null : await setupFleetCli();
		const harness = fixture?.harness ?? (await startLocalAuthHarness());
		const target =
			fixture?.target ??
			requireFleetTarget({ ...harness.target, organizationId: controlledSignInIds.nextId() });
		const io =
			fixture?.io ??
			fleetCliIoFor({ harness, cookie: '', now: controlledSignInClock.now, sent: [] });
		const store = createMemoryProofKeyStore(webSignInCrypto);
		const events: ServedOwnerObservation[] = [];
		const pages: string[] = [];
		const actions: { readonly pathname: string; readonly status: number }[] = [];
		let continueSubmissions = 0;
		let callbackCount = 0;
		try {
			const before = await systemRegistrations(harness);
			let selectedOrganizationId = target.organizationId;
			if (entry === 'owner-ready') {
				const created = await peoplePost(harness, 'create', {
					name: 'Second Fleet',
					slug: 'second-fleet',
				});
				expect(created.status).toBe(200);
				selectedOrganizationId = z.object({ id: z.uuidv7() }).parse(await created.json()).id;
				await signInConfirmedPeopleBrowser({ harness, email: ownerEmail });
			}
			const session = await signInFleetCli({
				target,
				store,
				io: {
					...io,
					async browser(printedUrl): Promise<void> {
						// Match Router 6f6e1684da7a1bf5f15e1d8c4af34ee97abbfcab,
						// crates/central-person-link-client/src/fleet_login.rs:84–101.
						const printed = new URL(printedUrl);
						expect(printed.pathname).toBe('/sign-in');
						expect([...printed.searchParams.keys()]).toEqual(['authorize']);
						const authorize = new URL(z.string().parse(printed.searchParams.get('authorize')));
						const redirect = new URL(z.string().parse(authorize.searchParams.get('redirect_uri')));
						const state = authorize.searchParams.get('state');
						expect(authorize.origin).toBe(new URL(target.issuer).origin);
						expect(authorize.pathname).toBe('/api/auth/oauth2/authorize');
						expect(redirect.port).toMatch(/^[0-9]+$/u);
						expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
						expect([...authorize.searchParams.entries()]).toEqual([
							['client_id', target.ownerFleetCliClientId],
							['response_type', 'code'],
							['redirect_uri', redirect.toString()],
							['scope', 'fleet:admin offline_access'],
							['resource', target.centralAdminAudience],
							['code_challenge', expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)],
							['code_challenge_method', 'S256'],
							['state', state],
						]);
						const browser = createServedOwnerBrowser({
							harness,
							email: ownerEmail,
							...(entry === 'signed-out'
								? { organization: firstOrganization }
								: { initialSession: 'confirmed' }),
							observe(event): void {
								events.push(event);
							},
							observePage(url, document): void {
								const notice = document.querySelector('[data-fleet-cli-continuation]');
								expect(notice?.textContent).toContain('codex-router CLI');
								expect(notice?.textContent).toContain('answering approvals');
								const button = document.querySelector('#owner-sign-in button');
								if (url.pathname === '/sign-in') {
									expect(button?.textContent).toContain('Continue with Google');
									pages.push('sign-in');
								}
								if (button?.textContent === 'Continue to codex-router CLI') pages.push('continue');
							},
							observeRequest(pathname, status): void {
								actions.push({ pathname, status });
							},
							observeBeforeSubmit(button): void {
								if (button.textContent !== 'Continue to codex-router CLI') return;
								expect(button.disabled).toBe(false);
								expect(callbackCount).toBe(0);
								expect(
									actions.some(({ pathname }) => pathname === '/api/auth/owner/bootstrap'),
								).toBe(false);
								continueSubmissions += 1;
							},
							observeCallback(callback): void {
								expect(continueSubmissions).toBe(1);
								expect(callback.origin).toBe(redirect.origin);
								expect(callback.pathname).toBe(redirect.pathname);
								expect(callback.searchParams.getAll('state')).toEqual([state]);
								expect(callback.searchParams.getAll('iss')).toEqual([target.issuer]);
								expect(callback.searchParams.getAll('code')).toEqual([
									expect.stringMatching(/.+/u),
								]);
								expect(actions.at(-1)).toEqual({
									pathname: '/api/auth/owner/bootstrap',
									status: 200,
								});
								callbackCount += 1;
							},
						});
						if (entry === 'owner-ready') {
							printed.pathname = '/owner-ready';
							await chooseOrganizationFromReadyPage(harness, printed, selectedOrganizationId);
						}
						await browser(printed.toString());
					},
				},
			});
			expect(callbackCount).toBe(1);
			expect(pages[0]).toBe(entry === 'owner-ready' ? 'continue' : 'sign-in');
			expect(pages).toContain('continue');
			const { payload } = await jwtVerify(session.accessToken, await publicKeys(harness), {
				issuer: target.issuer,
				audience: target.centralAdminAudience,
				typ: 'at+jwt',
				currentDate: new Date(io.now()),
			});
			if (entry === 'signed-out') {
				const organizations = await harness.database
					.select({ id: organization.id, name: organization.name })
					.from(organization);
				expect(organizations).toEqual([
					{ id: payload.organization_id, name: firstOrganization.name },
				]);
				selectedOrganizationId = z.uuidv7().parse(organizations[0]?.id);
			}
			expect(payload).toMatchObject({
				client_id: target.ownerFleetCliClientId,
				token_profile: 'person-fleet',
				organization_id: selectedOrganizationId,
				cnf: { jkt: await fleetAdminProofKeyThumbprint(webSignInCrypto, session.key) },
			});
			expect(await store.load()).toMatchObject({ refreshToken: expect.stringMatching(/.+/u) });
			if (entry === 'owner-ready')
				expect(actions).toEqual([
					{ pathname: '/api/auth/passkey/list-user-passkeys', status: 200 },
					{ pathname: '/api/auth/owner/bootstrap', status: 200 },
				]);
			else {
				expect(actions[0]).toEqual({ pathname: '/api/auth/sign-in/social', status: 200 });
				const confirmation = events.find((event) => event.kind === 'app-confirmed');
				if (confirmation?.kind !== 'app-confirmed')
					throw new Error('The served app confirmation was not observed');
				if (entry === 'signed-out')
					expect(confirmation.afterSessionId).not.toBe(confirmation.beforeSessionId);
				expect(payload.sid).toBe(confirmation.afterSessionId);
				expect(payload.second_factor_method).toBe('app');
			}
			if (entry !== 'signed-out') expect(await systemRegistrations(harness)).toEqual(before);
		} finally {
			await harness.close();
		}
	},
);

it('Fleet CLI proof rejects a ready-page script that navigates before Continue', async (): Promise<void> => {
	const fixture = await setupFleetCli();
	const { harness, target } = fixture;
	const store = createMemoryProofKeyStore(webSignInCrypto);
	let callbackCount = 0;
	try {
		const browser = createServedOwnerBrowser({
			harness: {
				...harness,
				async auth(path, init): Promise<Response> {
					const response = await harness.auth(path, init);
					const url = new URL(path, harness.issuer);
					if (url.pathname !== '/owner-ready') return response;
					const authorization = z.string().min(1).parse(url.searchParams.get('authorize'));
					const html = await response.text();
					const controllerStart = /<script nonce="[^"]+">/u;
					expect(html).toMatch(controllerStart);
					// Put the wrong behavior inside the nonce-bearing controller the page already serves.
					const mutated = html.replace(
						controllerStart,
						(start) => `${start}location.assign(${JSON.stringify(authorization)});\n`,
					);
					return new Response(mutated, {
						status: response.status,
						headers: response.headers,
					});
				},
			},
			email: ownerEmail,
			initialSession: 'confirmed',
			observe: () => undefined,
			observeCallback(): void {
				callbackCount += 1;
			},
		});
		const outcome = await signInFleetCli({
			target,
			store,
			io: {
				...fixture.io,
				async browser(printedUrl): Promise<void> {
					const ready = new URL(printedUrl);
					ready.pathname = '/owner-ready';
					await browser(ready.toString());
				},
			},
		}).then(
			() => ({ kind: 'completed' }),
			(error: unknown) => ({
				kind: 'refused',
				reason: error instanceof Error ? error.message : '',
			}),
		);
		expect(outcome).toEqual({
			kind: 'refused',
			reason: 'Served owner page attempted navigation before form submission',
		});
		expect(callbackCount).toBe(0);
		expect(fixture.sent).toEqual([]);
		expect(await store.load()).toBeNull();
	} finally {
		await harness.close();
	}
});

it('Fleet CLI shows the signed-in member the owner-only refusal and issues no code', async (): Promise<void> => {
	const fixture = await setupFleetCli();
	const { harness, target } = fixture;
	const store = createMemoryProofKeyStore(webSignInCrypto);
	const email = 'member@example.invalid';
	const actions: { readonly pathname: string; readonly status: number }[] = [];
	try {
		const invited = await peoplePost(harness, 'invite-member', {
			organizationId: target.organizationId,
			email,
			role: 'member',
		});
		expect(invited.status).toBe(200);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		await signInConfirmedPeopleBrowser({ harness, email });
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		const before = await systemRegistrations(harness);
		const browser = createServedOwnerBrowser({
			harness,
			email,
			initialSession: 'confirmed',
			observe: () => undefined,
			observeRequest(pathname, status): void {
				actions.push({ pathname, status });
			},
			observeCallback(): never {
				throw new Error('The member reached the CLI callback');
			},
		});
		await expect(
			signInFleetCli({
				target,
				store,
				io: {
					...fixture.io,
					async browser(printedUrl): Promise<void> {
						const ready = new URL(printedUrl);
						ready.pathname = '/owner-ready';
						await browser(ready.toString());
					},
				},
			}),
		).rejects.toThrow('Only the organization owner can continue to the codex-router CLI.');
		expect(actions).toEqual([
			{ pathname: '/api/auth/passkey/list-user-passkeys', status: 200 },
			{ pathname: '/api/auth/owner/bootstrap', status: 403 },
		]);
		expect(fixture.sent).toEqual([]);
		expect(await store.load()).toBeNull();
		expect(await systemRegistrations(harness)).toEqual(before);
	} finally {
		await harness.close();
	}
});
