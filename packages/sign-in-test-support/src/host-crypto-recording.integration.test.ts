import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	createSignInStore,
	epochMillisecondsSchema,
	organization,
	organizationIdSchema,
	readOrganizationStatementFacts,
	renewOrganizationStampForUse,
	signInConfigurationSchema,
	trustedSignInClientAddressHeader,
	type SignInCrypto,
} from '@agent-collaboration/sign-in-core';
import {
	createSignInHttpHandler,
	type SignInHttpConfiguration,
} from '@agent-collaboration/sign-in-core/better-auth';
import {
	createNodeSignInConfiguration,
	nodeSignInSettingsSchema,
	openNodeSignInDatabase,
} from '@agent-collaboration/sign-in-host-node';
import { createMacosKeychainProofKeyStore } from '@agent-collaboration/sign-in-owner-cli';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
	createCentralStampModel,
	createStatementSigner,
} from '#sign-in-test-support/storage-cases/organization-stamp-central-model';
import { controlledSignInIds } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';
import { fakeSecurityRunner } from '#sign-in-test-support/test-fixtures/fleet-cli-fixture';
import { unreachedDeadline } from '#sign-in-test-support/test-fixtures/manual-deadlines';
import {
	createRecordingSignInCapabilities,
	webSignInCrypto,
	type RecordingSignInCapabilities,
	type SignInCapabilityRecord,
} from '#sign-in-test-support/test-fixtures/recording-sign-in-capabilities';

// R30 / U23 (V2): the core's crypto sites run on recording capabilities with a pinned process
// clock. The process clock is far from the injected one, so any output that carries the pinned
// time would show a real-clock read. The admin-forwarding rows are the Node host-e2e file, and
// the canonical-JSON row is in sign-in-core (canonical-json.unit.test.ts): it isn't exported.
const injectedNow = epochMillisecondsSchema.parse(1_800_000_000_000);
const pinnedProcessTime = 2_500_000_000_000;
const issuer = 'http://127.0.0.1:3000';

beforeAll(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(pinnedProcessTime);
});
afterAll(() => vi.useRealTimers());

/** Known bytes 00, 01, 02, …: what a page nonce or verifier made from them must equal. */
const countingBytes = (byteLength: number): Uint8Array<ArrayBuffer> =>
	Uint8Array.from({ length: byteLength }, (_, index) => index % 256);
const hex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

function recording(props: { readonly crypto?: SignInCrypto } = {}): RecordingSignInCapabilities {
	return createRecordingSignInCapabilities({
		crypto: props.crypto ?? webSignInCrypto,
		clock: { now: () => injectedNow },
		ids: controlledSignInIds,
		randomBytes: countingBytes,
	});
}

const recordsOf = <TKind extends SignInCapabilityRecord['kind']>(
	capabilities: RecordingSignInCapabilities,
	kind: TKind,
): Extract<SignInCapabilityRecord, { readonly kind: TKind }>[] =>
	capabilities
		.records()
		.filter(
			(record): record is Extract<SignInCapabilityRecord, { readonly kind: TKind }> =>
				record.kind === kind,
		);

/** The real Node host's configuration on a temporary better-sqlite3 database, with the
 * platform's crypto, clock and IDs taken from `capabilities`. */
async function recordedSignInConfiguration(
	capabilities: RecordingSignInCapabilities,
): Promise<SignInHttpConfiguration> {
	const stateDirectory = await mkdtemp(path.join(tmpdir(), '2026-11-host-crypto-recording-'));
	const opened = await openNodeSignInDatabase({ stateDirectory });
	if (opened.kind !== 'available') throw new Error('Database setup failed');
	const settings = nodeSignInSettingsSchema.parse({
		stateDirectory,
		centralSocketPath: path.join(stateDirectory, 'central.sock'),
		port: 0,
		configuration: signInConfigurationSchema.parse({
			issuer,
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
			turnstile: { kind: 'local', siteKey: '1x00000000000000000000AA' },
		}),
		secret: 'test-only-recording-secret-'.repeat(3),
		google: { clientId: 'fixture-google-client', clientSecret: 'fixture-google-secret' },
		github: { clientId: 'fixture-github-client', clientSecret: 'fixture-github-secret' },
	});
	const base = createNodeSignInConfiguration({
		settings,
		database: opened.database,
		clock: capabilities.clock,
		log: (): void => undefined,
	});
	const platform = {
		...base.platform,
		crypto: capabilities.crypto,
		clock: capabilities.clock,
		ids: capabilities.ids,
	};
	return {
		...base,
		platform,
		store: createSignInStore({
			openDatabase: base.openDatabase,
			platform,
			ownerEmail: settings.configuration.ownerEmail,
		}),
	};
}

function pageRequest(pathname: string): Request {
	return new Request(new URL(pathname, issuer), {
		headers: {
			accept: 'text/html',
			'sec-fetch-mode': 'navigate',
			[trustedSignInClientAddressHeader]: '203.0.113.7',
		},
	});
}

