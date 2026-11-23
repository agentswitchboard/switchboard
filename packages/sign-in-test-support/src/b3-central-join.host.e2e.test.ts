import { once } from 'node:events';
import { createServer, request as sendHttpRequest } from 'node:http';
import type { Duplex } from 'node:stream';

import {
	createFleetAdminLinkClient,
	createFleetAdminProofKey,
	fleetAdminProofKeyThumbprint,
	fleetPermissionPolicyDigest,
	signMachineEnrollmentRevocationProof,
	uuid7Schema,
	type CentralTransport,
} from '@agent-collaboration/sign-in-core';
import { createCentralUnixTransport } from '@agent-collaboration/sign-in-host-node';
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from 'jose';
import type { WebSocket as WorkerWebSocket } from 'miniflare';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { centralProductionWorkers } from '#sign-in-test-support/test-fixtures/b3-central-production-workers';
import {
	b3CentralTrust,
	startB3CentralTokio,
} from '#sign-in-test-support/test-fixtures/b3-central-tokio';
import { startLocalAuthHarness } from '#sign-in-test-support/test-fixtures/local-auth-harness';

const centralExecutable = process.env.B3_CENTRAL_SERVE;
const centralWorkerSource = process.env.B3_CENTRAL_WORKER_CHECKOUT;
const organizationId = '019f0000-0000-7000-8000-00000000d201';
const actor = '019f0000-0000-7000-8000-00000000d202';
const authorizationSubject = '019f0000-0000-7000-8000-00000000d203';
const sessionId = '019f0000-0000-7000-8000-00000000d206';
const machineId = '019f0000-0000-7000-8000-00000000d207';
const pendingMachineId = '019f0000-0000-7000-8000-00000000d208';
const issuer = 'https://sign-in.example.invalid';
const { publicOrigin, audience, adminAudience, machineAudience } = b3CentralTrust(issuer);
const keyId = 'b3-joint-fixture';
const revokedLinkCode = 4101;
const machineTokenSkewSeconds = 60;
const welcomeSchema = z.strictObject({
	kind: z.literal('welcome'),
	machineId: z.literal(machineId),
	centralTime: z.iso.datetime({ offset: true }),
	effectiveExpiresAt: z.iso.datetime({ offset: true }),
});
const upgradeHeaders = {
	connection: 'Upgrade',
	upgrade: 'websocket',
	'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
	'sec-websocket-version': '13',
};

type CarrierAnswer =
	| { readonly kind: 'refused'; readonly status: number | undefined }
	| { readonly kind: 'connected'; readonly socket: Duplex; readonly head: Buffer };

function openCentralLink(origin: URL, bearer: string): Promise<CarrierAnswer> {
	return new Promise((resolveAnswer, rejectAnswer): void => {
		const request = sendHttpRequest(new URL(`/v1/organizations/${organizationId}/link`, origin), {
			headers: { ...upgradeHeaders, authorization: `Bearer ${bearer}` },
		});
		request.once('error', rejectAnswer);
		request.once('response', (response): void => {
			response.resume();
			resolveAnswer({ kind: 'refused', status: response.statusCode });
		});
		request.once('upgrade', (_response, socket, head): void => {
			socket.on('error', (): void => {
				socket.destroy();
			});
			resolveAnswer({ kind: 'connected', socket, head });
		});
		request.end();
	});
}

/** Central's server frames are unmasked. Return one frame and any following bytes. */
async function readServerFrame(
	socket: Duplex,
	head: Buffer,
): Promise<{
	readonly opcode: number;
	readonly payload: Buffer;
	readonly remainder: Buffer;
}> {
	let buffered = Buffer.from(head);
	function decode(): { opcode: number; payload: Buffer; remainder: Buffer } | undefined {
		if (buffered.length < 2) return undefined;
		const opcode = buffered.readUInt8(0) & 0xf;
		const size = buffered.readUInt8(1);
		if (size >= 127) throw new Error('Unexpected server frame encoding');
		const offset = size === 126 ? 4 : 2;
		if (buffered.length < offset) return undefined;
		const length = size === 126 ? buffered.readUInt16BE(2) : size;
		if (buffered.length < offset + length) return undefined;
		return {
			opcode,
			payload: buffered.subarray(offset, offset + length),
			remainder: buffered.subarray(offset + length),
		};
	}
	const initial = decode();
	if (initial !== undefined) return initial;
	for await (const chunk of socket.iterator({ destroyOnReturn: false })) {
		const bytes: unknown = chunk;
		if (!Buffer.isBuffer(bytes)) throw new Error('Expected a Central frame');
		buffered = Buffer.concat([buffered, bytes]);
		const frame = decode();
		if (frame !== undefined) return frame;
	}
	throw new Error('Carrier closed before the expected Central frame');
}

