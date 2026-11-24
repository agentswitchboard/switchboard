import { z } from 'zod';

import {
	authorizationSnapshotWindowHolds,
	confirmedFactorShape,
	personFleetApplicationClaimsShape,
} from '#sign-in-core/contracts/person-fleet-token';
import { uuid7Schema } from '#sign-in-core/contracts/sign-in-platform';
import { personIdSchema } from '#sign-in-core/storage/models/sign-in-store';

/** The JOSE `typ` of the person-link token: an access token, as the person-fleet token is. */
export const personLinkTokenType = 'at+jwt';
/** C8 part B: sign-in mints it at the link upgrade and central reads it once, at admission. */
export const personLinkTokenProfile = 'person-link';
/** C8 part B: `exp` follows `iat` by at most this many seconds. */
export const personLinkTokenLifetimeMaximumSeconds = 60;

const epochSecondsClaimSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * The closed person-link claim set. It carries the person-fleet token's authorization facts under
 * its own profile and audience, with a `jti`, no session ID and no `cnf`: the connection central
 * accepts is the binding, so the token is never key-bound.
 */
const personLinkTokenShape = {
	iss: z.url(),
	aud: z.url(),
	sub: personIdSchema,
	iat: epochSecondsClaimSchema,
	exp: epochSecondsClaimSchema,
	jti: uuid7Schema,
	...personFleetApplicationClaimsShape,
	token_profile: z.literal(personLinkTokenProfile),
} as const;

export const personLinkTokenClaimsSchema = z
	.union([
		z.strictObject({ ...personLinkTokenShape, ...confirmedFactorShape }),
		z.strictObject(personLinkTokenShape),
	])
	.refine(
		(claims) =>
			claims.exp > claims.iat && claims.exp - claims.iat <= personLinkTokenLifetimeMaximumSeconds,
		'The person-link token expires within 60 seconds of its issue',
	)
	.refine(
		authorizationSnapshotWindowHolds,
		'The snapshot deadline must follow S by at most the person token lifetime',
	);
export type PersonLinkTokenClaims = z.infer<typeof personLinkTokenClaimsSchema>;
