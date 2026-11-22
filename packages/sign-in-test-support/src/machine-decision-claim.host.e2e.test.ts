import { deviceCode, uuid7Schema } from '@agent-collaboration/sign-in-core';
import { decideDeviceLoginSchema } from '@agent-collaboration/sign-in-core/better-auth';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
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
			fleetCentral: {
				receiver: uuid7Schema.parse('019a3dce-2000-7000-8000-000000000094'),
				relay: uuid7Schema.parse('019a3dce-2000-7000-8000-000000000095'),
			},
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
