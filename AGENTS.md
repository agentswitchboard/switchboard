# Switchboard contributor contract

Switchboard is a pnpm TypeScript monorepo with an existing uv Python SDK. Read the affected package's README, contracts and permanent tests before changing it. Keep authorization decisions, runtime adapters and user interfaces in their current owning packages.

## Where this repository is going

<!-- TODO: remove this section after the production change-over. -->

Switchboard is being rebuilt together with its central service. Every Router enrolls with central, and nothing works without central. Production stays on the released version until the maintainer declares a single change-over, and that is not close. The change-over is a clean start on empty state: old stored state is moved somewhere safe at that point, and new code never reads it. So:

- No migration of old stored data, no reader for an old stored form, and no test that an older store upgrades. A database migration only has to apply to an empty store.
- No remembered old identity. For example, a machine is identified only by its machine ID; the former installation identity is refused.
- No door that still accepts an old request form. A wire or route changes once, and the old form is refused.
- The change-over itself is not designed or built until the maintainer asks for it.
- Nothing built here is deployed to production before the change-over. Testing happens on a new staging installation. So don't weigh a design by what it would cost a Router or service that is already installed: its identities, stored data and request forms are left behind. Only the backup taken at the change-over is kept.
- When stored data makes you want to preserve it, or to ask what happens to it across the change-over, the answer is already here: it is left behind.

## Standards

Whose standards: this repository's own. Follow [.cursor/rules/ts-rules.md](.cursor/rules/ts-rules.md), [.cursor/rules/monorepo-rules.md](.cursor/rules/monorepo-rules.md), the checked-in tool configuration, and existing package conventions. Preserve existing import aliases and test placement when editing a module. Use narrow types, explicit function parameters and return types, discriminated unions and schema-derived boundary types. Never add `any`, unchecked casts, lint suppressions or real-time sleeps to make a check pass.

## Boundaries

- Preserve public protocol literals, exports, package names, and producer-owned fixture objects unless their contract change is explicitly agreed.
- Keep new runtime dependencies and changes to persisted formats, ownership or security boundaries subject to maintainer review.
- Keep credentials, resolved secrets, deployment-specific credential locations, personal data, runtime evidence and screenshots outside Git. Use deliberate synthetic identities and placeholders in examples.
- Preserve third-party notices and add provenance for copied or generated source; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Commands and proof

Run commands from the monorepo root with the pinned pnpm version in `package.json`. Use Node 24 or later and uv for Python.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test:unit
pnpm test:integration
pnpm python:test:host
pnpm test:e2e:host
```

`pnpm check` runs the repository's quality gates. `pnpm fmt` applies formatting; `pnpm fmt:check`, `pnpm lint`, `pnpm lint:types` and `pnpm typecheck` run their individual checks. Use the existing scripts rather than adding another orchestration layer.

Unit tests use `*.unit.test.ts` or `*.unit.spec.ts`; integration tests use `*.integration.test.ts`; host proofs use `*.host.e2e.test.ts`. Units stay process-local. Real host commands, listeners, browser and process-lifecycle proof belong in the host lane with owned temporary roots and teardown. Use injected clocks and event barriers for expiry and races. Do not weaken assertions or move real-boundary coverage into a mocked layer.

The [verify-auth recipe](.agents/skills/verify-auth/SKILL.md) describes local sign-in journeys on Node and workerd, their prerequisites, evidence, and limits. Report the tested source, command, exit code and pass/fail/skip counts; name unavailable platform prerequisites. Local fixtures do not establish hosted identity or live-provider acceptance.

## Contributions

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md). Keep the CLA assent section in the pull request template intact. This source tree contains no automatic publishing workflow; release procedures require a separately reviewed design.
