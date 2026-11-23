import type {
	CentralLinkClient,
	SignInClock,
	SignInCrypto,
	SignInEcdsaKeyAlgorithm,
	SignInEcdsaSignatureAlgorithm,
	SignInIdSource,
	SignInKeyUsage,
} from '@agent-collaboration/sign-in-core';
import { createWebSignInCapabilities } from '@agent-collaboration/sign-in-platform-web';

import { controlledSignInClock } from '#sign-in-test-support/test-fixtures/controlled-sign-in-clock';

/**
 * The hosts' own Web Crypto, taken from the shared builder (with the controlled clock, so the
 * builder's real-time default is never reached). Tests that only need a working crypto use it.
 */
export const webSignInCrypto: SignInCrypto =
	createWebSignInCapabilities(controlledSignInClock).crypto;

/** Each input is kept only as its SHA-256 (lowercase hex); key material is never recorded. */
export type SignInCapabilityRecord =
	| { readonly kind: 'random'; readonly byteLength: number }
	| { readonly kind: 'digest'; readonly algorithm: 'SHA-256'; readonly inputSha256: string }
	| {
			readonly kind: 'generate-key';
			readonly algorithm: SignInEcdsaKeyAlgorithm;
			readonly extractable: boolean;
			readonly keyUsages: readonly SignInKeyUsage[];
	  }
	| {
			readonly kind: 'export-key';
			readonly format: 'jwk';
			readonly keyType: CryptoKey['type'];
	  }
	| {
			readonly kind: 'import-key';
			readonly format: 'jwk';
			readonly algorithm: SignInEcdsaKeyAlgorithm;
			readonly extractable: boolean;
			readonly keyUsages: readonly SignInKeyUsage[];
			/** SHA-256 of the JWK's public members only: `{crv,kty,x,y}` as JSON. */
			readonly publicJwkSha256: string;
	  }
	| {
			readonly kind: 'sign';
			readonly algorithm: SignInEcdsaSignatureAlgorithm;
			readonly inputSha256: string;
	  }
	| { readonly kind: 'clock-read'; readonly now: number }
	| { readonly kind: 'id-minted'; readonly id: string }
	| { readonly kind: 'central-call'; readonly operation: keyof CentralLinkClient };

export interface RecordingSignInCapabilities {
	readonly crypto: SignInCrypto;
	readonly clock: SignInClock;
	readonly ids: SignInIdSource;
	/** The same client, with every call recorded before it is sent. */
	readonly recordCentralClient: (client: CentralLinkClient) => CentralLinkClient;
	/** Every call so far, in the order each was made. */
	readonly records: () => readonly SignInCapabilityRecord[];
}

/**
 * Wraps real capabilities so a test sees every crypto, clock, ID and central call the core
 * makes (R30, proof row U23). `randomBytes` replaces the random source with known bytes;
 * without it the wrapped crypto's own randomness is used.
 */
export function createRecordingSignInCapabilities(props: {
	readonly crypto: SignInCrypto;
	readonly clock: SignInClock;
	readonly ids: SignInIdSource;
	readonly randomBytes?: (byteLength: number) => Uint8Array<ArrayBuffer>;
}): RecordingSignInCapabilities {
	const recorded: SignInCapabilityRecord[] = [];
	// The recorder's own hashing goes straight to the wrapped crypto, so it is never recorded.
	async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
		const digest = new Uint8Array(await props.crypto.subtle.digest('SHA-256', data));
		return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	}
	const crypto: SignInCrypto = {
		getRandomValues: (bytes) => {
			recorded.push({ kind: 'random', byteLength: bytes.byteLength });
			if (props.randomBytes === undefined) return props.crypto.getRandomValues(bytes);
			const fixed = props.randomBytes(bytes.byteLength);
			if (fixed.byteLength !== bytes.byteLength)
				throw new RangeError('Fixed random bytes must match the requested length');
			bytes.set(fixed);
			return bytes;
		},
		subtle: {
			digest: async (algorithm, data) => {
				recorded.push({ kind: 'digest', algorithm, inputSha256: await sha256Hex(data) });
				return props.crypto.subtle.digest(algorithm, data);
			},
			generateKey: async (algorithm, extractable, keyUsages) => {
				recorded.push({
					kind: 'generate-key',
					algorithm: { ...algorithm },
					extractable,
					keyUsages: [...keyUsages],
				});
				return props.crypto.subtle.generateKey(algorithm, extractable, keyUsages);
			},
			exportKey: async (format, key) => {
				recorded.push({ kind: 'export-key', format, keyType: key.type });
				return props.crypto.subtle.exportKey(format, key);
			},
			importKey: async (format, keyData, algorithm, extractable, keyUsages) => {
				recorded.push({
					kind: 'import-key',
					format,
					algorithm: { ...algorithm },
					extractable,
					keyUsages: [...keyUsages],
					publicJwkSha256: await sha256Hex(
						new TextEncoder().encode(
							JSON.stringify({
								crv: keyData.crv,
								kty: keyData.kty,
								x: keyData.x,
								y: keyData.y,
							}),
						),
					),
				});
				return props.crypto.subtle.importKey(format, keyData, algorithm, extractable, keyUsages);
			},
			sign: async (algorithm, key, data) => {
				recorded.push({
					kind: 'sign',
					algorithm: { ...algorithm },
					inputSha256: await sha256Hex(data),
				});
				return props.crypto.subtle.sign(algorithm, key, data);
			},
		},
	};
	const clock: SignInClock = {
		now: () => {
			const now = props.clock.now();
			recorded.push({ kind: 'clock-read', now });
			return now;
		},
	};
	const ids: SignInIdSource = {
		nextId: () => {
			const id = props.ids.nextId();
			recorded.push({ kind: 'id-minted', id });
			return id;
		},
	};
	function recordCentralClient(client: CentralLinkClient): CentralLinkClient {
		return {
			provisionOrganization: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'provisionOrganization' });
				return client.provisionOrganization(request);
			},
			readStatementDigest: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'readStatementDigest' });
				return client.readStatementDigest(request);
			},
			pushAuthorizationRevision: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'pushAuthorizationRevision' });
				return client.pushAuthorizationRevision(request);
			},
			sendFleetAdminRequest: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'sendFleetAdminRequest' });
				return client.sendFleetAdminRequest(request);
			},
			relayFleetAdminRequest: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'relayFleetAdminRequest' });
				return client.relayFleetAdminRequest(request);
			},
			sendApprovalPersonRequest: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'sendApprovalPersonRequest' });
				return client.sendApprovalPersonRequest(request);
			},
			relayApprovalPersonRequest: async (request) => {
				recorded.push({ kind: 'central-call', operation: 'relayApprovalPersonRequest' });
				return client.relayApprovalPersonRequest(request);
			},
		};
	}
	return { crypto, clock, ids, recordCentralClient, records: () => [...recorded] };
}
