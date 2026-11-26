# ADR-0001: pnpm monorepo with a shared domain package

**Status:** accepted (Milestone 1)

**Context.** Web, Android/iOS and the API must agree on permissions, workflow stages, Content ID formats and validation. Drift between them is a source of security bugs (a UI that allows what the API forbids, or the reverse).

**Decision.** One pnpm workspace: `apps/api`, `apps/web`, `apps/mobile`, `packages/shared`. `@rstar/shared` holds the permission catalogue and default role matrix, workflow state machines, Content ID formatting, Zod request schemas, brand tokens and the storage cost model. The API is the only enforcer; clients import the same definitions to decide what to show.

**Consequences.** One version of the rules. Shared code must stay platform-neutral (no Node or DOM APIs). The permission matrix document is generated from code so it cannot go stale.
