import { createContext, Script } from 'node:vm';

import { organization } from '@agent-collaboration/sign-in-core';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { createIsolatedPageDom } from '#sign-in-test-support/test-fixtures/isolated-page-dom';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();

type Harness = Awaited<ReturnType<typeof startLocalAuthHarness>>;

function sentOrganizations(harness: Harness): readonly string[] {
	return harness.centralProvisioning.sends.map((send) => send.organizationId);
}

/** Provisioning traffic only: committed fence changes also push revisions over the same link. */
function provisioningArrivals(harness: Harness): typeof harness.centralProvisioning.arrivals {
	const arrivals = harness.centralProvisioning.arrivals;
	// Nothing ever reaches a route the link does not define.
	expect(arrivals.filter((arrival) => arrival.path === 'other')).toEqual([]);
	return arrivals.filter((arrival) => arrival.path === '/internal/organization-provisioning');
}

async function createPendingOrganization(harness: Harness): Promise<string> {
	await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
	const response = await peoplePost(harness, 'create', {
		name: 'Pending central setup',
		slug: 'pending-central-setup',
	});
	expect(response.status).toBe(200);
	return z.object({ id: z.uuidv7() }).parse(await response.json()).id;
}

it('people: an unconfirmed organization stays setting up and the owner page offers an explicit Try again', async (): Promise<void> => {
	// Arrange: the B1 central capability answers unknown; no central setup is claimed.
	const harness = await startLocalAuthHarness();
	try {
		const organizationId = await createPendingOrganization(harness);

		// Act: opening or refreshing the owner page only reads setup state.
		const page = await harness.auth('/owner-ready');
		const refreshed = await harness.auth('/owner-ready');

		// Assert: an honest pending state and an explicit action are both delivered.
		expect(page.status).toBe(200);
		expect(refreshed.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('Switchboard hasn&#x27;t finished setting up your organization yet.');
		expect(html).toContain('Try again');
		expect(html).toContain('retry-organization-provisioning');
		expect(html).toContain(organizationId);
		expect(
			await harness.database
				.select({ id: organization.id, state: organization.fleetState })
				.from(organization),
		).toEqual([{ id: organizationId, state: 'settingUp' }]);
	} finally {
		await harness.close();
	}
});

it('people: an explicit provisioning retry cannot mark ready without a confirmed central answer', async (): Promise<void> => {
	// Arrange: creation is native; only the absent central link remains a stand-in.
	const harness = await startLocalAuthHarness();
	try {
		const organizationId = await createPendingOrganization(harness);

		// Act: the owner deliberately retries the same existing organization.
		const response = await peoplePost(harness, 'retry-provisioning', { organizationId });

		// Assert: unavailable is an unknown outcome, never a successful setup.
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ kind: 'setting-up', reason: 'unavailable' });
		expect(
			await harness.database
				.select({ id: organization.id, state: organization.fleetState })
				.from(organization),
		).toEqual([{ id: organizationId, state: 'settingUp' }]);
	} finally {
		await harness.close();
	}
});

