# Machine device login replay fixtures

Read the HTTP status, selected response headers, and body from each file under `responses/`. The matching file under `schemas/` validates the response body. The discovery template has a literal `{organization_id}` placeholder. Deployment and token values are synthetic.

The discovery schema checks the HTTPS template spelling and one literal placeholder segment. Parse the substituted URL before using it. Switchboard also requires the URL parser to accept the authority and requires the placeholder to survive path normalization. JSON Schema does not perform those parser checks.

Files under `requests/` give the method, path, headers, and form fields. Encode `body` as `application/x-www-form-urlencoded` when replaying the request. The temporary-unavailability response is a projection example. It includes a sample `Retry-After` header that the production projection preserves when present. Revoked refresh returns `invalid_client`. An invalid refresh credential for the registered client returns `invalid_grant`.

Generate the checked-in schemas from the workspace root with `pnpm exec tsx scripts/generate-machine-device-fixture-schemas.ts`. The unit suite checks the response projection, request guards, and schema drift.
