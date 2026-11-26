import {
	organizationAuthorizationRevisions,
	verification,
} from '@agent-collaboration/sign-in-core';
import { createSignInHttpHandler } from '@agent-collaboration/sign-in-core/better-auth';
import {
	createMemoryProofKeyStore,
	refreshFleetCli,
	signInFleetCli,
	type FleetCliSession,
} from '@agent-collaboration/sign-in-owner-cli';
import { eq, lt } from 'drizzle-orm';
import type { WebSocket as WorkerWebSocket } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	otherOrigin,
	personLinkFamily,
} from '#sign-in-test-support/fuzz/request-families/person-link';
import {
	checkPersonLinkArrival,
	personLinkArrivals,
	personLinkCentralStandIn,
	personLinkOpenedFrame,
	signPersonLinkUpgradeProof,
	type PersonLinkArrival,
} from '#sign-in-test-support/test-fixtures/controlled-central-person-link';
import { useControlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-node-test-clock';
import {
	publicKeys,
	setupFleetCli,
	type FleetFixture,
} from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import {
	peoplePost,
	signInConfirmedPeopleBrowser,
} from '#sign-in-test-support/test-fixtures/people-browser-login';
import { webSignInCrypto } from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

useControlledSignInClock();

const personLinkAudience = 'https://central.example.invalid/person-link';
const upgrade = {
	connection: 'Upgrade',
	upgrade: 'websocket',
	'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
	'sec-websocket-version': '13',
} as const;
const refusalSchema = z.strictObject({ error: z.string() });

function withoutHeaders(
	headers: Readonly<Record<string, string>>,
	...names: readonly string[]
): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));
}

type LinkAnswer =
	| { readonly kind: 'opened'; readonly frame: string }
	| { readonly kind: 'refused'; readonly status: number; readonly error: string };

function nextFrame(socket: WorkerWebSocket): Promise<string> {
	return new Promise((resolveFrame, rejectFrame): void => {
		socket.addEventListener('close', (): void => rejectFrame(new Error('Closed before a frame')), {
			once: true,
		});
		socket.addEventListener(
			'message',
			(event): void => {
				if (typeof event.data === 'string') resolveFrame(event.data);
				else rejectFrame(new Error('Expected a text frame'));
			},
			{ once: true },
		);
	});
}

/**
 * One upgrade to the public person-link route. On workerd it goes to the real `sign-in` Worker, so
 * the WebSocket the stand-in accepts reaches this client. On Node the HTTP relay cannot carry an
 * upgrade (undici refuses the header), so it goes to the Node host's own shared handler and
 * configuration in process; that host has no upgrade bridge yet, so it never forwards (see the
 * hand-back's named limit).
 */
async function openPersonLink(
	fixture: FleetFixture,
	init: {
		readonly method?: 'GET' | 'POST';
		readonly headers: Readonly<Record<string, string>>;
		readonly organizationId?: string;
	},
): Promise<LinkAnswer> {
	const url = new URL(
		`/api/fleet/person-link/${init.organizationId ?? fixture.target.organizationId}`,
		fixture.target.issuer,
	);
	const method = init.method ?? 'GET';
	if (fixture.harness.signInHost === 'cloudflare') {
		const worker = await fixture.harness.miniflare.getWorker('sign-in');
		const response = await worker.fetch(url.toString(), { method, headers: init.headers });
		if (response.status === 101) {
			const socket = response.webSocket;
			if (socket === null) throw new Error('A 101 without a WebSocket');
			const frame = nextFrame(socket);
			socket.accept();
			const opened: LinkAnswer = { kind: 'opened', frame: await frame };
			socket.close();
			return opened;
		}
		return {
			kind: 'refused',
			status: response.status,
			error: refusalSchema.parse(await response.json()).error,
		};
	}
	const configuration = fixture.harness.providerConfiguration;
	if (configuration === undefined) throw new Error('The Node host exposes its configuration');
	const response = await createSignInHttpHandler(configuration)(
		new Request(url, { method, headers: init.headers }),
	);
	return {
		kind: 'refused',
		status: response.status,
		error: refusalSchema.parse(await response.json()).error,
	};
}

const onWorkerd = process.env.SIGN_IN_TEST_HOST !== 'node';

