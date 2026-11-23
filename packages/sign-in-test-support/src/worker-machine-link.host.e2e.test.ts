import { expect, it } from 'vitest';
import { z } from 'zod';

import { workerMachineLinkFamily } from '#sign-in-test-support/fuzz/request-families/worker-machine-link';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	organizationOne,
	startLocalAuthHarness,
} from '#sign-in-test-support/test-fixtures/local-auth-harness';

useControlledSignInClock();

it.skipIf(process.env.SIGN_IN_TEST_HOST === 'node')(
	'workerd sends machine upgrades only to CENTRAL_LINK and provisioning only to CENTRAL',
	async (): Promise<void> => {
		const harness = await startLocalAuthHarness({
			host: 'cloudflare',
			turnstileSecret: 'published-test',
			machineLinkStorageWorker: {
				config: {
					type: 'worker',
					name: 'central-storage-fixture',
					compatibilityDate: '2026-08-15',
					manifest: {
						mainModule: 'machine-link.mjs',
						modules: {
							'machine-link.mjs': {
								type: 'esm',
								contents: `
									const arrivals = [];
									export default {
										fetch(request) {
											const pathname = new URL(request.url).pathname;
											if (pathname === '/test-arrivals') return Response.json(arrivals);
											arrivals.push({ pathname, upgrade: request.headers.get('upgrade') });
											return new Response('storage-worker-refusal', { status: 401 });
										}
									};
								`,
							},
						},
					},
				},
			},
		});
		try {
			const storage = await harness.miniflare.getWorker('central-storage-fixture');
			const arrivalsSchema = z.array(
				z.strictObject({ pathname: z.string(), upgrade: z.string().nullable() }),
			);
			const arrivals = async (): Promise<z.infer<typeof arrivalsSchema>> =>
				arrivalsSchema.parse(
					await (await storage.fetch('https://fixture.invalid/test-arrivals')).json(),
				);
			harness.centralProvisioning.replyWith('provisioned');
			await harness.ownerToken();
			await harness.settleDeferredWork();
			expect(harness.centralProvisioning.arrivals).toContainEqual(
				expect.objectContaining({ method: 'POST', path: '/internal/organization-provisioning' }),
			);
			expect(await arrivals()).toEqual([]);

			const worker = await harness.miniflare.getWorker('sign-in');
			const publicLink = new URL(`/api/fleet/link/${organizationOne}`, harness.issuer);
			const beforeUpgrade = harness.centralProvisioning.arrivals.length;
			await Promise.all(
				workerMachineLinkFamily.variants.map(async (variant): Promise<void> => {
					const fixture = workerMachineLinkFamily.generate(organizationOne, variant);
					const answer = await worker.fetch(new URL(fixture.pathname, harness.issuer).toString(), {
						...fixture.init,
						headers: Object.fromEntries(fixture.init.headers),
					});
					expect(answer.status, variant).toBe(fixture.status);
					await answer.body?.cancel();
				}),
			);
			expect(await arrivals()).toEqual([]);
			expect(harness.centralProvisioning.arrivals).toHaveLength(beforeUpgrade);
			const answer = await worker.fetch(publicLink.toString(), {
				headers: { upgrade: 'websocket', authorization: 'Bearer fixture-only-machine-token' },
			});
			expect(answer.status).toBe(401);
			expect(await answer.text()).toBe('storage-worker-refusal');
			expect(harness.centralProvisioning.arrivals).toHaveLength(beforeUpgrade);

			expect(await arrivals()).toEqual([
				{ pathname: `/v1/organizations/${organizationOne}/link`, upgrade: 'websocket' },
			]);
		} finally {
			await harness.close();
		}
	},
);