it('people: creation and a permitted Try again each send once while reads and refused inputs send nothing', async (): Promise<void> => {
	const harness = await startLocalAuthHarness();
	try {
		const organizationId = await createPendingOrganization(harness);
		const ownerCookie = harness.cookie();
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		const initialArrivals = [...provisioningArrivals(harness)];
		expect(initialArrivals).toEqual([
			{ method: 'POST', path: '/internal/organization-provisioning', hasAuthorization: false },
		]);
		await harness.auth('/owner-ready');
		await harness.auth('/owner-ready');
		const internal = await harness.auth('/fleet/internal/organization-provisioning', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ organizationId }),
		});
		expect(internal.status).toBe(404);
		const unauthenticated = await peoplePost(harness, 'retry-provisioning', { organizationId }, '');
		expect(unauthenticated.status).toBe(401);
		expect(provisioningArrivals(harness)).toEqual(initialArrivals);
		const foreign = await peoplePost(
			harness,
			'retry-provisioning',
			{
				organizationId: '019a3dce-2000-7000-8000-000000000099',
			},
			ownerCookie,
		);
		expect(foreign.status).toBe(403);
		expect(provisioningArrivals(harness)).toEqual(initialArrivals);
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		const invited = await peoplePost(
			harness,
			'invite-member',
			{ organizationId, email: 'member@example.invalid', role: 'member' },
			ownerCookie,
		);
		expect(invited.status).toBe(200);
		const invitationId = z.object({ id: z.uuidv7() }).parse(await invited.json()).id;
		await signInConfirmedPeopleBrowser({ harness, email: 'member@example.invalid' });
		expect((await peoplePost(harness, 'accept-invitation', { invitationId })).status).toBe(200);
		const forbidden = await peoplePost(harness, 'retry-provisioning', { organizationId });
		expect(forbidden.status).toBe(403);
		expect(provisioningArrivals(harness)).toEqual(initialArrivals);
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		const retry = await peoplePost(harness, 'retry-provisioning', { organizationId }, ownerCookie);
		expect(retry.status).toBe(503);
		expect(provisioningArrivals(harness)).toEqual([...initialArrivals, ...initialArrivals]);
		expect(sentOrganizations(harness)).toEqual([organizationId, organizationId]);
	} finally {
		await harness.close();
	}
});

it('people: a lost provisioning reply stays pending and the delivered Try again reuses its organization before showing ready', async (): Promise<void> => {
	const harness = await startLocalAuthHarness();
	try {
		harness.centralProvisioning.replyWith('lost-reply');
		const organizationId = await createPendingOrganization(harness);
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		expect(
			await harness.database.select({ state: organization.fleetState }).from(organization),
		).toEqual([{ state: 'settingUp' }]);
		const response = await harness.auth('/owner-ready');
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		const dom = createIsolatedPageDom(
			await response.text(),
			new URL('/owner-ready', harness.issuer).toString(),
		);
		const { document } = dom.window;
		const changed = Promise.withResolvers<void>();
		const observer = new dom.window.MutationObserver((): void => changed.resolve());
		const state = document.getElementById('organization-setup-state');
		if (state === null) throw new Error('Served setup state is missing');
		observer.observe(state, { subtree: true, childList: true, characterData: true });
		const pending: Promise<Response>[] = [];
		try {
			const context = createContext({
				document,
				window: {},
				FormData: dom.window.FormData,
				HTMLFormElement: dom.window.HTMLFormElement,
				fetch(path: string, init?: RequestInit): Promise<Response> {
					const request = harness.auth(path, init);
					pending.push(request);
					return request;
				},
				location: {
					assign: (): never => {
						throw new Error('Retry must not navigate away');
					},
					reload: (): never => {
						throw new Error('Retry must not silently navigate');
					},
				},
				Uint8Array,
				atob,
				btoa,
				Error,
			});
			// Classic inline controllers only: the island bootstrap is an inline module
			// this harness does not run, as it never ran the island bundle.
			for (const script of document.scripts)
				if (!script.src && script.type !== 'module')
					new Script(script.textContent).runInContext(context);
			const form = document.getElementById('retry-organization-provisioning');
			if (!(form instanceof dom.window.HTMLFormElement))
				throw new Error('Served retry form is missing');
			const button = form.querySelector('button');
			if (!(button instanceof dom.window.HTMLButtonElement))
				throw new Error('Served Try again is missing');
			harness.centralProvisioning.replyWith('provisioned');
			form.requestSubmit(button);
			await changed.promise;
			await Promise.all(pending);
			expect(state.textContent).toBe('Ready');
			expect(sentOrganizations(harness)).toEqual([organizationId, organizationId]);
			expect(
				await harness.database.select({ state: organization.fleetState }).from(organization),
			).toEqual([{ state: 'ready' }]);
			await harness.auth('/owner-ready');
			expect(harness.centralProvisioning.sends).toHaveLength(2);
		} finally {
			observer.disconnect();
			dom.window.close();
		}
	} finally {
		await harness.close();
	}
});