describe('C8 part B: the person-link route', () => {
	let fixture: FleetFixture;
	let session: FleetCliSession;
	const browser = (): Record<string, string> => ({
		...upgrade,
		cookie: fixture.cookie,
		origin: new URL(fixture.target.issuer).origin,
	});
	async function cliHeaders(
		overrides: { readonly htu?: string; readonly jti?: string } = {},
	): Promise<Record<string, string>> {
		const htu =
			overrides.htu ??
			new URL(
				`/api/fleet/person-link/${fixture.target.organizationId}`,
				fixture.target.issuer,
			).toString();
		return {
			...upgrade,
			authorization: `DPoP ${session.accessToken}`,
			dpop: await signPersonLinkUpgradeProof({
				key: session.key,
				htu,
				jti: overrides.jti ?? fixture.io.nextId(),
				issuedAtSeconds: Math.floor(fixture.io.now() / 1000),
				accessToken: session.accessToken,
			}),
		};
	}
	async function arrivals(): Promise<readonly PersonLinkArrival[]> {
		return onWorkerd ? personLinkArrivals(fixture.harness.miniflare) : [];
	}
	async function check(
		arrival: PersonLinkArrival | undefined,
	): ReturnType<typeof checkPersonLinkArrival> {
		if (arrival === undefined) throw new Error('No upgrade reached the stand-in');
		return checkPersonLinkArrival({
			arrival,
			organizationId: fixture.target.organizationId,
			issuer: fixture.target.issuer,
			audience: personLinkAudience,
			keys: await publicKeys(fixture.harness),
			now: fixture.io.now(),
		});
	}

	beforeAll(async () => {
		fixture = await setupFleetCli(
			onWorkerd ? { machineLinkStorageWorker: personLinkCentralStandIn() } : {},
		);
		session = await signInFleetCli({
			target: fixture.target,
			store: createMemoryProofKeyStore(webSignInCrypto),
			io: fixture.io,
		});
	});
	afterAll(async () => {
		await fixture?.harness.close();
	});

	it('forwards a browser with a session and the exact Origin, with a person-link token and no cookie', async (): Promise<void> => {
		const before = (await arrivals()).length;
		const answer = await openPersonLink(fixture, { headers: browser() });
		if (!onWorkerd) {
			expect(answer).toEqual({ kind: 'refused', status: 503, error: 'central-link-unavailable' });
			return;
		}
		expect(answer).toEqual({ kind: 'opened', frame: personLinkOpenedFrame });
		const received = await arrivals();
		expect(received).toHaveLength(before + 1);
		const checked = await check(received.at(-1));
		if (checked.kind !== 'accepted') throw new Error(`Stand-in refused: ${checked.reason}`);
		expect(checked.claims).toMatchObject({
			iss: fixture.target.issuer,
			aud: personLinkAudience,
			token_profile: 'person-link',
			organization_id: fixture.target.organizationId,
		});
		expect(checked.claims.permissions).toContain('approval:decide');
		expect(checked.claims.permissions).toHaveLength(10);
		expect(checked.claims.permissions).toEqual([...new Set(checked.claims.permissions)].toSorted());
		expect(Object.keys(checked.claims).toSorted()).toEqual(
			[
				'aud',
				'authorization_snapshot_at_ms',
				'authorization_snapshot_valid_until_ms',
				'authorization_subject_id',
				'exp',
				'iat',
				'iss',
				'jti',
				'organization_id',
				'organization_revision',
				'permission_policy_digest',
				'permissions',
				'person_revision',
				'second_factor_at',
				'second_factor_method',
				'session_expires_at_ms',
				'sub',
				'token_profile',
			].toSorted(),
		);
	});

	it('refuses a wrong or missing Origin with 403, and no session with 401, before central', async (): Promise<void> => {
		const before = (await arrivals()).length;
		expect(
			await openPersonLink(fixture, {
				headers: { ...browser(), origin: otherOrigin(fixture.target.issuer) },
			}),
		).toEqual({ kind: 'refused', status: 403, error: 'origin-refused' });
		expect(await openPersonLink(fixture, { headers: withoutHeaders(browser(), 'origin') })).toEqual(
			{
				kind: 'refused',
				status: 403,
				error: 'origin-refused',
			},
		);
		expect(
			await openPersonLink(fixture, {
				headers: { ...browser(), cookie: 'better-auth.session_token=not-a-session' },
			}),
		).toEqual({ kind: 'refused', status: 401, error: 'session-required' });
		expect(await arrivals()).toHaveLength(before);
	});

	it('forwards a CLI with a valid token and proof, and refuses a proof for another URL or a replay', async (): Promise<void> => {
		const before = (await arrivals()).length;
		const headers = await cliHeaders();
		const answer = await openPersonLink(fixture, { headers });
		if (onWorkerd) {
			expect(answer).toEqual({ kind: 'opened', frame: personLinkOpenedFrame });
			const received = await arrivals();
			expect(received).toHaveLength(before + 1);
			expect((await check(received.at(-1))).kind).toBe('accepted');
		} else
			expect(answer).toEqual({ kind: 'refused', status: 503, error: 'central-link-unavailable' });
		const afterValid = (await arrivals()).length;
		expect(await openPersonLink(fixture, { headers })).toEqual({
			kind: 'refused',
			status: 401,
			error: 'proof-refused',
		});
		expect(
			await openPersonLink(fixture, {
				headers: await cliHeaders({
					htu: new URL('/api/fleet/person-link/elsewhere', fixture.target.issuer).toString(),
				}),
			}),
		).toEqual({ kind: 'refused', status: 401, error: 'proof-refused' });
		expect(await arrivals()).toHaveLength(afterValid);
	});

	it('refuses a non-member with 403, and a non-GET or non-upgrade request with 405', async (): Promise<void> => {
		const before = (await arrivals()).length;
		expect(
			await openPersonLink(fixture, {
				headers: browser(),
				organizationId: fixture.io.nextId(),
			}),
		).toEqual({ kind: 'refused', status: 403, error: 'organization-refused' });
		expect(
			await openPersonLink(fixture, {
				method: 'POST',
				headers: withoutHeaders(browser(), 'upgrade', 'connection'),
			}),
		).toEqual({
			kind: 'refused',
			status: 405,
			error: 'method-not-allowed',
		});
		expect(
			await openPersonLink(fixture, {
				headers: withoutHeaders(browser(), 'upgrade', 'connection'),
			}),
		).toEqual({
			kind: 'refused',
			status: 405,
			error: 'websocket-upgrade-required',
		});
		expect(await arrivals()).toHaveLength(before);
	});

	it('refuses the person-link request family before a token is minted', async (): Promise<void> => {
		const before = (await arrivals()).length;
		for (const variant of personLinkFamily.variants) {
			const generated = personLinkFamily.generate(
				fixture.target.organizationId,
				fixture.target.issuer,
				variant,
			);
			expect(
				await openPersonLink(fixture, {
					method: generated.init.method,
					headers: Object.fromEntries(generated.init.headers),
				}),
				variant,
			).toEqual({ kind: 'refused', status: generated.status, error: generated.error });
		}
		expect(await arrivals()).toHaveLength(before);
	});

	it.skipIf(!onWorkerd)(
		'signs an empty permission list for an organization member',
		async (): Promise<void> => {
			const invitation = await peoplePost(
				fixture.harness,
				'invite-member',
				{
					organizationId: fixture.target.organizationId,
					email: 'member@example.invalid',
					role: 'member',
				},
				fixture.cookie,
			);
			expect(invitation.status).toBe(200);
			const invitationId = z.object({ id: z.uuidv7() }).parse(await invitation.json()).id;
			await signInConfirmedPeopleBrowser({
				harness: fixture.harness,
				email: 'member@example.invalid',
			});
			expect(
				(await peoplePost(fixture.harness, 'accept-invitation', { invitationId })).status,
			).toBe(200);

			const answer = await openPersonLink(fixture, {
				headers: { ...browser(), cookie: fixture.harness.cookie() },
			});

			expect(answer).toEqual({ kind: 'opened', frame: personLinkOpenedFrame });
			const checked = await check((await arrivals()).at(-1));
			if (checked.kind !== 'accepted') throw new Error(`Stand-in refused: ${checked.reason}`);
			expect(checked.claims.permissions).toEqual([]);
		},
	);
});

