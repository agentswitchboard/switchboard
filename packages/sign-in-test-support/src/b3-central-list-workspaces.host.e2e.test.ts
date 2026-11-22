import {
	deviceCode,
	epochMillisecondsSchema,
	uuid7Schema,
} from '@agent-collaboration/sign-in-core';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startLinkFaultProxy,
	type LinkFaultEvent,
	type LinkReply,
} from '#sign-in-test-support/test-fixtures/b2e/link-fault-proxy';
import {
	centralProductionWorkers,
	deviceDecisionPath,
	workspaceListPath,
	type ObservedCentralReply,
} from '#sign-in-test-support/test-fixtures/b3-central-production-workers';
import {
	b3CentralTrust,
	startB3CentralTokio,
} from '#sign-in-test-support/test-fixtures/b3-central-tokio';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';
import { ensureLocalOwnerOrganization } from '#sign-in-test-support/test-fixtures/local-owner-organization';
import { signInConfirmedPeopleBrowser } from '#sign-in-test-support/test-fixtures/people-browser-login';

useControlledSignInClock();

const centralExecutable = process.env.B3_CENTRAL_SERVE;
const centralWorkerCheckout = process.env.B3_CENTRAL_WORKER_CHECKOUT;
const workerd = process.env.SIGN_IN_TEST_HOST === 'cloudflare';
const centralArtifact = workerd ? centralWorkerCheckout : centralExecutable;
const routerClientId = uuid7Schema.parse('019f0000-0000-7000-8000-00000000d230');
const machineId = uuid7Schema.parse('019f0000-0000-7000-8000-00000000d231');
const unavailableWorkspace = uuid7Schema.parse('019f0000-0000-7000-8000-00000000d232');