it('people: creation sends one natively signed 120-day setup statement and only the 200 marks it ready', async (): Promise<void> => {
	// Arrange: the recording peer confirms setup; signing, key storage and the link are production code.
	const harness = await startLocalAuthHarness();
	try {
		harness.centralProvisioning.replyWith('provisioned');
		// Act
		const organizationId = await createPendingOrganization(harness);
		// Assert: exactly one send, for exactly this organization, verified against the public JWKS.
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		const statement = harness.centralProvisioning.sends[0]?.organizationStatement;
		if (statement === undefined) throw new Error('No setup statement reached the peer');
		const keys = z
			.object({ keys: z.array(z.looseObject({ kty: z.string(), kid: z.string() })) })
			.parse(await (await harness.auth('/api/auth/jwks')).json());
		const verified = await jwtVerify(statement, createLocalJWKSet(keys), {
			issuer: harness.issuer,
			audience: 'https://central.example.invalid/identity',
			typ: 'fleet-organization-stamp+jwt',
			algorithms: ['EdDSA'],
			currentDate: new Date(controlledSignInClock.now()),
		});
		const issuedAt = Math.floor(controlledSignInClock.now() / 1000);
		// Owner choice 3f: 120 days is 10,368,000 seconds; setup names no predecessor.
		expect(verified.payload).toEqual({
			purpose: 'fleet-organization-stamp',
			version: 1,
			iss: harness.issuer,
			aud: 'https://central.example.invalid/identity',
			sub: organizationId,
			organization_id: organizationId,
			iat: issuedAt,
			exp: issuedAt + 10_368_000,
		});
		expect(decodeProtectedHeader(statement).kid).toBe(keys.keys[0]?.kid);
		expect(
			await harness.database.select({ state: organization.fleetState }).from(organization),
		).toEqual([{ state: 'ready' }]);
	} finally {
		await harness.close();
	}
});

it('people: every central refusal or uncertain answer leaves the organization setting up; only a 200 ends it', async (): Promise<void> => {
	// Arrange: the first send is refused as invalid, so the organization starts pending.
	const harness = await startLocalAuthHarness();
	try {
		harness.centralProvisioning.replyWith('invalid-statement');
		const organizationId = await createPendingOrganization(harness);
		const ownerCookie = harness.cookie();
		const stateRows = async (): Promise<unknown> =>
			harness.database.select({ state: organization.fleetState }).from(organization);
		expect(await stateRows()).toEqual([{ state: 'settingUp' }]);
		// Act / Assert: each explicit retry sends once and reports its own outcome.
		for (const [mode, status, body] of [
			['organization-mismatch', 409, { kind: 'refused', reason: 'organization-mismatch' }],
			['stale', 409, { kind: 'refused', reason: 'stale' }],
			['invalid-statement', 409, { kind: 'refused', reason: 'invalid-statement' }],
			['unavailable', 503, { kind: 'setting-up', reason: 'unavailable' }],
			['lost-reply', 503, { kind: 'setting-up', reason: 'unavailable' }],
		] as const) {
			harness.centralProvisioning.replyWith(mode);
			const retry = await peoplePost(
				harness,
				'retry-provisioning',
				{ organizationId },
				ownerCookie,
			);
			expect({ mode, status: retry.status, body: await retry.json() }).toEqual({
				mode,
				status,
				body,
			});
			expect(await stateRows()).toEqual([{ state: 'settingUp' }]);
		}
		harness.centralProvisioning.replyWith('provisioned');
		const confirmed = await peoplePost(
			harness,
			'retry-provisioning',
			{ organizationId },
			ownerCookie,
		);
		expect(confirmed.status).toBe(200);
		expect(await stateRows()).toEqual([{ state: 'ready' }]);
		// One send per attempt: creation plus six retries, each a fresh setup statement.
		expect(sentOrganizations(harness)).toEqual(Array.from({ length: 7 }, () => organizationId));
	} finally {
		await harness.close();
	}
});

/** Serves the owner page and runs its delivered classic controllers; only
 * the browser's fetch and navigation are controlled. */
