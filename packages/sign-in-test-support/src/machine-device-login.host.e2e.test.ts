import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	deviceCode,
	epochMillisecondsSchema,
	oauthClient,
	uuid7Schema,
} from '@agent-collaboration/sign-in-core';
import {
	decideDeviceLoginSchema,
	decideMachineTokenSchema,
	fleetLoginDiscoveryResponseSchema,
	machineTokenClaimsSchema,
	machineTokenResponseSchema,
} from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	controlledSignInClock,
	controlledSignInIds,
} from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { assertMachineDeviceReplayResponse } from '#sign-in-test-support/test-fixtures/machine-device-replay-response';
import { installOrganizationBrowserCookie } from '#sign-in-test-support/test-fixtures/organization-browser-transport';
import {
	launchProofBrowser,
	runProofBrowserScenario,
} from '#sign-in-test-support/test-fixtures/playwright-browser';

useControlledSignInClock();
const routerClientId = uuid7Schema.parse('019a3dce-2000-7000-8000-0000000000b1');
const machineId = '019a3dce-2000-7000-8000-0000000000b2';
const enrollmentId = '019a3dce-2000-7000-8000-0000000000b3';
const workspaceId = '019a3dce-2000-7000-8000-0000000000b4';
const archivedWorkspaceId = '019a3dce-2000-7000-8000-0000000000b0';
const deviceStartSchema = z.strictObject({
	device_code: z.string(),
	user_code: z.string(),
	verification_uri: z.url(),
	verification_uri_complete: z.url(),
	expires_in: z.number(),
	interval: z.number(),
});

function publicForm(body: Readonly<Record<string, string>>): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '' },
		body: new URLSearchParams(body),
	};
}

async function confirmAndRetryDenyInBrowser(props: {
	readonly harness: Awaited<ReturnType<typeof startLocalAuthHarness>>;
	readonly userCode: string;
}): Promise<void> {
	const { harness, userCode } = props;
	await runProofBrowserScenario(async (scenarioSignal) => {
		const browser = await launchProofBrowser({
			evidence: await mkdtemp(join(tmpdir(), 'del02-approval-browser-')),
			origin: harness.issuer,
			scenarioSignal,
		});
		try {
			await installOrganizationBrowserCookie({
				page: browser,
				issuer: harness.issuer,
				cookie: harness.cookie(),
			});
			const path = `/device?user_code=${encodeURIComponent(userCode)}`;
			const navigation = await browser.page.goto(`${harness.issuer}${path}`);
			expect(navigation?.status()).toBe(200);
			const denyPath = '/api/auth/machine-login/deny';
			const firstDeny = browser.page.waitForResponse(
				(response) => new URL(response.url()).pathname === denyPath,
			);
			await browser.page.getByRole('button', { name: 'Deny', exact: true }).click();
			const denial = await firstDeny;
			expect(denial.status()).toBe(403);
			expect(await denial.json()).toEqual({
				error: 'access_denied',
				reason: { kind: 'secondFactorRequired', withinSeconds: 900 },
			});
			await browser.page.locator('[data-device-page-state="confirm-again"]').waitFor();
			const retriedDeny = browser.page.waitForResponse(
				(response) => new URL(response.url()).pathname === denyPath,
			);
			const factor = browser.page.waitForResponse(
				(response) => new URL(response.url()).pathname === '/api/auth/two-factor/verify-totp',
			);
			await browser.page
				.locator('input[name="code"]')
				.fill(await harness.totpAuthenticator.currentCode('owner@example.invalid'));
			expect((await factor).status()).toBe(200);
			expect((await retriedDeny).status()).toBe(200);
			await browser.page.locator('[data-device-page-state="denied"]').waitFor();
		} finally {
			await browser.close();
		}
	});
}

