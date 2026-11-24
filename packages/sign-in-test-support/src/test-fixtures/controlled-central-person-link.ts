import { createHash } from 'node:crypto';

import type { FleetAdminProofKey } from '@agent-collaboration/sign-in-core';
import { decodeProtectedHeader, jwtVerify, SignJWT, type createLocalJWKSet } from 'jose';
import type { Miniflare, WorkerOptions } from 'miniflare';
import { z } from 'zod';

/** The stand-in Worker's name; sign-in's CENTRAL_LINK binding points at it. */
export const personLinkCentralWorkerName = 'central-person-link-fixture';
/** The text frame the stand-in sends on every link it accepts, so a test sees the socket arrive. */
export const personLinkOpenedFrame = 'central-person-link-opened';

/**
 * A stand-in for central's link behind CENTRAL_LINK. It records every upgrade it receives (path,
 * method and every header) and accepts a WebSocket on central's agreed person route,
 * `/v1/organizations/{organization_id}/person-link`. It checks nothing itself: the test checks each
 * recorded arrival with `checkPersonLinkArrival`, as central would, so a wrong build is seen there.
 */
export function personLinkCentralStandIn(): WorkerOptions {
	return {
		config: {
			type: 'worker',
			name: personLinkCentralWorkerName,
			compatibilityDate: '2026-08-15',
			manifest: {
				mainModule: 'person-link.mjs',
				modules: {
					'person-link.mjs': {
						type: 'esm',
						contents: `
							const arrivals = [];
							const personRoute = /^\\/v1\\/organizations\\/[0-9a-f-]{36}\\/person-link$/;
							export default {
								fetch(request) {
									const pathname = new URL(request.url).pathname;
									if (pathname === '/test-arrivals') return Response.json(arrivals);
									arrivals.push({
										pathname,
										method: request.method,
										headers: Object.fromEntries(request.headers),
									});
									if (!personRoute.test(pathname) || request.headers.get('upgrade') !== 'websocket')
										return new Response('not-a-person-link', { status: 404 });
									const pair = new WebSocketPair();
									pair[1].accept();
									pair[1].send(${JSON.stringify(personLinkOpenedFrame)});
									return new Response(null, { status: 101, webSocket: pair[0] });
								}
							};
						`,
					},
				},
			},
		},
	};
}

const arrivalSchema = z.strictObject({
	pathname: z.string(),
	method: z.string(),
	headers: z.record(z.string(), z.string()),
});
export type PersonLinkArrival = z.infer<typeof arrivalSchema>;

export async function personLinkArrivals(
	miniflare: Miniflare,
): Promise<readonly PersonLinkArrival[]> {
	const worker = await miniflare.getWorker(personLinkCentralWorkerName);
	const response = await worker.fetch('https://fixture.invalid/test-arrivals');
	return z.array(arrivalSchema).parse(await response.json());
}

export type PersonLinkArrivalCheck =
	| { readonly kind: 'accepted'; readonly claims: Readonly<Record<string, unknown>> }
	| { readonly kind: 'refused'; readonly reason: string };

/**
 * What central requires of a person's link, checked independently of sign-in's own schema: the
 * agreed path, no cookie and no DPoP material, one Bearer token signed with sign-in's published keys,
 * `typ` at+jwt, the issuer, the person-link audience and profile, a 60-second lifetime, a `jti`, the
 * organization of the path, and no `cnf`.
 */
export async function checkPersonLinkArrival(props: {
	readonly arrival: PersonLinkArrival;
	readonly organizationId: string;
	readonly issuer: string;
	readonly audience: string;
	readonly keys: ReturnType<typeof createLocalJWKSet>;
	readonly now: number;
}): Promise<PersonLinkArrivalCheck> {
	const { arrival } = props;
	const refused = (reason: string): PersonLinkArrivalCheck => ({ kind: 'refused', reason });
	if (arrival.pathname !== `/v1/organizations/${props.organizationId}/person-link`)
		return refused('path');
	if (arrival.method !== 'GET' || arrival.headers.upgrade !== 'websocket')
		return refused('not-an-upgrade');
	if ('cookie' in arrival.headers) return refused('cookie');
	if ('dpop' in arrival.headers) return refused('dpop');
	const token = /^Bearer ([^\s]+)$/u.exec(arrival.headers.authorization ?? '')?.[1];
	if (token === undefined) return refused('authorization');
	if (decodeProtectedHeader(token).typ !== 'at+jwt') return refused('typ');
	let claims: Readonly<Record<string, unknown>>;
	try {
		claims = (
			await jwtVerify(token, props.keys, {
				issuer: props.issuer,
				audience: props.audience,
				currentDate: new Date(props.now),
			})
		).payload;
	} catch {
		return refused('signature-issuer-or-audience');
	}
	if (claims.token_profile !== 'person-link') return refused('profile');
	if ('cnf' in claims) return refused('cnf');
	if ('sid' in claims) return refused('sid');
	if (claims.organization_id !== props.organizationId) return refused('organization');
	const lifetime = z
		.object({ iat: z.number().int(), exp: z.number().int(), jti: z.uuidv7() })
		.safeParse(claims);
	if (!lifetime.success || lifetime.data.exp - lifetime.data.iat > 60) return refused('lifetime');
	return { kind: 'accepted', claims };
}

/**
 * The CLI's DPoP proof over the upgrade (RFC 9449): htm GET, htu the public link URL, and `ath`
 * binding the person-fleet token, signed with the key the token is bound to.
 */
export async function signPersonLinkUpgradeProof(props: {
	readonly key: FleetAdminProofKey;
	readonly htu: string;
	readonly jti: string;
	readonly issuedAtSeconds: number;
	readonly accessToken: string;
}): Promise<string> {
	return new SignJWT({
		jti: props.jti,
		htm: 'GET',
		htu: props.htu,
		iat: props.issuedAtSeconds,
		ath: createHash('sha256').update(props.accessToken).digest('base64url'),
	})
		.setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: { ...props.key.publicJwk } })
		.sign(props.key.privateKey);
}
