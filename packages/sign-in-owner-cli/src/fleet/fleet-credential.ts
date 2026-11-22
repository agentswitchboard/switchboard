import { createHash, randomBytes } from 'node:crypto';

import {
	fleetAdminProofKeyThumbprint,
	signFleetAdminProof,
	type FleetAdminProofKey,
	type PersonFleetTokenClaims,
	type SignInCrypto,
} from '@agent-collaboration/sign-in-core';
import { z } from 'zod';

import type { FleetTarget } from '#sign-in-owner-cli/auth-target';
import type { ProofKeyStore } from '#sign-in-owner-cli/fleet/proof-key-store';
import { authorizeThroughLoopback } from '#sign-in-owner-cli/loopback-authorization';

/** Everything the fleet CLI reaches outside itself, injected so tests run no real clock. */
export interface FleetCliIo {
	readonly fetch: (input: URL | string, init?: RequestInit) => Promise<Response>;
	readonly now: () => number;
	readonly nextId: () => string;
	readonly crypto: SignInCrypto;
	readonly browser: (url: string) => Promise<void>;
}

/** A person-fleet access token bound to the CLI's key, which also signs every proof. */
export interface FleetCliSession {
	readonly accessToken: string;
	readonly key: FleetAdminProofKey;
}

/** The token endpoint said no; `error` is its OAuth error code. */
export class FleetCliTokenRefusal extends Error {
	// An explicit field: the delivered entry point runs under Node's type stripping.
	readonly error: string;
	constructor(error: string) {
		super(`Fleet sign-in refused (${error})`);
		this.error = error;
	}
}

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.literal('DPoP'),
	refresh_token: z.string().min(1),
});
const issuedClaimsSchema = z.looseObject({
	aud: z.string(),
	client_id: z.string(),
	token_profile: z.literal('person-fleet'),
	cnf: z.looseObject({ jkt: z.string() }),
}) satisfies z.ZodType<Pick<PersonFleetTokenClaims, 'aud' | 'token_profile' | 'cnf'>>;

function decodePayload(token: string): unknown {
	const encoded = token.split('.')[1];
	if (encoded === undefined) throw new Error('Fleet token is not a JWT');
	return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

/** One token-endpoint call with a DPoP proof from `key`; the result must be bound to that key. */
async function exchangeWithKey(props: {
	readonly target: FleetTarget;
	readonly key: FleetAdminProofKey;
	readonly io: FleetCliIo;
	readonly form: Readonly<Record<string, string>>;
}): Promise<{ readonly accessToken: string; readonly refreshToken: string }> {
	const tokenEndpoint = new URL('/api/auth/oauth2/token', props.target.issuer).toString();
	const response = await props.io.fetch(tokenEndpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			dpop: await signFleetAdminProof(props.io.crypto, {
				key: props.key,
				htu: tokenEndpoint,
				requestId: props.io.nextId(),
				issuedAtSeconds: Math.floor(props.io.now() / 1000),
			}),
		},
		body: new URLSearchParams({
			...props.form,
			client_id: props.target.ownerFleetCliClientId,
			resource: props.target.centralAdminAudience,
		}),
	});
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok)
		throw new FleetCliTokenRefusal(
			z.object({ error: z.string() }).catch({ error: 'unavailable' }).parse(body).error,
		);
	const tokens = tokenResponseSchema.parse(body);
	const claims = issuedClaimsSchema.parse(decodePayload(tokens.access_token));
	if (
		claims.aud !== props.target.centralAdminAudience ||
		claims.client_id !== props.target.ownerFleetCliClientId ||
		claims.cnf.jkt !== (await fleetAdminProofKeyThumbprint(props.io.crypto, props.key))
	)
		throw new Error('Fleet token is not bound to this CLI key');
	return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token };
}

/** Loopback code + S256 with a new key; the code exchange binds the token and refresh to it. */
export async function signInFleetCli(props: {
	readonly target: FleetTarget;
	readonly store: ProofKeyStore;
	readonly io: FleetCliIo;
}): Promise<FleetCliSession> {
	const key = await props.store.createKey();
	const verifier = randomBytes(32).toString('base64url');
	const { code, redirectUri } = await authorizeThroughLoopback({
		issuer: props.target.issuer,
		redirectUri: props.target.ownerCliRedirectUri,
		clientId: props.target.ownerFleetCliClientId,
		scope: 'fleet:admin offline_access',
		resource: props.target.centralAdminAudience,
		codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
		browser: props.io.browser,
	});
	const issued = await exchangeWithKey({
		...props,
		key,
		form: {
			grant_type: 'authorization_code',
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		},
	});
	await props.store.save({ key, refreshToken: issued.refreshToken });
	return { accessToken: issued.accessToken, key };
}

/**
 * A fresh access token from the stored key and refresh credential, keeping the rotated
 * credential. Returns null when there is none or the issuer refuses it, so the caller signs in.
 */
export async function refreshFleetCli(props: {
	readonly target: FleetTarget;
	readonly store: ProofKeyStore;
	readonly io: FleetCliIo;
}): Promise<FleetCliSession | null> {
	const stored = await props.store.load();
	if (stored === null) return null;
	try {
		const issued = await exchangeWithKey({
			...props,
			key: stored.key,
			form: { grant_type: 'refresh_token', refresh_token: stored.refreshToken },
		});
		await props.store.save({ key: stored.key, refreshToken: issued.refreshToken });
		return { accessToken: issued.accessToken, key: stored.key };
	} catch (error) {
		if (!(error instanceof FleetCliTokenRefusal)) throw error;
		await props.store.remove();
		return null;
	}
}

/** Refresh when a credential is held; otherwise, or when it is refused, sign in again. */
export async function fleetCliSession(props: {
	readonly target: FleetTarget;
	readonly store: ProofKeyStore;
	readonly io: FleetCliIo;
}): Promise<FleetCliSession> {
	return (await refreshFleetCli(props)) ?? signInFleetCli(props);
}