async function sampleHttpTime(origin: URL): Promise<number> {
	const sample = await fetch(origin);
	await sample.arrayBuffer();
	const now = Math.floor(Date.parse(sample.headers.get('date') ?? '') / 1000);
	if (!Number.isSafeInteger(now)) throw new Error('Runtime did not report an HTTP Date');
	return now;
}

interface MachineLinkProof {
	readonly machineBearer: string;
	readonly legacyMachineBearer: string;
	readonly pendingEnrollment: string;
	readonly enrollmentId: string;
	readonly effectiveExpirySeconds: number;
	readonly personToken: (secondFactorAt: number) => Promise<string>;
	readonly revoke: (target: string, accessToken: string) => Promise<unknown>;
}

async function prepareMachineLinkProof(
	privateLink: CentralTransport,
	privateKey: CryptoKey,
	now: number,
): Promise<MachineLinkProof> {
	let sequence = 0;
	function nextRequestId(): string {
		const time = ((now - 1) * 1000).toString(16).padStart(12, '0');
		sequence += 1;
		return `${time.slice(0, 8)}-${time.slice(8)}-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
	}
	function signFixture(claims: JWTPayload, typ: string): Promise<string> {
		return new SignJWT(claims)
			.setProtectedHeader({ alg: 'EdDSA', typ, kid: keyId })
			.sign(privateKey);
	}
	async function postFixture(path: string, body: object): Promise<unknown> {
		const response = await privateLink.fetch(
			new Request(`http://central.invalid${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			}),
		);
		expect(response.status, path).toBe(200);
		return response.json();
	}
	const stamp = await signFixture(
		{
			purpose: 'fleet-organization-stamp',
			version: 1,
			iss: issuer,
			aud: audience,
			sub: organizationId,
			organization_id: organizationId,
			iat: now - 60,
			exp: now - 60 + 10_368_000,
		},
		'fleet-organization-stamp+jwt',
	);
	await postFixture('/internal/organization-provisioning', {
		organizationId,
		organizationStatement: stamp,
	});
	await postFixture('/internal/organization-authorization-revisions', {
		kind: 'organization',
		organizationId,
		revision: 3,
		state: 'active',
		permissionPolicyDigest: fleetPermissionPolicyDigest,
	});
	await postFixture('/internal/organization-authorization-revisions', {
		kind: 'person',
		organizationId,
		personId: actor,
		subjectId: authorizationSubject,
		revision: 4,
		state: 'active',
	});
	async function approve(target: string): Promise<string> {
		const result = await postFixture('/internal/device-login-decisions', {
			organizationId,
			approver: actor,
			permissionChecked: 'machine:enroll',
			requestId: nextRequestId(),
			machineId: target,
			label: 'B3 proof Mac',
			allowedWorkspaces: [],
			approverSecondFactorAt: now - 60,
			codeExpiresAt: now + 300,
		});
		return z.object({ result: z.literal('approved'), enrollmentId: z.uuidv7() }).parse(result)
			.enrollmentId;
	}
	const enrollmentId = await approve(machineId);
	const pendingEnrollment = await approve(pendingMachineId);
	const grant = z
		.object({
			result: z.literal('grant'),
			machineId: z.literal(machineId),
			enrollmentId: z.literal(enrollmentId),
			grantExpiresAt: z.number().int(),
		})
		.parse(
			await postFixture('/internal/machine-token-decisions', {
				organizationId,
				enrollmentId,
				clientId: enrollmentId,
			}),
		);
	const accessExpirySeconds = now + 600;
	const machineBearer = await signFixture(
		{
			iss: issuer,
			aud: machineAudience,
			iat: now,
			exp: accessExpirySeconds,
			grant_expires_at: grant.grantExpiresAt,
			organization_id: organizationId,
			client_id: enrollmentId,
			azp: enrollmentId,
			principal: { kind: 'machine', machine_id: machineId, enrollment_id: enrollmentId },
		},
		'at+jwt',
	);

	const admin = createFleetAdminLinkClient(privateLink);
	const key = await createFleetAdminProofKey(globalThis.crypto);
	const thumbprint = await fleetAdminProofKeyThumbprint(globalThis.crypto, key);
	async function personToken(secondFactorAt: number): Promise<string> {
		return signFixture(
			{
				iss: issuer,
				aud: adminAudience,
				sub: actor,
				sid: sessionId,
				iat: now - 10,
				exp: now + 290,
				cnf: { jkt: thumbprint },
				token_profile: 'person-fleet',
				organization_id: organizationId,
				authorization_subject_id: authorizationSubject,
				person_revision: 4,
				organization_revision: 3,
				permission_policy_digest: fleetPermissionPolicyDigest,
				permissions: ['machine:revoke'],
				second_factor_at: secondFactorAt,
				second_factor_method: 'app',
				session_expires_at_ms: (now + 86_400) * 1000,
				authorization_snapshot_at_ms: now * 1000 - 10_000,
				authorization_snapshot_valid_until_ms: now * 1000 + 200_000,
			},
			'at+jwt',
		);
	}
	async function revoke(target: string, accessToken: string): Promise<unknown> {
		const request = {
			organizationId: uuid7Schema.parse(organizationId),
			enrollmentId: uuid7Schema.parse(target),
		};
		const proof = await signMachineEnrollmentRevocationProof(globalThis.crypto, {
			key,
			centralOrigin: publicOrigin,
			requestId: nextRequestId(),
			issuedAtSeconds: now - 1,
			accessToken,
			request,
		});
		return admin.revokeMachineEnrollment({ request, accessToken, proof });
	}

	const legacyMachineBearer = await signFixture(
		{
			iss: issuer,
			aud: machineAudience,
			iat: now,
			exp: accessExpirySeconds,
			grant_expires_at: grant.grantExpiresAt,
			organization_id: organizationId,
			client_id: enrollmentId,
			azp: enrollmentId,
			principal: { kind: 'machine', installation_id: machineId, enrollment_id: enrollmentId },
		},
		'at+jwt',
	);
	return {
		machineBearer,
		legacyMachineBearer,
		pendingEnrollment,
		enrollmentId,
		effectiveExpirySeconds: Math.min(
			accessExpirySeconds + machineTokenSkewSeconds,
			grant.grantExpiresAt,
		),
		personToken,
		revoke,
	};
}

