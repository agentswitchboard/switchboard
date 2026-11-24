import { createHash } from 'node:crypto';
import { chmod, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
	epochMillisecondsSchema,
	member,
	organization,
	organizationAuthorizationRevisions,
	personOrganizationAuthorizationRevisions,
	user,
	runAuthorizationRevisionDrain,
} from '@agent-collaboration/sign-in-core';
import {
	createOrganizationFleetCallGuard,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import { afterAll, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { openNodeSignInDatabase } from '#sign-in-host-node/sign-in-database';
import { startNodeSignInHost } from '#sign-in-host-node/sign-in-node-host';

/** What a committed fence change's after-response hint runs; no timer runs it (owner, 12 Nov). */
async function drainLikeTheHint(configuration: SignInHttpConfiguration): Promise<void> {
	await runAuthorizationRevisionDrain({
		...configuration,
		prepareFleetCall: createOrganizationFleetCallGuard(configuration),
	});
}

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(2_208_988_800_000);
afterAll(() => vi.useRealTimers());

it('starts the production composition with migrated SQLite, serves the real provider JWKS over TCP and renews a due stamp only on a Fleet call', async () => {
	const output: string[] = [];
	const drainSummaries: number[] = [];
	const drainSummaryArrived: (() => void)[] = [];
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-10-sign-in-node-host-'));
	await chmod(stateDirectory, 0o700);
	const centralSocketPath = path.join(stateDirectory, 'central.sock');
	// Before a ready organization exists the peer is unavailable; afterwards it holds one due stamp.
	const dueOrganizationId = '019a3dce-2000-7000-8000-0000000000d1';
	const heldDigest = 'e'.repeat(64);
	let centralCalls = 0;
	let heldStampKeyId: string | undefined;
	const centralSends: { readonly path: string; readonly body: unknown }[] = [];
	const central = createServer((request, response): void => {
		centralCalls += 1;
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer): void => {
			chunks.push(chunk);
		});
		request.on('end', (): void => {
			const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
			centralSends.push({ path: request.url ?? '', body });
			if (heldStampKeyId === undefined) {
				response.writeHead(503).end();
			} else if (request.url === '/internal/organization-statement-digest') {
				response.writeHead(200, { 'content-type': 'application/json' }).end(
					JSON.stringify({
						digest: heldDigest,
						// Exactly 60 days left at the controlled clock: due.
						expiresAt: 2_208_988_800 + 5_184_000,
						signingKeyId: heldStampKeyId,
					}),
				);
			} else if (request.url === '/internal/organization-authorization-revisions') {
				const push = z.object({ revision: z.number() }).parse(body);
				response
					.writeHead(200, { 'content-type': 'application/json' })
					.end(JSON.stringify({ acknowledgedRevision: push.revision }));
			} else {
				response
					.writeHead(200, { 'content-type': 'application/json' })
					.end(JSON.stringify({ result: 'provisioned' }));
			}
		});
	});
	await new Promise<void>((resolveListen, rejectListen): void => {
		central.once('error', rejectListen);
		central.listen(centralSocketPath, resolveListen);
	});
	async function closeCentral(): Promise<void> {
		await new Promise<void>((resolveClose): void => {
			central.close((): void => resolveClose());
			central.closeAllConnections();
		});
	}
	// Every interval the host registers from here on: the host must register none.
	const intervalSpy = vi.spyOn(globalThis, 'setInterval');
	const intervalsStarted = (): readonly unknown[] => intervalSpy.mock.calls.map((call) => call[1]);
	const started = await startNodeSignInHost({
		settings: {
			stateDirectory,
			centralSocketPath,
			port: 0,
			configuration: {
				issuer: 'http://localhost:9000',
				turnstile: { kind: 'local', siteKey: 'fixture-site-key' },
				mode: 'private',
				ownerEmail: 'owner@example.invalid',
				toolPortalOrigin: 'https://portal.invalid',
				managementAudience: 'https://portal.invalid/management',
				centralIdentityAudience: 'https://central.example.invalid/identity',
				centralAdminAudience: 'https://central.example.invalid/admin',
				centralPublicOrigin: 'https://central.example.invalid',
				adminPageClientId: 'admin-page-local',
				ownerFleetCliClientId: 'owner-fleet-cli-local',
				organizationStatementLifetimeSeconds: 10_368_000,
				organizationIds: ['11111111-1111-7111-8111-111111111111'],
				ownerCliClientId: 'owner-cli-local',
				ownerCliRedirectUri: 'http://127.0.0.1/callback',
			},
			secret: 'test-only-secret-'.repeat(3),
			google: { clientId: 'google-test', clientSecret: 'google-secret' },
			github: { clientId: 'github-test', clientSecret: 'github-secret' },
		},
		clock: { now: () => epochMillisecondsSchema.parse(2_208_988_800_000) },
		output: new Writable({
			write(chunk: Buffer, _encoding, callback): void {
				const line = chunk.toString();
				output.push(line);
				const parsed = z
					.object({
						properties: z.object({
							kind: z.literal('authorization-drain-summary'),
							acknowledged: z.number(),
						}),
					})
					.safeParse(JSON.parse(line));
				if (parsed.success) {
					drainSummaries.push(parsed.data.properties.acknowledged);
					drainSummaryArrived.shift()?.();
				}
				callback();
			},
		}),
	});
	if (started.kind !== 'started') {
		await closeCentral();
		throw new Error(`Host setup failed: ${started.reason}`);
	}
	const nextDrainSummary = async (count: number): Promise<void> => {
		if (drainSummaries.length >= count) return;
		const arrived = Promise.withResolvers<void>();
		drainSummaryArrived.push(arrived.resolve);
		await arrived.promise;
		await nextDrainSummary(count);
	};
	try {
		const response = await fetch(new URL('/api/auth/jwks', started.host.address));
		expect(response.status).toBe(200);
		const keys = z
			.object({
				keys: z
					.array(z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), kid: z.uuidv7() }))
					.min(1),
			})
			.parse(await response.json());
		expect(keys.keys).toHaveLength(1);
		const privateResponses = await Promise.all(
			['/rpc/disable', '/__auth-proof/node-management'].map((pathname) =>
				fetch(new URL(pathname, started.host.address)),
			),
		);
		for (const privateResponse of privateResponses) expect(privateResponse.status).toBe(404);
		// JWKS, refused public requests and startup must not provision or renew anything.
		expect(centralCalls).toBe(0);
		expect(output.join('')).toContain('listener-started');
		// The host starts no timer: no renewal, drain or backfill interval (owner, 9 and 12 Nov).
		expect(intervalsStarted()).toEqual([]);
		// Arrange a Fleet call: one ready organization, due at central, with a pending fence.
		const database = started.host.configuration.openDatabase();
		await database.insert(organization).values({
			id: dueOrganizationId,
			name: 'Renewal proof',
			slug: 'renewal-proof',
			createdAt: new Date(2_208_988_800_000),
			fleetState: 'ready',
		});
		await database.insert(organizationAuthorizationRevisions).values({
			id: dueOrganizationId,
			revision: 1,
			state: 'active',
			permissionPolicyDigest: 'a'.repeat(64),
			nextAttemptAt: 2_208_988_800_000,
			createdAt: 2_208_988_800_000,
			updatedAt: 2_208_988_800_000,
		});
		heldStampKeyId = keys.keys[0]?.kid;
		// Act: the drain pushes; its guard runs first.
		await drainLikeTheHint(started.host.configuration);
		await nextDrainSummary(1);
		// Assert: seed from central's digest, renew naming it, then the original push.
		expect(centralSends.map((send) => send.path)).toEqual([
			'/internal/organization-statement-digest',
			'/internal/organization-provisioning',
			'/internal/organization-authorization-revisions',
		]);
		expect(centralSends[0]?.body).toEqual({ organizationId: dueOrganizationId });
		const replacement = z
			.object({ organizationId: z.literal(dueOrganizationId), organizationStatement: z.string() })
			.parse(centralSends[1]?.body);
		const claims = z
			.object({ sub: z.string(), iat: z.number(), exp: z.number(), replaces: z.string() })
			.parse(
				JSON.parse(
					Buffer.from(replacement.organizationStatement.split('.')[1] ?? '', 'base64url').toString(
						'utf8',
					),
				),
			);
		expect(claims).toEqual({
			sub: dueOrganizationId,
			iat: 2_208_988_800,
			exp: 2_208_988_800 + 10_368_000,
			replaces: heldDigest,
		});
		expect(drainSummaries).toEqual([1]);
		const record = await database
			.select({
				digest: organization.fleetStampDigest,
				expiresAt: organization.fleetStampExpiresAt,
				sent: organization.fleetStampSent,
				renewedAt: organization.fleetStampRenewedAt,
			})
			.from(organization);
		expect(record).toEqual([
			{
				digest: createHash('sha256').update(replacement.organizationStatement).digest('hex'),
				expiresAt: 2_208_988_800 + 10_368_000,
				sent: null,
				renewedAt: new Date(2_208_988_800_000),
			},
		]);
	} finally {
		await started.host.close();
		await closeCentral();
		intervalSpy.mockRestore();
	}
	// After close: the listener stopped, and no provider secret, account or path reached the logs.
	const emitted = output.join('');
	expect(emitted).toContain('listener-stopped');
	for (const secret of [
		'google-secret',
		'github-secret',
		'/api/auth/jwks',
		'owner@example.invalid',
	])
		expect(emitted).not.toContain(secret);
});

