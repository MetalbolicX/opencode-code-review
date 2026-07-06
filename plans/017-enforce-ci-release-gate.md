# Plan 017: Enforce CI release gate

> Re-land the CI gate that plan 004 intended. Do this after the source fixes so CI validates the actual production shape.

## Status
| Field | Value |
|---|---|
| Priority | P0 |
| Effort | S |
| Risk | LOW |
| Depends on | 012, 013, 014, 015, 016 |
| Category | tooling |
| Planned at | 2026-07-05 |

## Why this matters
The repo has a good local `verify` script, but no workflow enforces it. That leaves regressions free to ship.

## Current state
- `package.json:17-24` exposes `pnpm verify` locally.
- `vitest.config.ts` collects coverage but does not enforce thresholds.
- Repo scan found no `.github/workflows/` directory.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| CI smoke | `pnpm verify` | exits 0 |
| Typecheck | `pnpm typecheck` | exits 0 |
| Tests | `pnpm test -- --forbidOnly` | exits 0 |

## Scope
In scope: `.github/workflows/verify.yml`, `vitest.config.ts`.
Out of scope: source behavior.

## Git workflow
Use `chore(ci): add verify workflow`.

## Steps
1. Add a workflow that checks out the repo, installs pnpm deps, and runs `pnpm verify` on push and pull request.
2. Enable focused-test blocking in vitest config (`forbidOnly: true`).
3. Add coverage thresholds using the current baseline so the gate can fail regressions.

## Test plan
- CI runs the same verification locally used by contributors.
- `test.only` fails the gate.
- Coverage regression fails the gate.

## Done criteria
- [ ] Workflow exists and runs on push/PR.
- [ ] `forbidOnly` is enforced.
- [ ] Coverage thresholds are enforced.

## STOP conditions
If the current Node/pnpm setup in the repo cannot support the workflow without pinning changes, stop and report the exact environment mismatch.

## Maintenance notes
This plan should be the final line of defense, not a substitute for the source-level fixes above.
