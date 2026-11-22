# Switchboard contributor contract

Switchboard is a pnpm TypeScript monorepo with an existing uv Python SDK. Read the affected package's README, contracts and permanent tests before changing it. Keep authorization decisions, runtime adapters and user interfaces in their current owning packages.

## Where this repository is going

<!-- TODO: remove this section after the production change-over. It is here because agents kept designing and building against the old system. -->

- **One new system.** Switchboard sign-in, central and the Router are being rebuilt as one new system. Every Router enrolls with central, and nothing works without central. Production stays on the released version until the maintainer declares one change-over, and that is not close. Build the system first.
- **A clean start.** The change-over starts the new system on empty state. Old stored state is moved somewhere safe as a backup at that time, and new code never reads it.
- **What not to design or write:**
  - a migration of old stored data, or a reader for an old stored form;
  - a remembered old identity: a machine is identified only by its machine ID, and the former installation identity is refused;
  - a door that still accepts an old request form;
  - a test or proof that a store made by an older build upgrades.

  A database migration only has to apply to an empty store.
- **Change once.** Wires and doors change once. The old form is refused with a message saying what to send instead: no backward compatibility, no shim, no flag.
- **The change-over itself.** Don't design or build the backup, the install or the enrollment procedure until the maintainer asks for it.
- **Nothing installed matters.** Nothing built here is deployed to production before the change-over, and testing happens on a new staging installation. Don't weigh a design by what it would cost a Router or service that is already installed: its identities, stored data and request forms are left behind. When stored data makes you want to preserve it, or to ask what happens to it across the change-over, the answer is already here: it is left behind.
- **No stand-ins.** When work needs something that is decided and not yet built (the approval system, central's half of a call), build that thing's first complete component and hold the step that depends on it. Don't invent an interim rule that lets the step work without it, and don't ask the maintainer to choose among such rules. Build by components; each component is complete.
- **Unproven calls.** A call that shows no proof of who it is does nothing on its own. What needs the maintainer's say goes through the approval system, and nothing is deployed until the approval system works with central.
- **Approvals, built whole.** That includes sign-in's half: a person's signed way to list, read and answer. Building by components sets the order of the work; it doesn't make a smaller system acceptable.
- **The maintainer's words, 22 November 2026:** "I kept saying cut over, what did you carry over?"; "Just build the approval system or some part to fit. Please don't do shortcuts"; "Don't repeat same mistakes with keeping old stuff and worrying about backward compatibility"; "Build the whole thing".

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
