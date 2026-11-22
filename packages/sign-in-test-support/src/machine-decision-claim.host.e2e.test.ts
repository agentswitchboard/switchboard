import { deviceCode, uuid7Schema } from '@agent-collaboration/sign-in-core';
import {
	decideDeviceLoginSchema,
	machineTokenResponseSchema,
} from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

it('holds an approval claim before Central so a competing denial has no effect', async (): Promise<void> => {
	const routerClientId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000091');
	const machineId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000092');
	const enrollmentId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000093');
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const applied: string[] = [];
	const sends: string[] = [];
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		machineLogin: {
			routerClientId,
			machineAudience: 'https://central.example.invalid/machine',
		},
		async machineDecisions(request): Promise<Response> {
			if (new URL(request.url).pathname !== '/internal/device-login-decisions')
				return new Response(null, { status: 404 });
			const input = decideDeviceLoginSchema.parse(await request.json());
			sends.push(input.requestId);
			arrived.resolve();
			await release.promise;
			applied.push(input.requestId);
			return Response.json({
				result: 'approved',
				enrollmentId,
				label: input.label,
				allowedWorkspaces: [],
			});
		},
	});
	let outstanding: Promise<Response> | undefined;
	try {
		harness.centralProvisioning.replyWith('provisioned');
		harness.centralProvisioning.replyToPushesWith('acknowledge');
		const { organization_id: organizationId } = z
			.object({ organization_id: z.uuidv7() })
			.parse(decodeJwt(await harness.ownerToken()));
		await harness.settleDeferredWork();
		async function verifiedCode(): Promise<{ user_code: string; device_code: string }> {
			const request = await harness.auth('/api/auth/device/code', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: routerClientId,
					machine_id: machineId,
					machine_label: 'Proof Mac',
					organization_id: organizationId,
				}),
			});
			expect(request.status).toBe(200);
			const parsed = z
				.object({ user_code: z.string(), device_code: z.string() })
				.parse(await request.json());
			const verified = await harness.auth(
				`/api/auth/device?user_code=${encodeURIComponent(parsed.user_code)}`,
			);
			expect(verified.status).toBe(200);
			return parsed;
		}
		function decide(action: 'approve' | 'deny', userCode: string): Promise<Response> {
			return harness.auth(`/api/auth/machine-login/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: harness.issuer },
				body: JSON.stringify({
					userCode,
					...(action === 'approve' ? { allowedWorkspaces: [] } : {}),
				}),
			});
		}
		const approvalWins = await verifiedCode();
		outstanding = decide('approve', approvalWins.user_code);
		await Promise.race([
			arrived.promise,
			outstanding.then((response) => {
				throw new Error(`Approval returned ${response.status} before Central held it`);
			}),
		]);
		const competing = await decide('deny', approvalWins.user_code);
		expect(competing.status).toBe(409);
		expect(await competing.json()).toEqual({ error: 'already_deciding' });
		expect(applied).toEqual([]);
		release.resolve();
		expect((await outstanding).status).toBe(200);
		expect(applied).toEqual(sends);
		expect(applied).toHaveLength(1);
		expect(
			await harness.database
				.select({ status: deviceCode.status, claim: deviceCode.decisionClaim })
				.from(deviceCode)
				.where(eq(deviceCode.deviceCode, approvalWins.device_code)),
		).toEqual([{ status: 'approved', claim: null }]);

		const denialWins = await verifiedCode();
		expect((await decide('deny', denialWins.user_code)).status).toBe(200);
		const refused = await decide('approve', denialWins.user_code);
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: 'already_decided' });
		expect(sends).toHaveLength(1);
		expect(applied).toHaveLength(1);
	} finally {
		release.resolve();
		await outstanding?.catch(() => undefined);
		await harness.close();
	}
});

it('recovers the stored approval after the answer is lost and its workspace is archived', async (): Promise<void> => {
	const routerClientId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000096');
	const machineId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000097');
	const enrollmentId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000098');
	const workspaceId = uuid7Schema.parse('019a3dce-2000-7000-8000-000000000099');
	const committed = Promise.withResolvers<void>();
	const releaseLostReply = Promise.withResolvers<void>();
	const submitted: z.infer<typeof decideDeviceLoginSchema>[] = [];
	let effects = 0;
	const decision = {
		result: 'approved',
		enrollmentId,
		label: 'Recovery Mac',
		allowedWorkspaces: [workspaceId],
	};
	const harness = await startLocalAuthHarness({
		turnstileSecret: 'published-test',
		machineLogin: {
			routerClientId,
			machineAudience: 'https://central.example.invalid/machine',
		},
		async machineDecisions(request): Promise<Response> {
			switch (new URL(request.url).pathname) {
				case '/internal/device-login-decisions': {
					const approval = decideDeviceLoginSchema.parse(await request.json());
					const saved = submitted[0];
					submitted.push(approval);
					if (saved === undefined) {
						effects += 1;
						committed.resolve();
						await releaseLostReply.promise;
						return new Response(null, { status: 502 });
					}
					expect(approval).toEqual(saved);
					return Response.json(decision);
				}
				case '/internal/machine-token-decisions': {
					const now = Math.floor(controlledSignInClock.now() / 1000);
					return Response.json({
						result: 'grant',
						machineId,
						enrollmentId,
						decidedAt: now,
						grantExpiresAt: now + 3600,
					});
				}
				default:
					return new Response(null, { status: 404 });
			}
		},
	});
	let first: Promise<Response> | undefined;
	try {
		harness.centralProvisioning.replyWith('provisioned');
		harness.centralProvisioning.replyToPushesWith('acknowledge');
		const { organization_id: organizationId } = z
			.object({ organization_id: z.uuidv7() })
			.parse(decodeJwt(await harness.ownerToken()));
		await harness.settleDeferredWork();
		const workspace = { workspaceId, name: 'Original workspace', description: '' };
		harness.centralAdmin.scriptNextAnswer('ListWorkspaces', () => ({
			result: 'workspaces',
			workspaces: [{ ...workspace, state: 'active' }],
			next: null,
		}));
		const start = await harness.auth('/api/auth/device/code', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '' },
			body: new URLSearchParams({
				client_id: routerClientId,
				machine_id: machineId,
				machine_label: 'Recovery Mac',
				organization_id: organizationId,
			}),
		});
		expect(start.status).toBe(200);
		const { user_code: userCode, device_code: deviceCodeValue } = z
			.object({ user_code: z.string(), device_code: z.string() })
			.parse(await start.json());
		const query = `?user_code=${encodeURIComponent(userCode)}`;
		expect((await harness.auth(`/api/auth/device${query}`)).status).toBe(200);
		function decide(
			action: 'approve' | 'deny',
			allowedWorkspaces: readonly string[] = [workspaceId],
		): Promise<Response> {
			return harness.auth(`/api/auth/machine-login/${action}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: harness.issuer },
				body: JSON.stringify({ userCode, ...(action === 'approve' ? { allowedWorkspaces } : {}) }),
			});
		}
		async function assertDenyHeld(): Promise<void> {
			const deny = await decide('deny');
			expect(deny.status).toBe(409);
			expect(await deny.json()).toEqual({ error: 'already_deciding' });
		}
		first = decide('approve');
		await Promise.race([
			committed.promise,
			first.then((response) => {
				throw new Error(`Approve returned ${response.status} before Central recorded the decision`);
			}),
		]);
		expect(submitted[0]).toMatchObject({ allowedWorkspaces: [workspaceId], label: 'Recovery Mac' });
		await assertDenyHeld();
		releaseLostReply.resolve();
		expect((await first).status).toBe(503);
		harness.centralAdmin.scriptNextAnswer('ListWorkspaces', () => ({
			result: 'workspaces',
			workspaces: [{ ...workspace, state: 'archived' }],
			next: null,
		}));
		await assertDenyHeld();
		const page = await harness.auth(`/device${query}`);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain('data-device-page-state="recovering"');
		expect(html).toContain('Approval in progress');
		expect(html).toContain('Retry approval');
		expect(html).not.toContain('Workspaces this machine can use');
		const changed = await decide('approve', []);
		expect([changed.status, await changed.json()]).toEqual([
			409,
			{ error: 'access_denied', reason: { kind: 'requestConflict' } },
		]);
		expect(submitted).toHaveLength(1);
		const retry = await decide('approve');
		expect([retry.status, await retry.json()]).toEqual([
			200,
			{ enrollmentId, label: decision.label, allowedWorkspaces: [workspaceId] },
		]);
		expect(
			harness.centralAdmin.arrivals.filter(({ route }) => route === 'ListWorkspaces'),
		).toHaveLength(1);
		expect(submitted).toHaveLength(2);
		expect(effects).toBe(1);
		expect((await decide('deny')).status).toBe(409);
		const poll = await harness.auth('/api/auth/oauth2/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '' },
			body: new URLSearchParams({
				client_id: routerClientId,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: deviceCodeValue,
			}),
		});
		expect(poll.status).toBe(200);
		expect(machineTokenResponseSchema.parse(await poll.json()).machine_client_id).toBe(
			enrollmentId,
		);
		expect(poll.headers.has('set-cookie')).toBe(false);
		expect(
			await harness.database
				.select()
				.from(deviceCode)
				.where(eq(deviceCode.deviceCode, deviceCodeValue)),
		).toEqual([]);
	} finally {
		releaseLostReply.resolve();
		await first?.catch(() => undefined);
		await harness.close();
	}
});
