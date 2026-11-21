# Sign-in Hegel campaigns

These permanent tests run in the existing unit and host lanes. Request campaigns
use 3 generated cases per method/path and caller (override with `SIGN_IN_FUZZ_CASES`). Organization campaigns use
100 cases, each with 50 state-machine steps, on both storage engines. Hegel's
database is disabled and the default seed is `20261117`.

Run from the workspace root after the normal workspace build:

```sh
pnpm exec vitest run --project unit packages/sign-in-test-support/src/fuzz
SIGN_IN_TEST_HOST=cloudflare pnpm exec vitest run --project e2e-host packages/sign-in-test-support/src/fuzz
SIGN_IN_TEST_HOST=node pnpm exec vitest run --project e2e-host packages/sign-in-test-support/src/fuzz
```

The host lane needs the existing verify-auth prerequisites. `SIGN_IN_FUZZ_SEED`
replays a printed seed. `SIGN_IN_FUZZ_CASES` overrides the S2 default of 3 cases per route and caller (raise it for a deep run, lower it for a diagnostic one);
a reduced run does not satisfy the full campaign. Failures retain the named
property, shrunk draws and safe case notes. A runner can timestamp
`F1-case-start` and `F1-case-end` records to measure case duration without adding
a wall clock to the assertions.

One request harness belongs to one family/caller run. Before each case it waits
for deferred work, deletes only that harness's synthetic sign-in rows in the
existing reverse-schema order, checks every table is empty, and clears the cookie
jar. Native setup then obtains fresh sessions, organizations and challenges.
Each case gets a new software authenticator and browser/address namespace.
Exact snapshots bracket the request; no seeded snapshot is restored.

The following fixture state has process lifetime:

- Central provisioning stamps/floors, admin ledgers and observation arrays remain
  in their existing stand-in instances. Every case uses newly issued organization,
  person, session and operation identifiers; prior keys are never reused. Deferred
  work finishes before SQL reset. This is local consumer proof, not central CAS
  or isolation proof.
- The external provider's issued-code registry, Turnstile issued-token registry,
  browser/address map and native rate-limit counters remain in memory. Each case
  obtains new one-use codes/tokens and browser addresses. Old keys cannot authorize
  the next case. A rate-limited generated request still has to satisfy its row's
  documented answer and refusal-effect checks.
- Gateway Durable Object storage and the upstream effect ledger are not reset.
  Sign-in request families never call the Gateway; no workspace admission is
  claimed here. The harness declares no KV namespace.
- Transport observation arrays and readiness receipts remain append-only evidence.
  They do not decide the request's expected response or storage state.

Proof covers local Node/workerd, real SQLite/D1, controlled providers, a software
authenticator and an injected clock. It does not establish real provider or
physical-authenticator behavior, hosted Cloudflare, concurrent interleavings, or
Bombadil coverage. Keep runtime receipts outside Git.
