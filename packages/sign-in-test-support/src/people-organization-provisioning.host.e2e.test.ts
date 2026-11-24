import {
	organization,
	organizationAdminPageStateSchema,
	organizationSetupRetryMessages,
	retryOrganizationSetup,
	type OrganizationSetupRetry,
} from '@agent-collaboration/sign-in-core';
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

const organizationAdminIslandSchema = z.object({
	kind: z.literal('organization-admin'),
	navigation: z.object({ activeOrganization: z.object({ organizationId: z.string() }) }),
	admin: organizationAdminPageStateSchema,
});

/** The served Organization admin shell page, and its Try again as the page's island runs it. */
async function servedOrganizationAdmin(harness: Harness): Promise<{
	readonly html: string;
	readonly state: z.infer<typeof organizationAdminIslandSchema>;
	readonly setupState: () => string | null;
	readonly retryButtons: () => number;
	readonly retry: () => Promise<OrganizationSetupRetry>;
}> {
	const address = new URL('/organization-admin', harness.issuer).toString();
	const response = await harness.auth(address);
	expect(response.status).toBe(200);
	const html = await response.text();
	const { document } = createIsolatedPageDom(html, address).window;
	const state = organizationAdminIslandSchema.parse(
		JSON.parse(
			document.querySelector('[data-sign-in-island]')?.getAttribute('data-island-state') ?? 'null',
		),
	);
	return {
		html,
		state,
		setupState: () => document.getElementById('organization-setup-state')?.textContent ?? null,
		retryButtons: () =>
			[...document.querySelectorAll('button')].filter(
				(button) => button.textContent === 'Try again',
			).length,
		retry: () =>
			retryOrganizationSetup(state.navigation.activeOrganization.organizationId, (path, body) =>
				harness.auth(path, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
			),
	};
}

it('people: an unconfirmed organization stays setting up and the shell Organization admin offers an explicit Try again', async (): Promise<void> => {
	// Arrange: the B1 central capability answers unknown; no central setup is claimed.
	const harness = await startLocalAuthHarness();
	try {
		const organizationId = await createPendingOrganization(harness);

		// Act: the owner lands in the shell; opening or refreshing Organization admin only reads setup state.
		const landing = await harness.auth('/owner-ready', { redirect: 'manual' });
		const page = await servedOrganizationAdmin(harness);
		const refreshed = await servedOrganizationAdmin(harness);

		// Assert: an honest pending state and an explicit action are both delivered.
		expect(landing.status).toBe(303);
		expect(landing.headers.get('location')).toBe('/me');
		expect(refreshed.state.admin.fleetSetup).toBe('settingUp');
		expect(page.state.admin.fleetSetup).toBe('settingUp');
		expect(page.html).toContain(
			'Switchboard hasn&#x27;t finished setting up your organization yet.',
		);
		expect(page.retryButtons()).toBe(1);
		expect(page.html).toContain(organizationId);
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
		const page = await servedOrganizationAdmin(harness);
		expect(sentOrganizations(harness)).toEqual([organizationId]);
		expect(page.state.admin.fleetSetup).toBe('settingUp');
		harness.centralProvisioning.replyWith('provisioned');
		// Act: the page's own Try again.
		const retried = await page.retry();
		expect(retried).toEqual({ kind: 'ready' });
		expect(sentOrganizations(harness)).toEqual([organizationId, organizationId]);
		expect(
			await harness.database.select({ state: organization.fleetState }).from(organization),
		).toEqual([{ state: 'ready' }]);
		expect((await servedOrganizationAdmin(harness)).state.admin.fleetSetup).toBe('ready');
		expect(harness.centralProvisioning.sends).toHaveLength(2);
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

it('people: in the sign-in shell, a Try again central cannot confirm says so in one message and keeps Try again', async (): Promise<void> => {
	// Arrange: an organization whose setup central has not confirmed (the link answers unavailable).
	const harness = await startLocalAuthHarness();
	try {
		await createPendingOrganization(harness);
		const page = await servedOrganizationAdmin(harness);

		// Act: the owner presses the delivered Try again.
		const retried = await page.retry();

		// Assert: one message, what to do, and the page keeps its one action; nothing turned ready.
		expect(retried).toEqual({
			kind: 'still-setting-up',
			message: organizationSetupRetryMessages.stillSettingUp,
		});
		expect(organizationSetupRetryMessages.stillSettingUp).toBe(
			"Switchboard still hasn't finished setting up your organization. Try again shortly.",
		);
		expect((await servedOrganizationAdmin(harness)).retryButtons()).toBe(1);
		expect(
			await harness.database.select({ state: organization.fleetState }).from(organization),
		).toEqual([{ state: 'settingUp' }]);
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

		// Act: the owner opens Organization admin.
		const page = await servedOrganizationAdmin(harness);

		// Assert: the done state is the message alone.
		expect(page.setupState()).toBe('Ready');
		expect(page.retryButtons()).toBe(0);
	} finally {
		await harness.close();
	}
});
