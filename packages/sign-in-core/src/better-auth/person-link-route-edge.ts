import {
	createDpopReplayStore,
	isDpopProofError,
	verifyDpopProof,
	verifyJwsAccessToken,
	type DpopReplayStore,
} from '@better-auth/core/oauth2';
import { z } from 'zod';

import { fleetPermissionsForRole } from '#sign-in-core/better-auth/fleet-permission-policy';
import type { SignInProvider } from '#sign-in-core/better-auth/provider-configuration';
import { personSessionPorts } from '#sign-in-core/better-auth/store-result-adapters';
import { centralLinkUpgradeRequest } from '#sign-in-core/central-link/central-link-upgrade';
import type { SignInConfiguration } from '#sign-in-core/contracts/deployment-configuration';
import { personFleetTokenClaimsSchema } from '#sign-in-core/contracts/person-fleet-token';
import { uuid7Schema, type SignInPlatform } from '#sign-in-core/contracts/sign-in-platform';
import {
	decidePersonLinkRoute,
	type PersonLinkAuthentication,
	type PersonLinkRefusal,
} from '#sign-in-core/person-link/person-link-route';
import { personIdSchema, type SignInStore } from '#sign-in-core/storage/models/sign-in-store';

/**
 * The host's hop to central's link: CENTRAL_LINK on Cloudflare, central's socket on Node. It is
 * given the upgrade sign-in built and returns central's answer, which goes back unchanged.
 */
export type PersonLinkForwarder = (upstream: Request) => Promise<Response>;

const publishedJwksSchema = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) });

/**
 * The host edge of C8 part B: wires the decision's ports to Better Auth and the store, turns a
 * refusal into a Response, and forwards an accepted upgrade with only the person-link token.
 */
export async function respondToPersonLink(props: {
	readonly request: Request;
	readonly configuration: SignInConfiguration;
	readonly platform: Pick<SignInPlatform, 'clock' | 'ids'>;
	readonly store: Pick<SignInStore, 'persons' | 'authorizations'>;
	readonly provider: SignInProvider;
	readonly forward: PersonLinkForwarder | undefined;
}): Promise<Response> {
	const { request, configuration, platform } = props;
	const pathname = new URL(request.url).pathname;
	const persons = personSessionPorts(props.store.persons);
	const outcome = await decidePersonLinkRoute({
		request: { method: request.method, pathname, headers: request.headers },
		configuration,
		ports: {
			clock: platform.clock,
			ids: platform.ids,
			permissionsForRole: fleetPermissionsForRole,
			async authenticateBrowserSession(): Promise<PersonLinkAuthentication> {
				try {
					const current = await props.provider.api.getSession({
						headers: request.headers,
						query: { disableCookieCache: true, disableRefresh: true },
					});
					if (
						current === null ||
						!current.user.emailVerified ||
						!(await persons.isPersonSessionActive(current.user.id, current.session.id))
					)
						return { kind: 'refused' };
					return {
						kind: 'authenticated',
						caller: {
							personId: personIdSchema.parse(current.user.id),
							sessionId: uuid7Schema.parse(current.session.id),
						},
					};
				} catch {
					return { kind: 'unavailable' };
				}
			},
			async authenticateCliCredential({ accessToken, proof }): Promise<PersonLinkAuthentication> {
				// The token is the person-fleet token sign-in issued: its signature against this
				// deployment's own JWKS, its issuer, the admin audience and its closed profile.
				let claims;
				try {
					claims = personFleetTokenClaimsSchema.safeParse(
						await verifyJwsAccessToken(accessToken, {
							// This deployment's published keys, read from the provider's own JWKS endpoint.
							jwksFetch: async () => publishedJwksSchema.parse(await props.provider.api.getJwks()),
							verifyOptions: {
								issuer: configuration.issuer,
								audience: configuration.centralAdminAudience,
								typ: 'at+jwt',
								currentDate: new Date(platform.clock.now()),
							},
						}),
					);
				} catch {
					return { kind: 'refused' };
				}
				if (!claims.success) return { kind: 'refused' };
				// The proof is Better Auth's own DPoP check, as the token endpoint runs it: this
				// upgrade's method and URL, the token's hash and key, and a stored one-time `jti`.
				try {
					const context = await props.provider.$context;
					await verifyDpopProof({
						proofJwt: proof,
						method: 'GET',
						url: new URL(pathname, configuration.issuer).toString(),
						accessToken,
						expectedJkt: claims.data.cnf.jkt,
						requireAth: true,
						nowSeconds: Math.floor(platform.clock.now() / 1000),
						replayStore: replayStoreCoveringLastAcceptedSecond(
							createDpopReplayStore(context.internalAdapter),
						),
					});
				} catch (error) {
					return isDpopProofError(error) ? { kind: 'refused' } : { kind: 'unavailable' };
				}
				const personId = personIdSchema.safeParse(claims.data.sub);
				const sessionId = uuid7Schema.safeParse(claims.data.sid);
				return personId.success && sessionId.success
					? {
							kind: 'authenticated',
							caller: { personId: personId.data, sessionId: sessionId.data },
						}
					: { kind: 'refused' };
			},
			async readAuthorizationSnapshot(caller, organizationId) {
				return props.store.authorizations.readPersonFleetSnapshot(
					caller.personId,
					caller.sessionId,
					organizationId,
				);
			},
			async signToken(claims) {
				try {
					const signed = await props.provider.api.signPersonLinkToken({ body: claims });
					return { kind: 'signed', token: signed.token };
				} catch {
					return { kind: 'unavailable' };
				}
			},
		},
	});
	if (outcome.kind === 'refuse') return personLinkRefusalResponse(outcome);
	if (props.forward === undefined)
		return personLinkRefusalResponse({
			kind: 'refuse',
			status: 503,
			reason: 'central-link-unavailable',
		});
	try {
		return await props.forward(
			centralLinkUpgradeRequest({
				principal: 'person',
				organizationId: outcome.organizationId,
				authorization: `Bearer ${outcome.token}`,
				handshake: request.headers,
			}),
		);
	} catch {
		return personLinkRefusalResponse({
			kind: 'refuse',
			status: 503,
			reason: 'central-link-unavailable',
		});
	}
}

/**
 * Keeps every DPoP replay marker one full second past the last instant its proof is accepted.
 *
 * Better Auth 1.7.11 accepts a proof through the whole second `iat + maxAge`: it refuses only when
 * `nowSeconds - iat > proofMaxAgeSeconds` (`@better-auth/core/dist/oauth2/dpop.mjs:171`). But it
 * reserves the replay marker until `(iat + maxAge) * 1000` ms, the start of that second (`:185`).
 * Verification cleanup deletes rows by millisecond time (`expiresAt < now`), so during that last
 * accepted second a used proof's marker can already be gone and the same proof reserved again.
 *
 * Remove when upstream aligns acceptance and retention. The defect, its evidence, how to recreate
 * it and the removal check are in `dpop-replay-window.workaround.md` beside this file.
 */
function replayStoreCoveringLastAcceptedSecond(store: DpopReplayStore): DpopReplayStore {
	return {
		reserve: (reservation) =>
			store.reserve({
				...reservation,
				expiresAt: new Date(reservation.expiresAt.getTime() + 1000),
			}),
	};
}

function personLinkRefusalResponse(refusal: PersonLinkRefusal): Response {
	return Response.json(
		{ error: refusal.reason },
		{
			status: refusal.status,
			headers: {
				'cache-control': 'no-store',
				...(refusal.status === 405 ? { allow: 'GET' } : {}),
			},
		},
	);
}
