/**
 * T15: SHA-256 of the RFC 8785 serialization of the role → Fleet permission policy
 * (`fleetPermissionPolicy` at the Better Auth boundary). Pinned so every process names its
 * loaded mapping without awaiting a hash; the policy's unit test recomputes it, so a changed
 * mapping cannot ship under this digest. New organization fences start with the loaded
 * digest. Issuance refuses existing fences stamped with a different digest.
 */
export const fleetPermissionPolicyDigest =
	'e51bacbfa4924d46bc2381bbafaf9cb35b9dd452a5c5ded2dfa77a931004a3cb';