it('rejects malformed settings as a value before starting a listener', async () => {
	expect(await startNodeSignInHost({ settings: { port: 'invalid' } })).toEqual({
		kind: 'unavailable',
		reason: 'invalid-configuration',
	});
});

it('startup gives a store populated before the fence tables its fences before the listener serves', async () => {
	// Arrange: a migrated store holding an organization and membership but no fences.
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-11-sign-in-node-backfill-'));
	await chmod(stateDirectory, 0o700);
	const seeded = await openNodeSignInDatabase({ stateDirectory });
	if (seeded.kind !== 'available') throw new Error('Seed database did not open');
	const organizationId = '019a3dce-2000-7000-8000-0000000000b1';
	const personId = '019a3dce-2000-7000-8000-0000000000b2';
	const seededAt = new Date(2_208_988_800_000);
	const database = seeded.database.openDatabase();
	await database.insert(user).values({
		id: personId,
		name: 'Existing person',
		email: 'existing@example.invalid',
		emailVerified: true,
		createdAt: seededAt,
		updatedAt: seededAt,
	});
	await database.insert(organization).values({
		id: organizationId,
		name: 'Existing organization',
		slug: 'existing-organization',
		createdAt: seededAt,
		fleetState: 'ready',
	});
	await database.insert(member).values({
		id: '019a3dce-2000-7000-8000-0000000000b3',
		organizationId,
		userId: personId,
		role: 'owner',
		createdAt: seededAt,
	});
	seeded.database.close();
	const centralSocketPath = path.join(stateDirectory, 'central.sock');
	const central = createServer((_request, response): void => {
		response.writeHead(503).end();
	});
	await new Promise<void>((resolveListen, rejectListen): void => {
		central.once('error', rejectListen);
		central.listen(centralSocketPath, resolveListen);
	});
	const output: string[] = [];
	// Act
	const started = await startNodeSignInHost({
		settings: {
			stateDirectory,
			centralSocketPath,
			port: 0,
			configuration: {
				issuer: 'http://localhost:9000',
				turnstile: { kind: 'local', siteKey: 'fixture-site-key' },
				mode: 'private',
				ownerEmail: 'owner@example.invalid',
				toolPortalOrigin: 'https://portal.invalid',
				managementAudience: 'https://portal.invalid/management',
				centralIdentityAudience: 'https://central.example.invalid/identity',
				centralAdminAudience: 'https://central.example.invalid/admin',
				centralPublicOrigin: 'https://central.example.invalid',
				adminPageClientId: 'admin-page-local',
				ownerFleetCliClientId: 'owner-fleet-cli-local',
				organizationStatementLifetimeSeconds: 10_368_000,
				organizationIds: ['11111111-1111-7111-8111-111111111111'],
				ownerCliClientId: 'owner-cli-local',
				ownerCliRedirectUri: 'http://127.0.0.1/callback',
			},
			secret: 'test-only-secret-'.repeat(3),
			google: { clientId: 'google-test', clientSecret: 'google-secret' },
			github: { clientId: 'github-test', clientSecret: 'github-secret' },
		},
		clock: { now: () => epochMillisecondsSchema.parse(2_208_988_800_000) },
		output: new Writable({
			write(chunk: Buffer, _encoding, callback): void {
				output.push(chunk.toString());
				callback();
			},
		}),
	});
	try {
		if (started.kind !== 'started') throw new Error(`Host setup failed: ${started.reason}`);
		// Assert: the backfill completed, with its counts, before the listener started.
		const events = output.map((line) =>
			z
				.object({ properties: z.object({ kind: z.string() }).passthrough() })
				.safeParse(JSON.parse(line)),
		);
		const kinds = events.flatMap((event) => (event.success ? [event.data.properties.kind] : []));
		expect(kinds.indexOf('authorization-backfill-complete')).toBeGreaterThanOrEqual(0);
		expect(kinds.indexOf('authorization-backfill-complete')).toBeLessThan(
			kinds.indexOf('listener-started'),
		);
		expect(
			events.flatMap((event) =>
				event.success && event.data.properties.kind === 'authorization-backfill-complete'
					? [event.data.properties]
					: [],
			),
		).toEqual([
			{ kind: 'authorization-backfill-complete', organizationFencesAdded: 1, personPairsAdded: 1 },
		]);
		const fenced = started.host.configuration.openDatabase();
		expect(
			await fenced
				.select({
					id: organizationAuthorizationRevisions.id,
					revision: organizationAuthorizationRevisions.revision,
				})
				.from(organizationAuthorizationRevisions),
		).toEqual([{ id: organizationId, revision: 1 }]);
		expect(
			await fenced
				.select({
					personId: personOrganizationAuthorizationRevisions.personId,
					revision: personOrganizationAuthorizationRevisions.revision,
					state: personOrganizationAuthorizationRevisions.state,
				})
				.from(personOrganizationAuthorizationRevisions),
		).toEqual([{ personId, revision: 1, state: 'active' }]);
	} finally {
		if (started.kind === 'started') await started.host.close();
		await new Promise<void>((resolveClose): void => {
			central.close((): void => resolveClose());
			central.closeAllConnections();
		});
	}
});

