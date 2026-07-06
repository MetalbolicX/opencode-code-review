# Plan 016: Make custom_rules and max_diff_lines real

> This plan binds the config default explicitly and propagates custom rules in the default parallel flow. Keep the fix deterministic; do not rely on the model to forward config knobs.

## Status
| Field | Value |
|---|---|
| Priority | P0 |
| Effort | M |
| Risk | MED |
| Depends on | 015 |
| Category | correctness |
| Planned at | 2026-07-05 |

## Why this matters
Two documented config knobs are effectively dead on the default path: `max_diff_lines` never reaches runtime truncation, and `custom_rules` disappear when `parallel: true`.

## Current state
- `src/config.ts:19,49` defines `max_diff_lines` and its default.
- `src/tools/review-changes.ts:46` hardcodes `500` instead of reading config.
- `src/prompts/agent/single.ts:20,81` injects `custom_rules` only in single-agent mode.
- `src/prompts/agent/parallel.ts:66-130` never references `custom_rules`.
- `src/config.ts:56` makes parallel mode the default.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exits 0 |
| Tests | `pnpm test` | exits 0 |

## Scope
In scope: `src/index.ts`, `src/tools/review-changes.ts`, `src/prompts/agent/parallel.ts`, `src/dimensions/index.ts`, tests.
Out of scope: single-agent behavior beyond keeping it working.

## Git workflow
Use `fix(config): wire review defaults into parallel mode`.

## Steps
1. Refactor the review tool into a factory or closure so `max_diff_lines` is bound at registration time from `src/index.ts`.
2. Replace the hardcoded `500` default with that bound config value.
3. Propagate `custom_rules` into the parallel orchestrator prompt and the dimension prompt bodies so the default path sees the same policy text as single-agent mode.
4. Add tests for truncation default wiring and parallel prompt inclusion of custom rules.

## Test plan
- Changing `max_diff_lines` changes truncation behavior.
- Parallel prompts include `custom_rules` text.
- Single-agent behavior still works.

## Done criteria
- [ ] `max_diff_lines` affects runtime truncation.
- [ ] `custom_rules` appear in parallel mode.
- [ ] `pnpm verify` passes.

## STOP conditions
If binding the config default requires a broader host API change than a closure/factory, stop and report the contract mismatch before proceeding.

## Maintenance notes
Keep this deterministic. The config must shape behavior directly, not through prompt instructions to the model.
