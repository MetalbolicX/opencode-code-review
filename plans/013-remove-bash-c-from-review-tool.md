# Plan 013: Remove bash -c from review tool

> This is the re-land of the old branch-diff shell cleanup. Keep it isolated to `src/tools/review-changes.ts` and verify that the shell wrapper is gone.

## Status
| Field | Value |
|---|---|
| Priority | P0 |
| Effort | M |
| Risk | MED |
| Depends on | 012 |
| Category | security |
| Planned at | 2026-07-05 |

## Why this matters
The review tool currently interpolates git commands through `bash -c`. That is unnecessary, fragile, and the wrong production baseline for a command that already has a safe structured runner available.

## Current state
- `src/tools/review-changes.ts:65-69` builds branch diff commands as strings.
- `src/tools/review-changes.ts:107` executes everything via ``bash -c``.
- `src/tools/review-changes.ts:25,62-64` already validates the branch name defensively.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| Search | `rg "bash -c" src/` | no matches |
| Typecheck | `pnpm typecheck` | exits 0 |
| Tests | `pnpm test` | exits 0 |

## Scope
In scope: `src/tools/review-changes.ts`.
Out of scope: host plugin API changes, config changes.

## Git workflow
Use `fix(review): remove shell-assembled git commands`.

## Steps
1. Replace the string-based `bash -c` execution with direct git invocation through the tagged runner.
2. Keep the branch regex guard as defense in depth.
3. Verify staged, last-commit, and branch scopes all still work.

## Test plan
- Add a branch-scope test that uses a safe branch name and confirms the command still resolves.
- Ensure no `bash -c` remains anywhere in `src/tools/review-changes.ts`.

## Done criteria
- [ ] No `bash -c` in the review tool.
- [ ] All review scopes still function.
- [ ] `pnpm verify` passes.

## STOP conditions
If the runner only accepts shell strings and not structured args, stop and confirm the plugin host contract before making a workaround.

## Maintenance notes
Do not fold the failure-propagation fix into this plan; that work already belongs to 012.
