# Plan 014: Set auto-review cooldown after session validation

> Keep the fix to the event handler order only. Add one regression test that proves a malformed event does not burn cooldown.

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
The idle-event handler consumes cooldown before it knows whether the event even has a usable session ID. That means a malformed event can suppress the next real auto-review.

## Current state
- `src/index.ts:116-125` checks cooldown, sets `lastAutoReviewTime = now`, then validates `sessionID`.
- `src/index.test.ts:61-104` covers retry-after-failure but not missing-session-ID handling.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exits 0 |
| Tests | `pnpm test` | exits 0 |

## Scope
In scope: `src/index.ts`, the matching test file.
Out of scope: auto-review failure retry logic.

## Git workflow
Use `fix(auto-review): validate session id before cooldown`.

## Steps
1. Move the cooldown write so it happens only after `sessionID` is confirmed.
2. Keep the failure reset path intact.
3. Add a regression test for a missing-ID idle event followed by a valid event inside the cooldown window.

## Test plan
- Malformed idle event does not consume cooldown.
- Valid idle event still triggers auto-review.

## Done criteria
- [ ] Missing `sessionID` does not suppress the next valid review.
- [ ] Existing failure-retry behavior stays intact.
- [ ] `pnpm verify` passes.

## STOP conditions
If the event shape has more missing-ID variants than the current guard handles, stop and report the full shape before widening the fix.

## Maintenance notes
This is intentionally narrower than plan 010; do not rewrite the failure retry logic here.
