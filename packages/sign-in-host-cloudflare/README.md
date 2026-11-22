# Cloudflare sign-in host

Composes the portable [sign-in core](../sign-in-core) with Worker HTTP/RPC entrypoints and Drizzle D1 storage. The default export serves HTTP; the named `AgentClientManagement` entrypoint serves trusted service bindings.

`signInWorkerConfiguration` reads deployment configuration and provider secrets from the generated `AuthWorkerEnv` bindings. Each database-factory call opens a fresh `first-primary` D1 session. Fixed atomic groups use D1's batch operation.

The deployment also requires the `CENTRAL` service binding to the private central Worker. Organization provisioning uses only that binding; there is no central public URL or service credential. The central Worker must have no internet route, custom domain or workers.dev endpoint.

Bind `CENTRAL_LINK` separately to Central's storage Worker. The sign-in host carries organization-scoped WebSocket upgrades through that binding and sends private Fleet HTTP calls through `CENTRAL`.

Use [wrangler.example.jsonc](wrangler.example.jsonc) as the deployment template. Replace its database and configuration placeholders, and supply private secrets through the deployment's existing Worker-secret process. The entrypoint is the built `dist/index.js`; its migrations directory points to the core's checked-in generated migrations.

The `SIGN_IN_CONFIGURATION` JSON includes the public Turnstile site key in its `turnstile` object (`kind: 'deployed'` for a private-stack or production hostname). The `TURNSTILE_SECRET_KEY` binding is declared by name under `secrets.required`; its actual value is supplied by the deployment owner at the private-stack cut. A missing secret leaves the captcha plugins registered and fails protected starts closed. Local proof uses only Cloudflare's published dummy keys and a loopback siteverify stand-in.

Before dispatch, this host removes incoming `x-sign-in-client-address` and sets it from `cf-connecting-ip`. The core and Better Auth use that address, with IPv6 addresses sharing a /64 budget. Better Auth also uses it for the captcha request's `remoteip`.

The deployment requires both rate-limit bindings from the template: `SIGN_IN_ATTEMPTS` (10 requests per 60 seconds) and `AUTH_REQUESTS` (300 per 60 seconds). The core keys each count by route class and address before dispatch, including its own pages. Better Auth applies its separate memory limits to requests through its HTTP router. The [route policy](../sign-in-core/src/request-limits/request-limit-policy.ts) owns the classes and defaults. Limited requests return 429 with `Retry-After`; an unavailable binding returns 503. Closed captcha and request-limit observations go to the host's JSON log. Telemetry/export configuration is a separate delivery.

The configuration also requires `centralIdentityAudience`, a distinct `centralAdminAudience`, `centralPublicOrigin` (exactly central's `CENTRAL_PUBLIC_ORIGIN`), `adminPageClientId`, `ownerFleetCliClientId` (all three system client IDs distinct) and `organizationStatementLifetimeSeconds: 10368000` (120 days). The Worker has no `scheduled` handler and the template no cron triggers (owner, 12 Nov). Each Fleet call renews its organization's stamp and delivers its pending authorization revisions first, and a request that commits a fence change also drains through `waitUntil` (see sign-in-core's README). Native server-only dispatch supplies the signing context; expiry and signing-key selection use the core's injected clock. No public HTTP renewal route is added. Renewal reads and replacements go through the `CENTRAL` service binding; recording-peer proof is not hosted cron or central-storage proof.

Build from the monorepo root, then apply the migrations before serving a local Worker:

```sh
mise exec node@24.7.0 -- pnpm build
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/sign-in-host-cloudflare exec wrangler d1 migrations apply DB --local --config wrangler.example.jsonc
```

Wrangler owns migration application on D1. The initial migration initializes a fresh database. Generated binding declarations are checked by the package's `types:check` script.

**Undeployed, owner decision pending: authorization-revision backfill.** Right after each deploy of the sign-in Worker, call `backfillAuthorizationRevisions()` once on the `AgentClientManagement` entrypoint through its service binding. It has no HTTP route. It gives organizations and memberships that predate the revision tables their fences, and a second call adds nothing. There is no cron: a fenced write on rows that predate the tables backfills their organization and retries once (see sign-in-core's README).
