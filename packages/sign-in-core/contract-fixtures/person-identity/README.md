# Staged person identity contracts

K5 is the session-confirmation reply naming the permission checked for one request; K6 is the organization-scoped person-token claims object. Their Zod authority is `src/contracts/person-identity-contracts.ts`. The schemas and fixture values here are structural artifacts. They are not minted tokens, real introspection responses, signature proof, or evidence of live authentication.

B1 owns the organization-scoped issuer and live permission producer. A producer/consumer output check remains a separate proof obligation from these structural artifacts; consumers adopt an explicitly published source and fixture pin.

Token `iat`, `exp` and `second_factor_at` use Unix seconds. Confirmation `checkedAt` uses epoch milliseconds from its first session read. An active confirmation requires exactly one of the eleven declared Fleet `resource:action` permissions; role names and undeclared actions are refused. An inactive reply contains only `active:false`. A usable audience is one string. `second_factor_at` and `second_factor_method` are absent before any second-factor confirmation. C13 copies the session's stored method as `app`, `recoveryCode` or `passkey`. `amr` is forbidden: Better Auth owns that reserved claim and strips it from custom claims. Issuance and relying-service guards own the semantic checks between those claims.

The fixture containers identify their contract by name so consumers cannot silently swap K5 and K6. Each example is serialized from a value parsed by its producer-owned Zod schema. Regenerate from the repository root after building the core:

```sh
mise exec node@24.7.0 -- node packages/sign-in-test-support/src/contract-fixtures/generate-person-identity-fixtures.mts
```
