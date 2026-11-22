import { z } from 'zod';

import type { PersonClaims_Deserialize } from '#sign-in-core/central-link/generated/central-sign-in.gen';
import { fleetPermissionSchema } from '#sign-in-core/organizations/fleet-permission';
import { secondFactorMethodSchema } from '#sign-in-core/second-factors/second-factor-step-up';

/** r3 section 4: the person's access token lifetime bounds the snapshot window. */
export const personFleetSnapshotWindowMaximumMilliseconds = 300_000;

const epochMillisecondsClaimSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revisionClaimSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const uuid7ClaimSchema = z.uuidv7();

/** The application claims the contributor adds; native `iss`, `aud`, `sub`, `sid`, `iat`, `exp` and `cnf` stay the AS's. */
const personFleetApplicationClaimsShape = {
	token_profile: z.literal('person-fleet'),
	organization_id: uuid7ClaimSchema,
	authorization_subject_id: uuid7ClaimSchema,
	person_revision: revisionClaimSchema,
	organization_revision: revisionClaimSchema,
	permission_policy_digest: z.string().regex(/^[0-9a-f]{64}$/u),
	permissions: z.array(fleetPermissionSchema).readonly(),
	session_expires_at_ms: epochMillisecondsClaimSchema,
	authorization_snapshot_at_ms: epochMillisecondsClaimSchema,
	authorization_snapshot_valid_until_ms: epochMillisecondsClaimSchema,
} as const;

/** The session's original confirmation, in seconds, exactly as the management profile carries it. */
const confirmedFactorShape = {
	second_factor_at: z.number().int().nonnegative(),
	second_factor_method: secondFactorMethodSchema,
} as const;

/** Exactly the claims the contributor returns, with or without original factor facts. */
export const personFleetApplicationClaimsSchema = z
	.union([
		z.strictObject({ ...personFleetApplicationClaimsShape, ...confirmedFactorShape }),
		z.strictObject(personFleetApplicationClaimsShape),
	])
	.refine(
		(claims) =>
			claims.authorization_snapshot_valid_until_ms > claims.authorization_snapshot_at_ms &&
			claims.authorization_snapshot_valid_until_ms - claims.authorization_snapshot_at_ms <=
				personFleetSnapshotWindowMaximumMilliseconds,
		'The snapshot deadline must follow S by at most the person token lifetime',
	);
export type PersonFleetApplicationClaims = z.infer<typeof personFleetApplicationClaimsSchema>;
/** Claims contributed by Sign-in before the native issuer adds its JWT fields. */
export type PersonFleetJwtInputClaims = Omit<
	PersonClaims_Deserialize,
	'iss' | 'aud' | 'sub' | 'sid' | 'iat' | 'exp' | 'cnf'
>;

/** A signed person-fleet token as the release fence reads it: the application claims plus native ones. */
export const personFleetTokenClaimsSchema = z.looseObject({
	...personFleetApplicationClaimsShape,
	second_factor_at: confirmedFactorShape.second_factor_at.optional(),
	second_factor_method: confirmedFactorShape.second_factor_method.optional(),
	iss: z.string(),
	aud: z.string(),
	sub: z.string(),
	sid: z.string(),
	iat: z.number().int(),
	exp: z.number().int(),
	cnf: z.looseObject({ jkt: z.string().min(1) }),
});
export type PersonFleetTokenClaims = PersonClaims_Deserialize;