it.runIf(centralExecutable !== undefined && process.env.SIGN_IN_TEST_HOST !== 'cloudflare')(
	'joins the real Central Tokio link directly and revokes the enrollment through its private admin socket',
	async (): Promise<void> => {
		if (centralExecutable === undefined) throw new Error('Expected the pinned Central executable');
		const { privateKey, publicKey } = await generateKeyPair('EdDSA');
		const publicJwk = { ...(await exportJWK(publicKey)), kid: keyId, alg: 'EdDSA' };
		const keyServer = createServer((_request, response): void => {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ keys: [publicJwk] }));
		});
		let stopCentral: (() => Promise<void>) | undefined;
		let socket: Duplex | undefined;
		try {
			keyServer.listen(0, '127.0.0.1');
			await once(keyServer, 'listening');
			const keyAddress = keyServer.address();
			if (keyAddress === null || typeof keyAddress === 'string')
				throw new Error('No JWKS listener');
			const central = await startB3CentralTokio({
				executable: centralExecutable,
				issuer,
				jwksUrl: `http://127.0.0.1:${keyAddress.port}/jwks`,
			});
			stopCentral = central.close;
			const { tcp } = central;
			const privateLink = createCentralUnixTransport(central.socketPath);

			// central serve owns a real clock. Sample its HTTP Date once for synthetic claims
			// rather than reading the test runner's clock or asserting elapsed time.
			const now = await sampleHttpTime(tcp);
			const {
				machineBearer,
				legacyMachineBearer,
				pendingEnrollment,
				enrollmentId,
				effectiveExpirySeconds,
				personToken,
				revoke,
			} = await prepareMachineLinkProof(privateLink, privateKey, now);
			expect(await openCentralLink(tcp, legacyMachineBearer)).toEqual({
				kind: 'refused',
				status: 401,
			});

			const openedLink = await openCentralLink(tcp, machineBearer);
			if (openedLink.kind !== 'connected')
				throw new Error(`Carrier upgrade refused: ${openedLink.status}`);
			socket = openedLink.socket;
			const welcome = await readServerFrame(socket, openedLink.head);
			expect(welcome.opcode).toBe(1);
			const welcomeBody = welcomeSchema.parse(JSON.parse(welcome.payload.toString('utf8')));
			expect(Date.parse(welcomeBody.effectiveExpiresAt)).toBe(effectiveExpirySeconds * 1000);
			const owner = await personToken(now - 60);
			expect(await openCentralLink(tcp, owner)).toEqual({
				kind: 'refused',
				status: 401,
			});
			expect(await revoke(pendingEnrollment, owner)).toEqual({
				kind: 'answered',
				result: { result: 'notFound' },
			});
			expect(await revoke(enrollmentId, await personToken(now - 901))).toEqual({
				kind: 'answered',
				result: { result: 'refused', reason: 'factorNotRecent' },
			});
			// One masked client text frame carrying Central's application-level "ping".
			socket.write(Buffer.from([0x81, 0x84, 1, 2, 3, 4, 0x71, 0x6b, 0x6d, 0x63]));
			const pong = await readServerFrame(socket, welcome.remainder);
			expect(pong.opcode).toBe(1);
			expect(pong.payload.toString('utf8')).toBe('pong');
			expect(await revoke(enrollmentId, owner)).toEqual({
				kind: 'answered',
				result: { result: 'revoked' },
			});
			const revoked = await readServerFrame(socket, pong.remainder);
			expect(revoked.opcode).toBe(8);
			expect(revoked.payload.readUInt16BE()).toBe(revokedLinkCode);
			expect(await revoke(enrollmentId, owner)).toEqual({
				kind: 'answered',
				result: { result: 'alreadyEnded' },
			});
			const reconnect = await openCentralLink(tcp, machineBearer);
			if (reconnect.kind !== 'connected') throw new Error('Expected a terminal carrier upgrade');
			try {
				const firstFrame = await readServerFrame(reconnect.socket, reconnect.head);
				expect(firstFrame.opcode).toBe(8);
				expect(firstFrame.payload.readUInt16BE()).toBe(revokedLinkCode);
			} finally {
				reconnect.socket.destroy();
			}
		} finally {
			socket?.destroy();
			try {
				await stopCentral?.();
			} finally {
				keyServer.closeAllConnections();
				await new Promise<void>((resolveClose) => keyServer.close(() => resolveClose()));
			}
		}
	},
);