it('page nonce: the served owner page carries the host 16 bytes from one recorded draw, through the real handler', async () => {
	// Arrange
	const capabilities = recording();
	const handler = createSignInHttpHandler(await recordedSignInConfiguration(capabilities));
	// Act
	const response = await handler(pageRequest('/owner-ready'));
	// Assert
	expect(response.status).toBe(200);
	const nonce = hex(countingBytes(16));
	expect(response.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);
	expect(await response.text()).toContain(`nonce="${nonce}"`);
	expect(recordsOf(capabilities, 'random')).toEqual([{ kind: 'random', byteLength: 16 }]);
	// U23: the handler's clock reads go through the injected clock too.
	expect(recordsOf(capabilities, 'clock-read').length).toBeGreaterThan(0);
	expect(recordsOf(capabilities, 'clock-read').every((read) => read.now === injectedNow)).toBe(
		true,
	);
});

it('page nonce: a reply that is not a page asks the host for no random bytes', async () => {
	// Arrange
	const capabilities = recording();
	const handler = createSignInHttpHandler(await recordedSignInConfiguration(capabilities));
	// Act
	const response = await handler(
		new Request(new URL('/api/auth/jwks', issuer), {
			headers: { [trustedSignInClientAddressHeader]: '203.0.113.7' },
		}),
	);
	// Assert
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('application/json');
	expect(recordsOf(capabilities, 'random')).toEqual([]);
});

it('page nonce: a crypto that throws while the page renders gives 503 sign-in-unavailable and no page', async () => {
	// Arrange
	const failing: SignInCrypto = {
		subtle: webSignInCrypto.subtle,
		getRandomValues: () => {
			throw new Error('host randomness unavailable');
		},
	};
	const capabilities = createRecordingSignInCapabilities({
		crypto: failing,
		clock: { now: () => injectedNow },
		ids: controlledSignInIds,
	});
	const handler = createSignInHttpHandler(await recordedSignInConfiguration(capabilities));
	// Act
	const response = await handler(pageRequest('/owner-ready'));
	// Assert
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: 'sign-in-unavailable' });
	expect(recordsOf(capabilities, 'random')).toEqual([{ kind: 'random', byteLength: 16 }]);
});

it('statement digest: stamp renewal digests exactly the statement it sent, through the host', async () => {
	// Arrange
	const capabilities = recording();
	const configuration = await recordedSignInConfiguration(capabilities);
	const organizationId = organizationIdSchema.parse(controlledSignInIds.nextId());
	await configuration
		.openDatabase()
		.insert(organization)
		.values({
			id: organizationId,
			name: 'Recorded statement',
			slug: `recorded-statement-${organizationId}`,
			createdAt: new Date(injectedNow),
			fleetState: 'ready',
		});
	const central = createCentralStampModel();
	const sign = createStatementSigner({
		now: () => capabilities.clock.now(),
		signingKeyId: () => 'current-native-key',
	});
	// A confirmed stamp central holds, recorded 59 days from expiry: inside the renewal window,
	// so renewal signs its replacement, central provisions it and renewal reads its facts.
	const held = await sign({ organizationId });
	await central.hold(organizationId, held);
	const heldFacts = await readOrganizationStatementFacts(webSignInCrypto, held);
	await configuration.store.organizationStamps.seedConfirmedStamp({
		organizationId,
		stamp: { ...heldFacts, expiresAt: Math.floor(injectedNow / 1000) + 59 * 86_400 },
	});
	// Act
	const readiness = await renewOrganizationStampForUse({
		organizationId,
		stamps: configuration.store.organizationStamps,
		revisions: configuration.store.revisionDelivery,
		centralClient: central.client,
		sign,
		clock: capabilities.clock,
		crypto: capabilities.crypto,
		currentSigningKeyId: 'current-native-key',
		deadline: unreachedDeadline(),
	});
	// Assert
	expect(readiness.kind).toBe('ready');
	const sent = central.sends.at(-1)?.statement;
	if (sent === undefined) throw new Error('Nothing was sent to central');
	expect(recordsOf(capabilities, 'digest')).toContainEqual({
		kind: 'digest',
		algorithm: 'SHA-256',
		inputSha256: sha256Hex(sent),
	});
	expect(recordsOf(capabilities, 'clock-read').length).toBeGreaterThan(0);
});

it("private key export and import: the CLI's Keychain store exports and imports through the host", async () => {
	// Arrange
	const capabilities = recording();
	const store = createMacosKeychainProofKeyStore({
		runner: fakeSecurityRunner(),
		crypto: capabilities.crypto,
		issuer,
		clientId: 'owner-fleet-cli-local',
	});
	// Act
	const key = await store.createKey();
	await store.save({ key, refreshToken: 'refresh-credential' });
	const loaded = await store.load();
	// Assert
	expect(loaded?.key.publicJwk).toEqual(key.publicJwk);
	const { crv, kty, x, y } = key.publicJwk;
	expect(capabilities.records().filter((record) => record.kind !== 'clock-read')).toEqual([
		{
			kind: 'generate-key',
			algorithm: { name: 'ECDSA', namedCurve: 'P-256' },
			extractable: true,
			keyUsages: ['sign', 'verify'],
		},
		{ kind: 'export-key', format: 'jwk', keyType: 'public' },
		{ kind: 'export-key', format: 'jwk', keyType: 'private' },
		{
			kind: 'import-key',
			format: 'jwk',
			algorithm: { name: 'ECDSA', namedCurve: 'P-256' },
			extractable: true,
			keyUsages: ['sign'],
			publicJwkSha256: sha256Hex(JSON.stringify({ crv, kty, x, y })),
		},
	]);
});