async function deliveredOwnerPage(harness: Harness): Promise<{
	readonly document: Document;
	readonly retryAndSettle: () => Promise<void>;
	/** Waits for every request the page started (its controllers fetch on load), then closes. */
	readonly close: () => Promise<void>;
}> {
	const response = await harness.auth('/owner-ready');
	expect(response.status).toBe(200);
	const dom = createIsolatedPageDom(
		await response.text(),
		new URL('/owner-ready', harness.issuer).toString(),
	);
	const { document } = dom.window;
	const pending: Promise<Response>[] = [];
	const context = createContext({
		document,
		window: {},
		FormData: dom.window.FormData,
		HTMLFormElement: dom.window.HTMLFormElement,
		fetch(path: string, init?: RequestInit): Promise<Response> {
			const request = harness.auth(path, init);
			pending.push(request);
			return request;
		},
		location: {
			assign: (): never => {
				throw new Error('Retry must not navigate away');
			},
			reload: (): never => {
				throw new Error('Retry must not silently navigate');
			},
		},
		Uint8Array,
		atob,
		btoa,
		Error,
	});
	for (const script of document.scripts)
		if (!script.src && script.type !== 'module')
			new Script(script.textContent).runInContext(context);
	return {
		document,
		async retryAndSettle(): Promise<void> {
			const state = document.getElementById('organization-setup-state');
			const form = document.getElementById('retry-organization-provisioning');
			const button = form?.querySelector('button');
			if (state === null || !(form instanceof dom.window.HTMLFormElement) || !button)
				throw new Error('Served Fleet setup retry is missing');
			const changed = Promise.withResolvers<void>();
			const observer = new dom.window.MutationObserver((): void => changed.resolve());
			observer.observe(state, { subtree: true, childList: true, characterData: true });
			try {
				form.requestSubmit(button);
				await changed.promise;
				await Promise.all(pending);
			} finally {
				observer.disconnect();
			}
		},
		async close(): Promise<void> {
			await Promise.allSettled(pending);
			dom.window.close();
		},
	};
}

it('people: in the sign-in shell, a Try again central cannot confirm says so in one message and keeps Try again', async (): Promise<void> => {
	// Arrange: an organization whose setup central has not confirmed (the link answers unavailable).
	const harness = await startLocalAuthHarness();
	try {
		await createPendingOrganization(harness);
		const page = await deliveredOwnerPage(harness);
		try {
			// Act: the owner presses the delivered Try again.
			await page.retryAndSettle();

			// Assert: one message, what to do and the same one action remain; nothing turned ready.
			const { document } = page;
			expect(document.getElementById('organization-setup-state')?.textContent).toBe(
				"Switchboard still hasn't finished setting up your organization. Try again shortly.",
			);
			const button = document.querySelector('#retry-organization-provisioning button');
			expect(button?.textContent).toBe('Try again');
			expect(button?.hasAttribute('disabled')).toBe(false);
			expect(
				await harness.database.select({ state: organization.fleetState }).from(organization),
			).toEqual([{ state: 'settingUp' }]);
		} finally {
			await page.close();
		}
	} finally {
		await harness.close();
	}
});

it('people: in the sign-in shell, a set-up organization says Ready and offers no Try again', async (): Promise<void> => {
	// Arrange: central confirms setup when the organization is created.
	const harness = await startLocalAuthHarness();
	try {
		harness.centralProvisioning.replyWith('provisioned');
		await createPendingOrganization(harness);
		expect(
			await harness.database.select({ state: organization.fleetState }).from(organization),
		).toEqual([{ state: 'ready' }]);

		// Act: the owner opens the signed-in page.
		const page = await deliveredOwnerPage(harness);
		try {
			// Assert: the done state is the message alone.
			const { document } = page;
			expect(document.getElementById('organization-setup-state')?.textContent).toBe('Ready');
			expect(document.getElementById('retry-organization-provisioning')).toBeNull();
		} finally {
			await page.close();
		}
	} finally {
		await harness.close();
	}
});