it('matches device-login replay fixtures while approving one machine ID and releasing one redemption', async (): Promise<void> => {
	const approveBodies: z.infer<typeof decideDeviceLoginSchema>[] = [];
	const mintBodies: z.infer<typeof decideMachineTokenSchema>[] = [];
	const revokeBodies: Array<{ readonly organizationId: string; readonly enrollmentId: string }> =
		[];
	let authenticatorTime = controlledSignInClock.now();
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		authenticatorClock: { now: () => authenticatorTime },
		machineLogin: {
			routerClientId,
			machineAudience: 'https://central.example.invalid/machine',
		},
		async machineDecisions(request): Promise<Response> {
			const input: unknown = await request.json();
			const pathname = new URL(request.url).pathname;
			if (pathname === '/organization-admin/v1/revoke-machine-enrollment') {
				if (
					!request.headers.get('authorization')?.startsWith('DPoP ') ||
					!request.headers.has('dpop')
				)
					return new Response(null, { status: 401 });
				const intent = z
					.strictObject({ organizationId: z.uuidv7(), enrollmentId: z.uuidv7() })
					.parse(input);
				revokeBodies.push(intent);
				return Response.json({ result: 'revoked' });
			}
			if (pathname === '/internal/device-login-decisions') {
				const approval = decideDeviceLoginSchema.parse(input);
				approveBodies.push(approval);
				return Response.json({
					result: 'approved',
					enrollmentId,
					label: approval.label,
					allowedWorkspaces: approval.allowedWorkspaces,
				});
			}
			mintBodies.push(decideMachineTokenSchema.parse(input));
			const now = Math.floor(controlledSignInClock.now() / 1000);
			return Response.json({
				result: 'grant',
				machineId,
				enrollmentId,
				decidedAt: now,
				grantExpiresAt: now + 3600,
			});
		},
	});
	try {
		harness.centralProvisioning.replyWith('provisioned');
		harness.centralProvisioning.replyToPushesWith('acknowledge');
		const ownerClaims = z
			.object({ organization_id: z.uuidv7() })
			.parse(decodeJwt(await harness.ownerToken()));
		const organizationId = ownerClaims.organization_id;
		await harness.settleDeferredWork();
		function offerDirectory(): void {
			harness.centralAdmin.scriptNextAnswer('ListWorkspaces', (request) => {
				expect(request).toMatchObject({ operation: 'ListWorkspaces', limit: 100 });
				expect(request).not.toHaveProperty('after');
				return {
					result: 'workspaces',
					workspaces: [
						{
							workspaceId: archivedWorkspaceId,
							name: 'Archived workspace',
							description: '',
							state: 'archived',
						},
					],
					next: archivedWorkspaceId,
				};
			});
			harness.centralAdmin.scriptNextAnswer('ListWorkspaces', (request) => {
				expect(request).toMatchObject({
					operation: 'ListWorkspaces',
					after: archivedWorkspaceId,
					limit: 100,
				});
				return {
					result: 'workspaces',
					workspaces: [{ workspaceId, name: 'Active workspace', description: '', state: 'active' }],
					next: null,
				};
			});
		}
		const deviceRequest = {
			client_id: routerClientId,
			machine_id: machineId,
			machine_label: 'Proof Mac',
			organization_id: organizationId,
		};
		const discovery = fleetLoginDiscoveryResponseSchema.parse(
			await assertMachineDeviceReplayResponse(
				'discovery',
				await harness.auth('/.well-known/fleet-login', {
					headers: { 'x-forwarded-host': 'unrelated.example.invalid', 'x-forwarded-proto': 'http' },
				}),
			),
		);
		expect(discovery.client_id).toBe(routerClientId);
		expect(discovery.link_url).toBe(
			harness.signInHost === 'cloudflare'
				? `https://${new URL(harness.issuer).host}/api/fleet/link/{organization_id}`
				: 'https://central.example.invalid/v1/organizations/{organization_id}/link',
		);
		function pollDevice(issuedDeviceCode: string): Promise<Response> {
			return harness.auth(
				'/api/auth/oauth2/token',
				publicForm({
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
					client_id: routerClientId,
					device_code: issuedDeviceCode,
				}),
			);
		}
		for (const retiredKey of ['machine_installation_id', 'machine_peer_id']) {
			const refused = await harness.auth(
				'/api/auth/device/code',
				publicForm({ ...deviceRequest, [retiredKey]: machineId }),
			);
			expect(refused.status).toBe(400);
			expect(await refused.json()).toEqual({ error: 'invalid_request' });
		}
		expect(await harness.database.select({ id: deviceCode.id }).from(deviceCode)).toEqual([]);
		const started = await harness.auth('/api/auth/device/code', publicForm(deviceRequest));
		const code = deviceStartSchema.parse(
			await assertMachineDeviceReplayResponse('device-code-start', started),
		);
		const pendingStart = await harness.auth(
			'/api/auth/device/code',
			publicForm({
				...deviceRequest,
				machine_id: controlledSignInIds.nextId(),
				machine_label: 'Unapproved fixture Mac',
			}),
		);
		const pendingCode = deviceStartSchema.parse(
			await assertMachineDeviceReplayResponse('device-code-start', pendingStart),
		);
		await assertMachineDeviceReplayResponse(
			'poll-authorization_pending',
			await pollDevice(pendingCode.device_code),
		);
		const pathname = `/device?user_code=${encodeURIComponent(code.user_code)}`;
		offerDirectory();
		const page = await harness.auth(pathname);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('Machines');
		expect(html).toContain('data-device-page-state="review"');
		expect(html).toContain(`id="workspace-${workspaceId}"`);
		expect(html).toContain('Active workspace');
		expect(html).not.toContain(archivedWorkspaceId);
		expect(html).not.toContain('Archived workspace');
		const [eligible] = await harness.database
			.select()
			.from(deviceCode)
			.where(eq(deviceCode.deviceCode, code.device_code));
		if (eligible === undefined) throw new Error('Owner verification did not leave a pending row');
		const otherId = controlledSignInIds.nextId();
		const filtered = [
			['wrong-organization', { organizationId: otherId }],
			['wrong-approver', { userId: otherId }],
			['wrong-client', { clientId: otherId }],
			['denied-code', { status: 'denied' }],
			['expired-code', { expiresAt: new Date(controlledSignInClock.now()) }],
		] as const satisfies readonly (readonly [string, Partial<typeof deviceCode.$inferInsert>])[];
		await harness.database.insert(deviceCode).values(
			filtered.map(([label, delta]) => ({
				...eligible,
				...delta,
				id: controlledSignInIds.nextId(),
				deviceCode: `proof-polling-${label}`,
				userCode: `PROOF-${label.toUpperCase()}`,
				machineLabel: label,
			})),
		);
		const pending = await (await harness.auth('/device')).text();
		expect(pending).toContain('Waiting for approval');
		expect(pending).toContain('Proof Mac');
		expect(pending.includes(code.device_code)).toBe(false);
		for (const [label] of filtered) expect(pending.includes(label), label).toBe(false);
		expect(harness.centralAdmin.arrivals).toContainEqual(
			expect.objectContaining({
				route: 'ListWorkspaces',
				organizationId,
				permissions: expect.arrayContaining(['organization:view']),
			}),
		);
		const decide = (allowedWorkspaces: readonly string[]): Promise<Response> =>
			harness.auth('/api/auth/machine-login/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: harness.issuer },
				body: JSON.stringify({ userCode: code.user_code, allowedWorkspaces }),
			});
		offerDirectory();
		const archived = await decide([archivedWorkspaceId]);
		expect(archived.status).toBe(403);
		expect(await archived.json()).toEqual({
			error: 'access_denied',
			reason: { kind: 'unknownWorkspace' },
		});
		expect(approveBodies).toEqual([]);

		offerDirectory();
		const approval = await decide([workspaceId]);
		expect(approval.status).toBe(200);
		expect(approval.headers.has('set-cookie')).toBe(false);
		expect(approval.headers.has('authorization')).toBe(false);
		expect(await approval.json()).toEqual({
			enrollmentId,
			label: 'Proof Mac',
			allowedWorkspaces: [workspaceId],
		});
		expect(approveBodies[0]).toMatchObject({
			organizationId,
			machineId,
			allowedWorkspaces: [workspaceId],
		});

		expect(
			harness.centralAdmin.arrivals.filter(({ route }) => route === 'ListWorkspaces'),
		).toHaveLength(6);

		const polled = await Promise.all([pollDevice(code.device_code), pollDevice(code.device_code)]);
		const redeemFailures = await Promise.all(
			polled
				.filter((response) => !response.ok)
				.map(
					async (response) => z.object({ error: z.string() }).parse(await response.json()).error,
				),
		);
		expect(
			polled.map((response) => response.status).toSorted((left, right) => left - right),
			`Machine grant calls: ${mintBodies.length}. Refusals: ${redeemFailures.join(', ')}`,
		).toEqual([200, 400]);
		const winner = polled.find((response) => response.ok);
		if (winner === undefined) throw new Error('No poller received a token');
		expect(winner.headers.has('set-cookie')).toBe(false);
		expect(winner.headers.has('authorization')).toBe(false);
		const tokens = machineTokenResponseSchema
			.strict()
			.parse(await assertMachineDeviceReplayResponse('token-success', winner));
		const claims = machineTokenClaimsSchema.parse(decodeJwt(tokens.access_token));
		expect(claims.principal).toEqual({
			kind: 'machine',
			machine_id: machineId,
			enrollment_id: enrollmentId,
		});
		expect(mintBodies).toEqual([{ organizationId, enrollmentId, clientId: enrollmentId }]);
		expect(
			await harness.database
				.select({ id: deviceCode.id })
				.from(deviceCode)
				.where(eq(deviceCode.deviceCode, code.device_code)),
		).toEqual([]);

		const refresh = (credential: string): Promise<Response> =>
			harness.auth(
				'/api/auth/oauth2/token',
				publicForm({
					grant_type: 'refresh_token',
					client_id: enrollmentId,
					refresh_token: credential,
				}),
			);
		const renewed = await refresh(tokens.refresh_token);
		const replacement = machineTokenResponseSchema
			.strict()
			.parse(await assertMachineDeviceReplayResponse('refresh-success', renewed));
		expect(replacement.refresh_token !== tokens.refresh_token).toBe(true);
		await assertMachineDeviceReplayResponse(
			'refresh-invalid_grant',
			await refresh('fixture-only-unissued-refresh-token'),
		);
		expect(mintBodies).toHaveLength(2);
		const revoked = await harness.auth('/api/auth/organization-admin/revoke-machine-enrollment', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: harness.issuer },
			body: JSON.stringify({ organizationId, enrollmentId }),
		});
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toEqual({ result: 'revoked' });
		expect(revokeBodies).toEqual([{ organizationId, enrollmentId }]);
		expect(
			await harness.database
				.select({ disabled: oauthClient.disabled })
				.from(oauthClient)
				.where(eq(oauthClient.clientId, enrollmentId)),
		).toEqual([{ disabled: true }]);
		const afterRevoke = await refresh(replacement.refresh_token);
		await assertMachineDeviceReplayResponse('refresh-invalid_client', afterRevoke);
		expect(mintBodies).toHaveLength(2);

		const later = controlledSignInClock.now() + 901_000;
		authenticatorTime = epochMillisecondsSchema.parse(later);
		expect(
			(
				await harness.auth('/__auth-proof/set-clock', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ milliseconds: later }),
				})
			).status,
		).toBe(200);
		harness.setCentralAdminTime(later);
		const secondStart = await harness.auth('/api/auth/device/code', publicForm(deviceRequest));
		expect(secondStart.status).toBe(200);
		const secondCode = deviceStartSchema.parse(await secondStart.json());
		await confirmAndRetryDenyInBrowser({ harness, userCode: secondCode.user_code });
		expect(approveBodies).toHaveLength(1);
		expect(
			await harness.database
				.select({ status: deviceCode.status })
				.from(deviceCode)
				.where(eq(deviceCode.deviceCode, secondCode.device_code)),
		).toEqual([{ status: 'denied' }]);
	} finally {
		await harness.close();
	}
});