it('refuses refresh and both person-link credentials when the organization still has the previous policy digest', async (): Promise<void> => {
	const fixture = await setupFleetCli(
		onWorkerd ? { machineLinkStorageWorker: personLinkCentralStandIn() } : {},
	);
	try {
		const store = createMemoryProofKeyStore(webSignInCrypto);
		const cli = await signInFleetCli({ target: fixture.target, store, io: fixture.io });
		expect(await store.load()).not.toBeNull();
		await fixture.harness.database
			.update(organizationAuthorizationRevisions)
			.set({
				// The digest on active organization fences created by 79d4b4a.
				permissionPolicyDigest: '2d31b5d72716e64e255d8858c231f593155289fb03ed354c4b762890667a3c22',
			})
			.where(eq(organizationAuthorizationRevisions.id, fixture.target.organizationId));
		const browserAnswer = await openPersonLink(fixture, {
			headers: {
				...upgrade,
				cookie: fixture.cookie,
				origin: new URL(fixture.target.issuer).origin,
			},
		});
		const htu = new URL(
			`/api/fleet/person-link/${fixture.target.organizationId}`,
			fixture.target.issuer,
		).toString();
		const cliAnswer = await openPersonLink(fixture, {
			headers: {
				...upgrade,
				authorization: `DPoP ${cli.accessToken}`,
				dpop: await signPersonLinkUpgradeProof({
					key: cli.key,
					htu,
					jti: fixture.io.nextId(),
					issuedAtSeconds: Math.floor(fixture.io.now() / 1000),
					accessToken: cli.accessToken,
				}),
			},
		});
		const refusal = { kind: 'refused', status: 503, error: 'authorization-unavailable' };
		expect([browserAnswer, cliAnswer]).toEqual([refusal, refusal]);
		if (onWorkerd) expect(await personLinkArrivals(fixture.harness.miniflare)).toEqual([]);

		const refreshReplies: Response[] = [];
		const refreshed = await refreshFleetCli({
			target: fixture.target,
			store,
			io: {
				...fixture.io,
				async fetch(input, init): Promise<Response> {
					const response = await fixture.io.fetch(input, init);
					refreshReplies.push(response.clone());
					return response;
				},
			},
		});
		expect(refreshed).toBeNull();
		expect(await store.load()).toBeNull();
		expect(refreshReplies).toHaveLength(1);
		const response = refreshReplies[0];
		if (response === undefined) throw new Error('Refresh did not reach Sign-in');
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'invalid_grant', message: 'policy-mismatch' });
	} finally {
		await fixture.harness.close();
	}
});