it('no timer drains a pending fence: the next Fleet call delivers it, and after a lost ACK the next call delivers it again', async () => {
	// Arrange: a migrated store holding an organization and membership, which startup backfills.
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-11-sign-in-node-drain-'));
	await chmod(stateDirectory, 0o700);
	const seeded = await openNodeSignInDatabase({ stateDirectory });
	if (seeded.kind !== 'available') throw new Error('Seed database did not open');
	const organizationId = '019a3dce-2000-7000-8000-0000000000c1';
	const personId = '019a3dce-2000-7000-8000-0000000000c2';
	const seededAt = new Date(2_208_988_800_000);
	const database = seeded.database.openDatabase();
	await database.insert(user).values({
		id: personId,
		name: 'Drained person',
		email: 'drained@example.invalid',
		emailVerified: true,
		createdAt: seededAt,
		updatedAt: seededAt,
	});
	await database.insert(organization).values({
		id: organizationId,
		name: 'Drained organization',
		slug: 'drained-organization',
		createdAt: seededAt,
		fleetState: 'ready',
	});
	await database.insert(member).values({
		id: '019a3dce-2000-7000-8000-0000000000c3',
		organizationId,
		userId: personId,
		role: 'owner',
		createdAt: seededAt,
	});
	seeded.database.close();
	// The central peer first loses every reply, then acknowledges the retained floor.
	let acknowledge = false;
	const pushedKinds: string[] = [];
	const centralSocketPath = path.join(stateDirectory, 'central.sock');
	const central = createServer((request, response): void => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer): void => {
			chunks.push(chunk);
		});
		request.on('end', (): void => {
			if (request.url !== '/internal/organization-authorization-revisions') {
				response.writeHead(503).end();
				return;
			}
			const push = z
				.object({ kind: z.string(), revision: z.number() })
				.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			pushedKinds.push(push.kind);
			if (!acknowledge) {
				response.destroy();
				return;
			}
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ acknowledgedRevision: push.revision }));
		});
	});
	await new Promise<void>((resolveListen, rejectListen): void => {
		central.once('error', rejectListen);
		central.listen(centralSocketPath, resolveListen);
	});
	let now = 2_208_988_800_000;
	const summaries: { readonly acknowledged: number; readonly deferred: number }[] = [];
	const summaryArrived: (() => void)[] = [];
	const output: string[] = [];
	// Act: production startup, with the drain timer's registration captured.
	const started = await startNodeSignInHost({
		settings: {
			stateDirectory,
			centralSocketPath,
			port: 0,
			configuration: {
				issuer: 'http://localhost:9000',
				turnstile: { kind: 'local', siteKey: 'fixture-site-key' },
				mode: 'private',
				ownerEmail: 'owner@example.invalid',
				toolPortalOrigin: 'https://portal.invalid',
				managementAudience: 'https://portal.invalid/management',
				centralIdentityAudience: 'https://central.example.invalid/identity',
				centralAdminAudience: 'https://central.example.invalid/admin',
				centralPublicOrigin: 'https://central.example.invalid',
				adminPageClientId: 'admin-page-local',
				ownerFleetCliClientId: 'owner-fleet-cli-local',
				organizationStatementLifetimeSeconds: 10_368_000,
				organizationIds: ['11111111-1111-7111-8111-111111111111'],
				ownerCliClientId: 'owner-cli-local',
				ownerCliRedirectUri: 'http://127.0.0.1/callback',
			},
			secret: 'test-only-secret-'.repeat(3),
			google: { clientId: 'google-test', clientSecret: 'google-secret' },
			github: { clientId: 'github-test', clientSecret: 'github-secret' },
		},
		clock: { now: () => epochMillisecondsSchema.parse(now) },
		output: new Writable({
			write(chunk: Buffer, _encoding, callback): void {
				const line = chunk.toString();
				output.push(line);
				const parsed = z
					.object({
						properties: z.object({
							kind: z.literal('authorization-drain-summary'),
							acknowledged: z.number(),
							deferred: z.number(),
						}),
					})
					.safeParse(JSON.parse(line));
				if (parsed.success) {
					summaries.push(parsed.data.properties);
					summaryArrived.shift()?.();
				}
				callback();
			},
		}),
	});
	const nextSummary = async (count: number): Promise<void> => {
		if (summaries.length >= count) return;
		const arrived = Promise.withResolvers<void>();
		summaryArrived.push(arrived.resolve);
		await arrived.promise;
		await nextSummary(count);
	};
	try {
		if (started.kind !== 'started') throw new Error(`Host setup failed: ${started.reason}`);
		// Assert: startup backfilled the fences but pushed nothing; no timer will.
		expect((await fetch(new URL('/api/auth/jwks', started.host.address))).status).toBe(200);
		expect(pushedKinds).toEqual([]);
		// Act: a Fleet call's drain pushes the org row; its reply is lost, so the pair waits.
		await drainLikeTheHint(started.host.configuration);
		await nextSummary(1);
		expect(pushedKinds).toEqual(['organization']);
		expect(summaries[0]).toMatchObject({ acknowledged: 0, deferred: 2 });
		// The row now waits out its retry time, so the hint's drain leaves it alone; the
		// organization's next Fleet call delivers it on use, with no wait, before going out.
		acknowledge = true;
		await drainLikeTheHint(started.host.configuration);
		expect(pushedKinds).toEqual(['organization']);
		const readiness = await createOrganizationFleetCallGuard(started.host.configuration)(
			organizationId,
		);
		// Assert
		expect(readiness).toMatchObject({
			kind: 'ready',
			revisions: { kind: 'delivered', acknowledged: 2, deferred: 0, discrepancies: 0 },
		});
		expect(pushedKinds).toEqual(['organization', 'organization', 'person']);
		const fenced = started.host.configuration.openDatabase();
		expect(
			await fenced
				.select({
					acknowledgedRevision: personOrganizationAuthorizationRevisions.acknowledgedRevision,
				})
				.from(personOrganizationAuthorizationRevisions),
		).toEqual([{ acknowledgedRevision: 1 }]);
		expect(
			await fenced
				.select({ acknowledgedRevision: organizationAuthorizationRevisions.acknowledgedRevision })
				.from(organizationAuthorizationRevisions),
		).toEqual([{ acknowledgedRevision: 1 }]);
	} finally {
		if (started.kind === 'started') await started.host.close();
		await new Promise<void>((resolveClose): void => {
			central.close((): void => resolveClose());
			central.closeAllConnections();
		});
	}
});