function nextWorkerFrame(socket: WorkerWebSocket): Promise<string> {
	return new Promise((resolveFrame, rejectFrame): void => {
		function closeBeforeFrame(): void {
			rejectFrame(new Error('Machine link closed before its next frame'));
		}
		socket.addEventListener('close', closeBeforeFrame, { once: true });
		socket.addEventListener(
			'message',
			(event): void => {
				socket.removeEventListener('close', closeBeforeFrame);
				if (typeof event.data !== 'string') rejectFrame(new Error('Expected a text frame'));
				else resolveFrame(event.data);
			},
			{ once: true },
		);
	});
}

function nextWorkerCloseCode(socket: WorkerWebSocket): Promise<number> {
	return new Promise((resolveClose, rejectClose): void => {
		function receivedMessage(): void {
			socket.removeEventListener('close', closed);
			rejectClose(new Error('Expected the machine link to close before sending a message'));
		}
		function closed(event: { readonly code: number }): void {
			socket.removeEventListener('message', receivedMessage);
			resolveClose(event.code);
		}
		socket.addEventListener('close', closed, { once: true });
		socket.addEventListener('message', receivedMessage, { once: true });
	});
}

it.runIf(centralWorkerSource !== undefined && process.env.SIGN_IN_TEST_HOST === 'cloudflare')(
	'carries a real WebSocket from the production Central storage Worker through the Sign-in binding',
	async (): Promise<void> => {
		if (centralWorkerSource === undefined) throw new Error('Missing the pinned Central checkout');
		const { privateKey, publicKey } = await generateKeyPair('EdDSA');
		const jwk = { ...(await exportJWK(publicKey)), kid: keyId, alg: 'EdDSA' };
		const harness = await startLocalAuthHarness({
			host: 'cloudflare',
			turnstileSecret: 'published-test',
			workerdCentral: async () =>
				centralProductionWorkers({
					checkout: centralWorkerSource,
					readJwks: async () => JSON.stringify({ keys: [jwk] }),
					trust: b3CentralTrust(issuer),
				}),
		});
		let socket: WorkerWebSocket | null = null;
		try {
			const signInWorker = await harness.miniflare.getWorker('sign-in');
			const { CENTRAL } = await harness.miniflare.getBindings<{
				readonly CENTRAL: typeof signInWorker;
			}>('sign-in');
			if (typeof CENTRAL?.fetch !== 'function')
				throw new Error('Missing the actual CENTRAL binding');
			const privateLink: CentralTransport = {
				async fetch(request: Request): Promise<Response> {
					const response = await CENTRAL.fetch(request.url, {
						method: request.method,
						headers: Object.fromEntries(request.headers),
						body: await request.arrayBuffer(),
					});
					return new Response(await response.arrayBuffer(), { status: response.status });
				},
			};
			// The loopback HTTP listener supplies the Date header. A direct Worker response
			// does not add this transport header.
			const now = await sampleHttpTime(new URL(harness.issuer));
			const proof = await prepareMachineLinkProof(privateLink, privateKey, now);
			const open = (bearer: string): ReturnType<typeof signInWorker.fetch> =>
				signInWorker.fetch(
					new URL(`/api/fleet/link/${organizationId}`, harness.issuer).toString(),
					{
						headers: { ...upgradeHeaders, authorization: `Bearer ${bearer}` },
					},
				);
			expect((await open(proof.legacyMachineBearer)).status).toBe(401);
			const opened = await open(proof.machineBearer);
			expect(opened.status).toBe(101);
			socket = opened.webSocket;
			if (socket === null) throw new Error('The service binding did not return a WebSocket');
			const welcome = nextWorkerFrame(socket);
			socket.accept();
			const welcomeBody = welcomeSchema.parse(JSON.parse(await welcome));
			expect(Date.parse(welcomeBody.effectiveExpiresAt)).toBe(proof.effectiveExpirySeconds * 1000);
			const pong = nextWorkerFrame(socket);
			socket.send('ping');
			expect(await pong).toBe('pong');
			const closed = nextWorkerCloseCode(socket);
			expect(await proof.revoke(proof.enrollmentId, await proof.personToken(now - 60))).toEqual({
				kind: 'answered',
				result: { result: 'revoked' },
			});
			expect(await closed).toBe(revokedLinkCode);
			const rejoined = await open(proof.machineBearer);
			expect(rejoined.status).toBe(101);
			const terminalSocket = rejoined.webSocket;
			if (terminalSocket === null) throw new Error('Expected a terminal carrier upgrade');
			try {
				const terminalCode = nextWorkerCloseCode(terminalSocket);
				terminalSocket.accept();
				expect(await terminalCode).toBe(revokedLinkCode);
			} finally {
				terminalSocket.close();
			}
		} finally {
			socket?.close();
			await harness.close();
		}
	},
);