it.skipIf(!onWorkerd)(
	'answers 503 when the CENTRAL_LINK binding is unavailable',
	async (): Promise<void> => {
		const fixture = await setupFleetCli();
		try {
			expect(
				await openPersonLink(fixture, {
					headers: {
						...upgrade,
						cookie: fixture.cookie,
						origin: new URL(fixture.target.issuer).origin,
					},
				}),
			).toEqual({ kind: 'refused', status: 503, error: 'central-link-unavailable' });
		} finally {
			await fixture.harness.close();
		}
	},
);

it('is off without the person-link audience: 503 person-link-not-configured, and nothing reaches central', async (): Promise<void> => {
	const fixture = await setupFleetCli({
		personLinkAudience: 'absent',
		...(onWorkerd ? { machineLinkStorageWorker: personLinkCentralStandIn() } : {}),
	});
	try {
		expect(
			await openPersonLink(fixture, {
				headers: {
					...upgrade,
					cookie: fixture.cookie,
					origin: new URL(fixture.target.issuer).origin,
				},
			}),
		).toEqual({ kind: 'refused', status: 503, error: 'person-link-not-configured' });
		if (onWorkerd) expect(await personLinkArrivals(fixture.harness.miniflare)).toEqual([]);
	} finally {
		await fixture.harness.close();
	}
});

it('refuses a used CLI proof replayed in its last accepted second, after the store cleans expired markers', async (): Promise<void> => {
	const fixture = await setupFleetCli(
		onWorkerd ? { machineLinkStorageWorker: personLinkCentralStandIn() } : {},
	);
	try {
		const session = await signInFleetCli({
			target: fixture.target,
			store: createMemoryProofKeyStore(webSignInCrypto),
			io: fixture.io,
		});
		// Signed 10 s before now, so its last accepted second still falls inside the token's lifetime.
		const proofIssuedAt = Math.floor(fixture.io.now() / 1000) - 10;
		const headers = {
			...upgrade,
			authorization: `DPoP ${session.accessToken}`,
			dpop: await signPersonLinkUpgradeProof({
				key: session.key,
				htu: new URL(
					`/api/fleet/person-link/${fixture.target.organizationId}`,
					fixture.target.issuer,
				).toString(),
				jti: fixture.io.nextId(),
				issuedAtSeconds: proofIssuedAt,
				accessToken: session.accessToken,
			}),
		};
		expect(await openPersonLink(fixture, { headers })).toEqual(
			onWorkerd
				? { kind: 'opened', frame: personLinkOpenedFrame }
				: { kind: 'refused', status: 503, error: 'central-link-unavailable' },
		);
		const arrivalsAfterFirst = onWorkerd
			? (await personLinkArrivals(fixture.harness.miniflare)).length
			: 0;
		// Better Auth's default maximum proof age is 300 s; it accepts through the whole second
		// iat + 300. Move a few hundred milliseconds into that last accepted second.
		const lastAcceptedInstant = (proofIssuedAt + 300) * 1000 + 300;
		await fixture.setTime(lastAcceptedInstant);
		// The store's own verification cleanup: every row whose expiresAt is before now, by millisecond.
		await fixture.harness.database
			.delete(verification)
			.where(lt(verification.expiresAt, new Date(lastAcceptedInstant)));
		expect(await openPersonLink(fixture, { headers })).toEqual({
			kind: 'refused',
			status: 401,
			error: 'proof-refused',
		});
		if (onWorkerd)
			expect(await personLinkArrivals(fixture.harness.miniflare)).toHaveLength(arrivalsAfterFirst);
	} finally {
		await fixture.harness.close();
	}
});
