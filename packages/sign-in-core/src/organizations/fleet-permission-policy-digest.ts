/**
 * T15: SHA-256 of the RFC 8785 serialization of the role → Fleet permission policy
 * (`fleetPermissionPolicy` at the Better Auth boundary). Pinned so every process names its
 * loaded mapping without awaiting a hash; the policy's unit test recomputes it, so a changed
 * mapping cannot ship under this digest. A new mapping ships through the org fence's
 * stop/resume with a new digest.
 */
export const fleetPermissionPolicyDigest =
	'88fe6f138c24f3e2d18accacf2077a12339076905e1c85bc76dd18632cab6054';
