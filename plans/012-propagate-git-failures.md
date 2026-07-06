# Plan 012: Propagate git failures instead of empty diffs

> Execute this plan in order. Do not move on if verification fails. Keep the change minimal and behavior-focused.

## Status
| Field | Value |
|---|---|
| Priority | P0 |
| Effort | S |
| Risk | MED |
| Depends on | - |
| Category | correctness |
| Planned at | 2026-07-05 |

## Why this matters
`review_changes` can currently turn a git failure into a false "No changes found" result. That is a core contract break for the review tool and hides the actual failure from users.

## Current state
- `src/tools/review-changes.ts:74-90` returns the empty-diff message when stdout is blank.
- `src/tools/review-changes.ts:102-113` converts non-throwing failures into `{ ok: true, stdout: "" }`.
- Existing callers already expect `[Error] ...` strings from the tool.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exits 0 |
| Lint | `pnpm lint` | exits 0 |
| Tests | `pnpm test` | exits 0 |

## Scope
In scope: `src/tools/review-changes.ts`, new tests for command failure propagation.
Out of scope: shell removal, CI, config wiring.

## Git workflow
Use a focused conventional commit if committing from this plan: `fix(review): propagate git failures`.

## Steps
1. Update `runCommand` to return `ok: false` when the git runner returns a failed result.
2. Keep the thrown-error path as-is, but make the returned error message actionable.
3. Add a behavior test for failing `git diff` / `git show` that asserts the tool returns `[Error]`.

## Test plan
- Failing git command returns an error string.
- Empty-but-successful output still maps to `No changes found`.

## Done criteria
- [ ] Failed git result is never reported as `No changes found`.
- [ ] Tests cover both failure and empty-success cases.
- [ ] `pnpm verify` passes.

## STOP conditions
If the shell runner type does not expose a distinguishable failure result, stop and report the actual command-result shape before changing the API.

## Maintenance notes
Keep the fix local to the tool. Do not broaden the change into shell invocation cleanup; that is a separate plan.
