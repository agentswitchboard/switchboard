# Node sign-in host

Runs the existing sign-in core and Better Auth boundary on Node 24 with an HTTP listener and a `better-sqlite3` file. The host applies the core's checked-in Drizzle migrations before serving. Each store read opens a fresh Drizzle view; fixed statement groups run in an immediate SQLite transaction.

`startNodeSignInHost({ settings })` validates the settings and returns `started` with the listener address, internal management capability and `close()`, or an `unavailable` result. Settings require `centralSocketPath`, an absolute path to central’s Unix socket in the deployment-owned private directory (0700). The link opens no TCP connection; a logical request URL never chooses its destination. Central must be running on the same machine.

Settings contain `stateDirectory`, listener `hostname` and `port`, the core sign-in configuration (including its Turnstile site), provider credentials, the auth secret and optional `turnstileSecretKey`. Supply credentials through the deployment's secret-loading process. Missing Turnstile credentials keep protected sign-in starts closed. `stateDirectory/sign-in.sqlite` contains durable sign-in state.

When enabling machine login, set `configuration.machineLogin.linkUrlTemplate` to `<centralPublicOrigin>/v1/organizations/{organization_id}/link`. Use Central's HTTPS public origin and keep the literal organization placeholder. `GET /.well-known/fleet-login` publishes this configured template as `link_url`.

The default client-address policy is `{ kind: 'socket-peer' }`. Incoming `x-sign-in-client-address` is always replaced. An explicitly configured `{ kind: 'trusted-proxy', peers, header }` accepts that header only from a listed socket peer and walks its addresses from right to left while the hops are trusted. Malformed trusted-proxy addresses are refused. The core and Better Auth use only the resulting internal header, with IPv6 addresses sharing a /64 budget.

The host keeps fixed request windows per route class and address, including requests for the core's own pages. A window starts at the first request and expires without moving on later requests. Better Auth separately counts its HTTP routes in memory, with limiting enabled in development and production. The [route policy](../sign-in-core/src/request-limits/request-limit-policy.ts) owns the limits. A limited request returns 429 with `Retry-After`. The counters are process state and add no sign-in database table.

The core configuration also requires `centralIdentityAudience`, a distinct `centralAdminAudience`, `centralPublicOrigin` (exactly central's `CENTRAL_PUBLIC_ORIGIN`), `adminPageClientId`, `ownerFleetCliClientId` (all three system client IDs distinct) and `organizationStatementLifetimeSeconds: 10368000` (120 days). The host starts no timer (owner, 9 and 12 Nov). Each Fleet call renews its organization's stamp and delivers its pending authorization revisions first (see sign-in-core's README); requests that commit a fence change also hint a drain, and `close()` waits for it before closing the database. Startup still runs the authorization-revision backfill.

Host records and the core's closed observations, including captcha refusals and request limits, go to stderr as JSON. With `OTEL_EXPORTER_OTLP_ENDPOINT` or the `otlpEndpoint` setting, LogTape also exports logs through `@logtape/otel`. Request values, URLs and credentials are absent from host records. These records alone do not establish SO13.

`createNodeSignInConfiguration`, `openNodeSignInDatabase` and `startNodeSignInListener` expose the host's composition boundaries for embedding. The management capability is an in-process API. The production listener exposes no management RPC endpoint or proof controls. Test-only Worker-to-Node forwarding belongs to `sign-in-test-support` and is not a deployment protocol.

Build and run the focused checks from the repository root:

```sh
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/sign-in-host-node build
mise exec node@24.7.0 -- pnpm exec vitest run --project unit packages/sign-in-host-node
mise exec node@24.7.0 -- pnpm exec vitest run --project integration packages/sign-in-host-node
```
