# Workaround: DPoP replay window in Better Auth 1.7.11

`replayStoreCoveringLastAcceptedSecond` in `person-link-route-edge.ts` works around an upstream defect. This note is its record.

## Defect

In `@better-auth/core` 1.7.11, `dist/oauth2/dpop.mjs` accepts a proof for longer than it keeps the proof's replay marker:

- **`:171`** refuses a proof only when `nowSeconds - iat > proofMaxAgeSeconds`. So `nowSeconds - iat === maxAge` is still accepted: the whole second `iat + maxAge`.
- **`:185`** reserves the replay marker with `expiresAt = (iat + maxAge) * 1000` ms. That is the start of the same second.

The cleanup is `better-auth` 1.7.11 `dist/db/internal-adapter.mjs:767-771` (`findVerificationValue`). It deletes `verification` rows with `expiresAt < now`, by millisecond.

So within that last accepted second, a used proof's marker can already be gone, and the same proof can be reserved again.

The wrapper keeps every marker until `expiresAt + 1000` ms, past the last accepted instant.

## Evidence

`packages/sign-in-test-support/src/person-link.host.e2e.test.ts:365`, "refuses a used CLI proof replayed in its last accepted second, after the store cleans expired markers". It runs on both hosts.

Without the wrapper:

- on workerd the replayed proof is forwarded and a link to central opens;
- on Node it reaches the forward step.

With the wrapper it is refused 401 `proof-refused`.

## How to recreate it

Use the controlled clock throughout; there is no wall clock.

1. Sign in the fleet CLI, which gives a person-fleet token and its key.
2. Sign one DPoP proof for the person-link upgrade:
   - `htm` GET;
   - `htu` the public link URL;
   - `ath` the token's hash;
   - `iat` 10 s before now, so its last accepted second is still inside the token's 300 s lifetime.
3. Send the upgrade with the token and the proof. It is accepted.
4. Set the clock to `(iat + 300) * 1000 + 300` ms, a few hundred milliseconds into the last accepted second. The default maximum age is 300 s.
5. Run the store's cleanup predicate: delete `verification` rows whose `expiresAt` is before now.
6. Send the same proof with the same, still valid, token.
   - Expected: 401, and nothing reaches central.
   - Without the wrapper: it is accepted again.

## Removal check

Remove the wrapper when a Better Auth release sets the marker expiry at or after the end of the last accepted second (`expiresAt >= (iat + maxAge + 1) * 1000` ms), or stops accepting that second. Then:

1. Delete `replayStoreCoveringLastAcceptedSecond` and pass `createDpopReplayStore(context.internalAdapter)` directly.
2. Confirm the test above still passes on both hosts with the library store alone.

## The path this cannot fix

The provider's own DPoP checks build the library store directly: `@better-auth/oauth-provider` 1.7.11 `dist/introspect-*.mjs:1216` (`userInfoEndpoint`) and `:1659` (`resolveDpopTokenBinding`, the token endpoint's binding).
