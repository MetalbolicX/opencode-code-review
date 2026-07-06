# Plan 019: Reconcile stale plan statuses

> Documentation-only cleanup. Update the index so it reflects the actual state of the repo and the new split plans.

## Status
| Field | Value |
|---|---|
| Priority | P1 |
| Effort | S |
| Risk | LOW |
| Depends on | 012, 013, 017 |
| Category | docs |
| Planned at | 2026-07-05 |

## Why this matters
`plans/README.md` currently marks 002 and 004 as DONE even though their intended fixes are not in the live code. The index needs to distinguish landed work from superseded work.

## Current state
- `plans/README.md` still reflects the older plan set.
- 002 is now superseded by 013.
- 004 is now superseded by 017.
- 010 remains valid, but 014 covers a separate gap.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| None | - | - |

## Scope
In scope: `plans/README.md`.
Out of scope: source files.

## Git workflow
Use `docs(plans): reconcile stale plan statuses`.

## Steps
1. Update the plan index table to include 012-019.
2. Mark 002 as superseded by 013 and 004 as superseded by 017.
3. Keep the older DONE entries intact where the underlying work really is present.

## Test plan
- Manual read-through of the plan index against the live plan files.

## Done criteria
- [ ] The index matches the real plan set.
- [ ] Superseded plans are labeled clearly.

## STOP conditions
If the index format has changed since the last survey, stop and restate the updated shape before editing further.

## Maintenance notes
This is a hygiene pass, not a source fix.