it('a renewal the central peer never answers ends at the injected deadline: the request is aborted, the spent budget leaves both pending pushes unsent (Q2), and the next drain re-sends the same bytes and delivers both', async () => {
	// Arrange: two ready organizations due at central with pending fences; one stamp is still
	// valid, one has expired. The peer holds every renewal until told otherwise and never replies.
	const now = 2_208_988_800_000;
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-11-sign-in-node-deadline-'));
	await chmod(stateDirectory, 0o700);
	const centralSocketPath = path.join(stateDirectory, 'central.sock');
	const validOrganizationId = '019a3dce-2000-7000-8000-0000000000e1';
	const expiredOrganizationId = '019a3dce-2000-7000-8000-0000000000e2';
	const deadlineStarts: number[] = [];
	const running = new Set<AbortController>();
	const fireDeadlines = (): void => {
		for (const controller of running)
			controller.abort(new DOMException('Deadline reached', 'TimeoutError'));
		running.clear();
	};
	let holdRenewals = true;
	let stampKeyId = 'retired-native-key';
	const heldStatements: { readonly organizationId: string; readonly statement: string }[] = [];
	const observedAborts: string[] = [];
	const answeredStatements: string[] = [];
	const pushedOrganizations: string[] = [];
	const central = createServer((request, response): void => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer): void => {
			chunks.push(chunk);
		});
		request.on('end', (): void => {
			const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
			if (request.url === '/internal/organization-statement-digest') {
				const { organizationId } = z.object({ organizationId: z.string() }).parse(body);
				response.writeHead(200, { 'content-type': 'application/json' }).end(
					JSON.stringify({
						digest: (organizationId === validOrganizationId ? 'a' : 'b').repeat(64),
						// The valid stamp has 59 days left (due); the expired one ended a second ago.
						expiresAt:
							organizationId === validOrganizationId ? now / 1000 + 59 * 86_400 : now / 1000 - 1,
						signingKeyId: stampKeyId,
					}),
				);
				return;
			}
			if (request.url === '/internal/organization-provisioning') {
				const send = z
					.object({ organizationId: z.string(), organizationStatement: z.string() })
					.parse(body);
				if (holdRenewals) {
					heldStatements.push({
						organizationId: send.organizationId,
						statement: send.organizationStatement,
					});
					// The client's abort reaches the peer as a closed request with no response sent.
					response.on('close', (): void => {
						if (!response.writableEnded) observedAborts.push(send.organizationId);
					});
					fireDeadlines();
					return;
				}
				answeredStatements.push(send.organizationStatement);
				response
					.writeHead(200, { 'content-type': 'application/json' })
					.end(JSON.stringify({ result: 'provisioned' }));
				return;
			}
			const push = z.object({ organizationId: z.string(), revision: z.number() }).parse(body);
			pushedOrganizations.push(push.organizationId);
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify({ acknowledgedRevision: push.revision }));
		});
	});
	await new Promise<void>((resolveListen, rejectListen): void => {
		central.once('error', rejectListen);
		central.listen(centralSocketPath, resolveListen);
	});
	const summaries: { readonly acknowledged: number; readonly deferred: number }[] = [];
	const summaryArrived: (() => void)[] = [];
	const started = await startNodeSignInHost({
		deadlines: {
			start(milliseconds) {
				deadlineStarts.push(milliseconds);
				const controller = new AbortController();
				running.add(controller);
				return { signal: controller.signal, cancel: () => running.delete(controller) };
			},
		},
		settings: {
			stateDirectory,
			centralSocketPath,
			port: 0,
			configuration: {
				issuer: 'http://localhost:9000',
				turnstile: { kind: 'local', siteKey: 'fixture-site-key' },
				mode: 'private',
				ownerEmail: 'owner@example.invalid',
				toolPortalOrigin: 'https://portal.invalid',
				managementAudience: 'https://portal.invalid/management',
				centralIdentityAudience: 'https://central.example.invalid/identity',
				centralAdminAudience: 'https://central.example.invalid/admin',
				centralPublicOrigin: 'https://central.example.invalid',
				adminPageClientId: 'admin-page-local',
				ownerFleetCliClientId: 'owner-fleet-cli-local',
				organizationStatementLifetimeSeconds: 10_368_000,
				organizationIds: ['11111111-1111-7111-8111-111111111111'],
				ownerCliClientId: 'owner-cli-local',
				ownerCliRedirectUri: 'http://127.0.0.1/callback',
			},
			secret: 'test-only-secret-'.repeat(3),
			google: { clientId: 'google-test', clientSecret: 'google-secret' },
			github: { clientId: 'github-test', clientSecret: 'github-secret' },
		},
		clock: { now: () => epochMillisecondsSchema.parse(now) },
		output: new Writable({
			write(chunk: Buffer, _encoding, callback): void {
				const parsed = z
					.object({
						properties: z.object({
							kind: z.literal('authorization-drain-summary'),
							acknowledged: z.number(),
							deferred: z.number(),
						}),
					})
					.safeParse(JSON.parse(chunk.toString()));
				if (parsed.success) {
					summaries.push(parsed.data.properties);
					summaryArrived.shift()?.();
				}
				callback();
			},
		}),
	});
	const nextSummary = async (count: number): Promise<void> => {
		if (summaries.length >= count) return;
		const arrived = Promise.withResolvers<void>();
		summaryArrived.push(arrived.resolve);
		await arrived.promise;
		await nextSummary(count);
	};
	try {
		if (started.kind !== 'started') throw new Error(`Host setup failed: ${started.reason}`);
		const database = started.host.configuration.openDatabase();
		async function pendFences(): Promise<void> {
			for (const id of [validOrganizationId, expiredOrganizationId])
				// oxlint-disable-next-line no-await-in-loop -- each organization's own fence row.
				await database
					.insert(organizationAuthorizationRevisions)
					.values({
						id,
						revision: 1,
						state: 'active',
						permissionPolicyDigest: 'a'.repeat(64),
						nextAttemptAt: 0,
						createdAt: 0,
						updatedAt: 0,
					})
					.onConflictDoUpdate({
						target: organizationAuthorizationRevisions.id,
						set: { acknowledgedRevision: 0, nextAttemptAt: 0 },
					});
		}
		for (const [id, slug] of [
			[validOrganizationId, 'deadline-valid'],
			[expiredOrganizationId, 'deadline-expired'],
		] as const)
			// oxlint-disable-next-line no-await-in-loop -- two fixture organizations.
			await database
				.insert(organization)
				.values({ id, name: slug, slug, createdAt: new Date(now), fleetState: 'ready' });
		await pendFences();
		// Act: the drain's guards meet a peer that never answers; each deadline ends its run.
		await drainLikeTheHint(started.host.configuration);
		await nextSummary(1);
		const firstPushes = [...pushedOrganizations];
		const records = await database
			.select({
				id: organization.id,
				sent: organization.fleetStampSent,
				unanswered: organization.fleetStampUnansweredTries,
				refused: organization.fleetStampRefusedTries,
				lastTryOutcome: organization.fleetStampLastTryOutcome,
			})
			.from(organization);
		// The next drain: central answers now, and each organization's bytes in doubt are re-sent.
		holdRenewals = false;
		stampKeyId = 'retired-native-key';
		await pendFences();
		await drainLikeTheHint(started.host.configuration);
		await nextSummary(2);
		// Assert
		expect(deadlineStarts).toEqual([5_000, 5_000, 5_000, 5_000]);
		expect(observedAborts.toSorted()).toEqual(
			[validOrganizationId, expiredOrganizationId].toSorted(),
		);
		expect(firstPushes).toEqual([]);
		expect(summaries[0]).toMatchObject({ acknowledged: 0 });
		for (const id of [validOrganizationId, expiredOrganizationId])
			expect(records.find((row) => row.id === id)).toEqual({
				id,
				sent: heldStatements.find((held) => held.organizationId === id)?.statement,
				unanswered: 1,
				refused: 0,
				lastTryOutcome: 'unanswered-timeout',
			});
		expect(answeredStatements.toSorted()).toEqual(
			heldStatements.map((held) => held.statement).toSorted(),
		);
		expect(pushedOrganizations.slice(firstPushes.length).toSorted()).toEqual(
			[validOrganizationId, expiredOrganizationId].toSorted(),
		);
	} finally {
		if (started.kind === 'started') await started.host.close();
		await new Promise<void>((resolveClose): void => {
			central.close((): void => resolveClose());
			central.closeAllConnections();
		});
	}
});
