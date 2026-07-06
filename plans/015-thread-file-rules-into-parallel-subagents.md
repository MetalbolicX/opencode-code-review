# Plan 015: Thread file_rules into parallel sub-agents

> Keep this to the parallel registration path. The goal is to ensure the rules docs actually reach the review agents that need them.

## Status
| Field | Value |
|---|---|
| Priority | P0 |
| Effort | S |
| Risk | LOW |
| Depends on | - |
| Category | correctness |
| Planned at | 2026-07-05 |

## Why this matters
The default parallel review path registers dimension sub-agents without `file_rules`, so scoped markdown rules never reach the agents that enforce the review policy.

## Current state
- `src/index.ts:27` calls `getDimensionPrompts(config)` with no rule list.
- `src/index.ts:71-84` registers those prompts as `review:dim-*` agents.
- `src/dimensions/index.ts:358-368` already supports `getDimensionPrompts(config, rules)`.
- `src/agent.test.ts:181-185` documents the intended behavior, but runtime does not match it.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exits 0 |
| Tests | `pnpm test` | exits 0 |

## Scope
In scope: `src/index.ts`.
Out of scope: rule parsing, prompt wording, single-agent mode.

## Git workflow
Use `fix(review): pass file rules to dimension prompts`.

## Steps
1. Change the registration path to `getDimensionPrompts(config, config.file_rules)`.
2. Add a test that registers the plugin with a known rule file and checks the `review:dim-*` prompt includes the rule body.

## Test plan
- Parallel registration path contains scoped rule text.
- Existing prompt formatting remains unchanged apart from the injected rules.

## Done criteria
- [ ] `review:dim-*` prompts include `file_rules` content.
- [ ] Tests cover the registration path.
- [ ] `pnpm verify` passes.

## STOP conditions
If any downstream prompt formatting assumption breaks when `file_rules` are present, stop and capture the exact mismatch before widening the change.

## Maintenance notes
This plan only fixes delivery of rules to the agents; actual custom rule propagation belongs to 016.
