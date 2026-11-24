import {
	personLinkTokenClaimsSchema,
	personLinkTokenLifetimeMaximumSeconds,
	personLinkTokenProfile,
	type PersonLinkTokenClaims,
} from '#sign-in-core/contracts/person-link-token';
import type { Uuid7 } from '#sign-in-core/contracts/sign-in-platform';
import {
	decidePersonFleetIssuance,
	type PersonFleetIssuanceRefusal,
} from '#sign-in-core/organizations/person-fleet-issuance';
import type { PersonId } from '#sign-in-core/storage/models/sign-in-store';

export type PersonLinkClaimsRefusal = PersonFleetIssuanceRefusal | 'invalid-claims';
export type PersonLinkClaimsDecision =
	| { readonly kind: 'mint'; readonly claims: PersonLinkTokenClaims }
	| { readonly kind: 'refused'; readonly reason: PersonLinkClaimsRefusal };

/**
 * Pure: the person-fleet claim builder's decision, re-profiled for the person-link token. The
 * authorization facts and every refusal are the person-fleet issuance's own; this adds the issuer,
 * the person-link audience, the subject, a 60-second lifetime and the `jti`. The token is never
 * key-bound, so there is no `cnf` (the closed schema refuses one).
 */
export function decidePersonLinkClaims(props: {
	readonly issuance: Parameters<typeof decidePersonFleetIssuance>[0];
	readonly issuer: string;
	readonly audience: string;
	readonly subject: PersonId;
	readonly issuedAtSeconds: number;
	readonly tokenId: Uuid7;
}): PersonLinkClaimsDecision {
	const issuance = decidePersonFleetIssuance(props.issuance);
	if (issuance.kind === 'refused') return issuance;
	const claims = personLinkTokenClaimsSchema.safeParse({
		...issuance.claims,
		token_profile: personLinkTokenProfile,
		iss: props.issuer,
		aud: props.audience,
		sub: props.subject,
		iat: props.issuedAtSeconds,
		exp: props.issuedAtSeconds + personLinkTokenLifetimeMaximumSeconds,
		jti: props.tokenId,
	});
	return claims.success
		? { kind: 'mint', claims: claims.data }
		: { kind: 'refused', reason: 'invalid-claims' };
}