it.runIf(centralArtifact !== undefined)(
	'lists both production Central workspace pages and preserves the original approval across replays',
	async (): Promise<void> => {
		if (centralArtifact === undefined) throw new Error('Missing pinned Central artifact');
		let authenticatorTime = controlledSignInClock.now();
		const workerReplies: ObservedCentralReply[] = [];
		let nodePages: readonly LinkReply[] = [];
		let nodeDecisions: readonly LinkReply[] = [];
		let nodeEvents: readonly LinkFaultEvent[] = [];
		function observedPaths(): readonly string[] {
			return workerd
				? workerReplies.map(({ path }) => path)
				: nodeEvents.flatMap((event) =>
						event.kind === 'forwarded' &&
						(event.path === workspaceListPath || event.path === deviceDecisionPath)
							? [event.path]
							: [],
					);
		}
		const harness = await startLocalAuthHarness({
			host: workerd ? 'cloudflare' : 'node',
			turnstileSecret: 'published-test',
			authenticatorClock: { now: () => authenticatorTime },
			machineLogin: {
				routerClientId,
				machineAudience: 'https://central.example.invalid/machine',
			},
			...(workerd
				? {
						workerdCentral: (issuer: string) =>
							centralProductionWorkers({
								checkout: centralArtifact,
								trust: b3CentralTrust(issuer),
								observe(reply): void {
									workerReplies.push(reply);
								},
								async readJwks(): Promise<string> {
									const keys = await fetch(new URL('/api/auth/jwks', issuer));
									if (!keys.ok) throw new Error(`Sign-in JWKS answered ${keys.status}`);
									return keys.text();
								},
							}),
					}
				: {
						async centralLink(issuer: string) {
							const central = await startB3CentralTokio({
								executable: centralArtifact,
								issuer,
								jwksUrl: new URL('/api/auth/jwks', issuer).toString(),
							});
							try {
								const proxy = await startLinkFaultProxy(central.socketPath);
								nodePages = proxy.captureReplies(({ path }) => path === workspaceListPath);
								nodeDecisions = proxy.captureReplies(({ path }) => path === deviceDecisionPath);
								nodeEvents = proxy.events;
								return {
									socketPath: proxy.socketPath,
									async close(): Promise<void> {
										try {
											await proxy.close();
										} finally {
											await central.close();
										}
									},
								};
							} catch (error) {
								await central.close();
								throw error;
							}
						},
					}),
		});
		try {
			// The production providers own their native clocks. Align the Sign-in proof clock
			// with the loopback HTTP server before any person token or proof is issued.
			const clockSample = await fetch(harness.issuer);
			await clockSample.body?.cancel();
			authenticatorTime = epochMillisecondsSchema.parse(
				Date.parse(clockSample.headers.get('date') ?? ''),
			);
			const clock = await harness.auth('/__auth-proof/set-clock', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ milliseconds: authenticatorTime }),
			});
			expect(clock.status).toBe(200);
			await signInConfirmedPeopleBrowser({ harness, email: 'owner@example.invalid' });
			const organizationId = await ensureLocalOwnerOrganization({
				auth: harness.auth,
				database: harness.database,
			});
			const bootstrap = await harness.auth('/api/auth/owner/bootstrap', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			});
			expect(bootstrap.status).toBe(200);
			await harness.settleDeferredWork();

			const workspaceIds = createWebSignInCapabilities({
				now: () => epochMillisecondsSchema.parse(authenticatorTime),
			}).ids;
			const seeded = [];
			for (let index = 0; index < 101; index += 1) {
				const operationId = workspaceIds.nextId();
				const name = `Joint page workspace ${String(index).padStart(3, '0')}`;
				const created = await harness.authAsBrowser(
					`workspace-seed-${Math.floor(index / 10)}`,
					'/api/auth/organization-admin/create-workspace',
					{
						method: 'POST',
						headers: { 'content-type': 'application/json', origin: harness.issuer },
						body: JSON.stringify({ organizationId, operationId, name, description: '' }),
					},
				);
				const result: unknown = await created.json();
				expect([created.status, result]).toEqual([
					200,
					{
						result: 'applied',
						workspace: { workspaceId: operationId, name, description: '', state: 'active' },
					},
				]);
				seeded.push({ workspaceId: operationId, name });
			}
			const sorted = seeded.toSorted((left, right) =>
				left.workspaceId.localeCompare(right.workspaceId),
			);
			const cursor = sorted[99]?.workspaceId;
			const last = sorted[100];
			const first = sorted[0];
			if (cursor === undefined || last === undefined || first === undefined)
				throw new Error('Expected two seeded workspace pages');

			const start = await harness.auth('/api/auth/device/code', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '' },
				body: new URLSearchParams({
					client_id: routerClientId,
					machine_id: machineId,
					machine_label: 'Joint paging Mac',
					organization_id: organizationId,
				}),
			});
			expect(start.status).toBe(200);
			const { user_code: userCode } = z.object({ user_code: z.string() }).parse(await start.json());
			const page = await harness.auth(`/device?user_code=${encodeURIComponent(userCode)}`);
			expect(page.status).toBe(200);
			const html = await page.text();
			expect(html).toContain('data-device-page-state="review"');
			for (const { workspaceId } of seeded) expect(html).toContain(`id="workspace-${workspaceId}"`);
			expect(observedPaths()).toEqual([workspaceListPath, workspaceListPath]);

			function approve(workspaceId: string): Promise<Response> {
				return harness.auth('/api/auth/machine-login/approve', {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: harness.issuer },
					body: JSON.stringify({ userCode, allowedWorkspaces: [workspaceId] }),
				});
			}
			const refused = await approve(unavailableWorkspace);
			expect(refused.status).toBe(403);
			expect(await refused.json()).toEqual({
				error: 'access_denied',
				reason: { kind: 'unknownWorkspace' },
			});
			expect(observedPaths().slice(2)).toEqual([workspaceListPath, workspaceListPath]);
			const approved = await approve(last.workspaceId);
			expect(approved.status).toBe(200);
			const approval = z
				.strictObject({
					enrollmentId: z.uuidv7(),
					label: z.literal('Joint paging Mac'),
					allowedWorkspaces: z.tuple([z.literal(last.workspaceId)]),
				})
				.parse(await approved.json());
			expect(observedPaths().slice(4)).toEqual([
				workspaceListPath,
				workspaceListPath,
				deviceDecisionPath,
			]);
			const pages = workerd
				? workerReplies.filter(({ path }) => path === workspaceListPath)
				: nodePages;
			const pageBody = z.object({ workspaces: z.array(z.unknown()), next: z.uuidv7().nullable() });
			const pageSummaries = pages.map(({ status, body }) => {
				const listed = pageBody.parse(body);
				return [status, listed.workspaces.length, listed.next];
			});
			const paging = [
				[200, 100, cursor],
				[200, 1, null],
			];
			expect(pageSummaries).toEqual([...paging, ...paging, ...paging]);

			const changePage = z.object({
				result: z.literal('records'),
				records: z.array(z.looseObject({ id: z.uuidv7(), kind: z.string() })),
			});
			async function readChanges(
				after: string | null,
			): Promise<z.infer<typeof changePage>['records']> {
				const response = await harness.auth('/api/auth/organization-admin/change-records', {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: harness.issuer },
					body: JSON.stringify({ organizationId, after, limit: 100 }),
				});
				expect(response.status).toBe(200);
				return changePage.parse(await response.json()).records;
			}
			async function readApprovalEffects(): Promise<unknown> {
				const initial = await readChanges(null);
				expect(initial).toHaveLength(100);
				const nextCursor = initial.at(-1)?.id;
				if (nextCursor === undefined) throw new Error('Expected a full first change page');
				const rest = await readChanges(nextCursor);
				expect(rest.length).toBeGreaterThan(0);
				expect(rest.length).toBeLessThan(100);
				const records = [...initial, ...rest];
				expect(records.filter(({ kind }) => kind === 'workspaceCreated')).toHaveLength(101);
				// Approval stores the pending enrollment; token activation records machineEnrolled.
				expect(records.some(({ kind }) => kind === 'machineEnrolled')).toBe(false);
				const localCode = await harness.database
					.select({
						id: deviceCode.id,
						status: deviceCode.status,
						enrollmentId: deviceCode.enrollmentId,
						decisionClaim: deviceCode.decisionClaim,
						userId: deviceCode.userId,
						machineId: deviceCode.machineId,
					})
					.from(deviceCode)
					.where(eq(deviceCode.userCode, userCode));
				expect(localCode).toMatchObject([
					{ status: 'approved', enrollmentId: approval.enrollmentId, machineId },
				]);
				return { records, localCode };
			}

			const effects = await readApprovalEffects();
			const conflict = await approve(first.workspaceId);
			expect([conflict.status, await conflict.json()]).toEqual([
				409,
				{ error: 'access_denied', reason: { kind: 'requestConflict' } },
			]);
			expect(await readApprovalEffects()).toEqual(effects);

			const replay = await approve(last.workspaceId);
			expect([replay.status, await replay.json()]).toEqual([200, approval]);
			expect(await readApprovalEffects()).toEqual(effects);
			const approvedByCentral = { result: 'approved', ...approval };
			const decisions = workerd
				? workerReplies.filter(({ path }) => path === deviceDecisionPath)
				: nodeDecisions;
			expect(decisions.map(({ status, body }) => [status, body])).toEqual([
				[200, approvedByCentral],
				[200, { result: 'refused', reason: { kind: 'requestConflict' } }],
				[200, approvedByCentral],
			]);
			expect(observedPaths().slice(7)).toEqual([deviceDecisionPath, deviceDecisionPath]);
		} finally {
			await harness.close();
		}
	},
);
