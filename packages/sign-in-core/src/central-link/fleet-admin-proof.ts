import { decodeJwt } from 'jose';

import { revokeMachineEnrollmentPath } from '#sign-in-core/central-link/fleet-admin-client';
import type {
	OrganizationAdminIntent_Serialize,
	ProofClaims,
	ProofHeader,
	ProofJwk,
} from '#sign-in-core/central-link/generated/central-sign-in.gen';
import { canonicalJson } from '#sign-in-core/contracts/canonical-json';
import { personFleetTokenClaimsSchema } from '#sign-in-core/contracts/person-fleet-token';
import type {
	SignInCrypto,
	SignInEcPrivateJwk,
	SignInExportedJwk,
} from '#sign-in-core/contracts/sign-in-platform';
import type { RevokeMachineEnrollmentRequest } from '#sign-in-core/machine-login/machine-login-contracts';
import { base64UrlSha256 } from '#sign-in-core/organizations/fleet-admin-operation';

/**
 * One key per admin request, held only in that request's memory.
 * The private half is non-extractable, so it cannot be logged, stored or returned.
 */
export interface FleetAdminProofKey {
	readonly privateKey: CryptoKey;
	readonly publicJwk: Readonly<
		ProofJwk & {
			readonly kty: 'EC';
			readonly crv: 'P-256';
		}
	>;
}

/** An ES256 private key as JWK: only for the CLI's Keychain item. */
export type FleetAdminPrivateJwk = SignInEcPrivateJwk;

function publicJwk(exported: SignInExportedJwk): FleetAdminProofKey['publicJwk'] {
	if (
		exported.kty !== 'EC' ||
		exported.crv !== 'P-256' ||
		exported.x === undefined ||
		exported.y === undefined
	)
		throw new Error('Unexpected proof key shape');
	return { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y };
}

/**
 * A fresh ES256 key. Non-extractable by default (the admin page, and the CLI when it holds the
 * key in memory only); `extractable` only for the CLI's macOS Keychain custody (t15b), whose
 * accepted cost is that the private JWK then lives in the Keychain item.
 */
export async function createFleetAdminProofKey(
	crypto: SignInCrypto,
	options: { readonly extractable?: boolean } = {},
): Promise<FleetAdminProofKey> {
	const pair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		options.extractable === true,
		['sign', 'verify'],
	);
	return {
		privateKey: pair.privateKey,
		publicJwk: publicJwk(await crypto.subtle.exportKey('jwk', pair.publicKey)),
	};
}

/** The private JWK of an extractable key, for the Keychain item only. */
export async function exportFleetAdminPrivateJwk(
	crypto: SignInCrypto,
	key: FleetAdminProofKey,
): Promise<FleetAdminPrivateJwk> {
	const exported = await crypto.subtle.exportKey('jwk', key.privateKey);
	if (exported.d === undefined) throw new Error('Proof key has no private part');
	return { ...publicJwk(exported), d: exported.d };
}

/**
 * A stored private JWK back as a signing key. Non-extractable unless `extractable`: the CLI's
 * Keychain store must be able to save this same key again with its rotated refresh credential.
 */
export async function importFleetAdminProofKey(
	crypto: SignInCrypto,
	privateJwk: FleetAdminPrivateJwk,
	options: { readonly extractable?: boolean } = {},
): Promise<FleetAdminProofKey> {
	const privateKey = await crypto.subtle.importKey(
		'jwk',
		{ ...privateJwk },
		{ name: 'ECDSA', namedCurve: 'P-256' },
		options.extractable === true,
		['sign'],
	);
	return { privateKey, publicJwk: publicJwk(privateJwk) };
}

/** RFC 7638 thumbprint: the required members in lexicographic order, SHA-256, base64url. */
export async function fleetAdminProofKeyThumbprint(
	crypto: SignInCrypto,
	key: FleetAdminProofKey,
): Promise<string> {
	const { crv, kty, x, y } = key.publicJwk;
	return base64UrlSha256(crypto, canonicalJson({ crv, kty, x, y }));
}

/**
 * A DPoP proof (RFC 9449). For the token endpoint it carries only the standard claims; for
 * central it also binds the token (`ath`) and the operation (`intent`), which central's
 * closed claim set requires.
 */
export async function signFleetAdminProof(
	crypto: SignInCrypto,
	props: {
		readonly key: FleetAdminProofKey;
		readonly htu: string;
		readonly requestId: string;
		readonly issuedAtSeconds: number;
		readonly bound?: { readonly accessToken: string; readonly intent: string };
	},
): Promise<string> {
	const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: props.key.publicJwk } satisfies ProofHeader;
	const requestClaims = {
		jti: props.requestId,
		htm: 'POST',
		htu: props.htu,
		iat: props.issuedAtSeconds,
	} satisfies Omit<ProofClaims, 'ath' | 'intent'>;
	const claims =
		props.bound === undefined
			? requestClaims
			: ({
					...requestClaims,
					ath: await base64UrlSha256(crypto, props.bound.accessToken),
					intent: props.bound.intent,
				} satisfies ProofClaims);
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
	// WebCrypto ECDSA returns IEEE P1363 r||s, which is exactly the JWS ES256 encoding.
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		props.key.privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

export async function signMachineEnrollmentRevocationProof(
	crypto: SignInCrypto,
	props: {
		readonly key: FleetAdminProofKey;
		readonly centralOrigin: string;
		readonly requestId: string;
		readonly issuedAtSeconds: number;
		readonly accessToken: string;
		readonly request: RevokeMachineEnrollmentRequest;
	},
): Promise<string> {
	const claims = personFleetTokenClaimsSchema.parse(decodeJwt(props.accessToken));
	if (
		claims.organization_id !== props.request.organizationId ||
		claims.cnf.jkt !== (await fleetAdminProofKeyThumbprint(crypto, props.key)) ||
		!claims.permissions.includes('machine:revoke')
	)
		throw new Error('Person credential does not permit this revocation');
	return signFleetAdminProof(crypto, {
		key: props.key,
		htu: `${props.centralOrigin}${revokeMachineEnrollmentPath}`,
		requestId: props.requestId,
		issuedAtSeconds: props.issuedAtSeconds,
		bound: {
			accessToken: props.accessToken,
			intent: await base64UrlSha256(
				crypto,
				canonicalJson({
					v: 1,
					operation: 'RevokeMachineEnrollment',
					organization: props.request.organizationId,
					target: props.request.enrollmentId,
					operationId: null,
					params: { actor: claims.sub, secondFactorAt: claims.second_factor_at ?? null },
				} satisfies Extract<
					OrganizationAdminIntent_Serialize,
					{ operation: 'RevokeMachineEnrollment' }
				>),
			),
		},
	});
}

function base64UrlJson(value: unknown): string {
	return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
