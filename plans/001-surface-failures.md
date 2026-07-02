# Plan 001: Surface git and auto-review failures instead of swallowing them

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1513b1f..HEAD -- src/tools/review-changes.ts src/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1513b1f`, 2026-07-01

## Why this matters

Today the plugin hides operational failures in two critical paths. Git command failures inside `review_changes` return an empty string and get reported as "No changes found", and auto-review trigger failures are swallowed entirely. That creates false-success behavior: users cannot tell whether there were truly no changes or whether the tool failed. Fixing this is a small change with immediate debugging and reliability payoff.

## Current state

- The relevant files:
  - `src/tools/review-changes.ts` — builds git diff output for review.
  - `src/index.ts` — registers the plugin and handles `session.idle` auto-review events.

- Current code excerpts:
  - `src/tools/review-changes.ts:60-66`
    - `async function runCommand($: any, cmd: string): Promise<string> {`
    - `  try {`
    - `    const result = await \`bash -c ${cmd}\`.quiet()`
    - `    return result.stdout ?? ""`
    - `  } catch {`
    - `    return ""`
    - `  }`
    - `}`
  - `src/tools/review-changes.ts:47-48`
    - `if (!diff.trim()) {`
    - `  return "No changes found for the selected scope."`
    - `}`
  - `src/index.ts:106-119`
    - `try {`
    - `  await client.session.promptAsync({ ... })`
    - `} catch {}`

- Repo conventions that apply here:
  - This repo currently has no robust verification command. `package.json:8` defines only `npm test`, and it is a stub: `echo "TODO: add tests" && exit 0`.
  - Keep changes minimal and local. Do not refactor unrelated prompt or config code in this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 1513b1f..HEAD -- src/tools/review-changes.ts src/index.ts` | no unexpected drift, or drift understood before editing |
| Locate swallowed catches | `rg -n 'catch \\{\\}|return ""' src/tools/review-changes.ts src/index.ts` | shows the known sites before the change |
| Optional typecheck | `npx tsc --noEmit` | exit 0 if TypeScript is available locally |
| Verify removed swallow sites | `rg -n 'catch \\{\\}|return ""' src/tools/review-changes.ts src/index.ts` | no match for the old empty-catch / empty-string patterns you replaced |
| Scope check | `git diff --stat -- src/tools/review-changes.ts src/index.ts` | only the in-scope files changed |
| Status check | `git status --short` | only intended files modified |

## Scope

**In scope**:
- `src/tools/review-changes.ts`
- `src/index.ts`

**Out of scope**:
- `src/agent.ts`
- `src/config.ts`
- CI, tests, dependency versions, or shell command construction changes beyond what's needed to surface failures

## Git workflow

- Branch: `advisor/001-surface-failures`
- Commit style: concise imperative or conventional commit is acceptable; recent history is mixed and does not show a strict convention.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make `runCommand` distinguish failure from empty output

Change `runCommand` in `src/tools/review-changes.ts` so callers can tell the difference between:
- a successful command that produced no output
- a failed command

Target shape:
- Return a small result object instead of a bare string, for example `{ ok: true, stdout } | { ok: false, error }`.
- Preserve the existing call sites in `reviewChanges`, but update them to branch on `ok`.
- Do not introduce a generic utility module; keep this local to the file.

**Verify**: `rg -n 'async function runCommand|ok: true|ok: false|error' src/tools/review-changes.ts` → shows the new result-based shape in this file only.

### Step 2: Return user-visible failure messages from `review_changes`

Update `reviewChanges.execute` so failed git commands no longer fall through to `"No changes found for the selected scope."`.

Target behavior:
- If the diff command fails, return a clear error message that says the git command failed for the selected scope.
- If the stat command fails but diff succeeds, still return the diff and include a warning or fallback for stats rather than pretending success silently.
- Keep the existing "No changes found" behavior only for the true empty-diff case.

**Verify**: `rg -n 'No changes found|git command failed|scope' src/tools/review-changes.ts` → old empty-diff message still exists, plus a distinct failure path exists.

### Step 3: Log auto-review failures in the idle event handler

Replace the empty catch in `src/index.ts` with minimal failure surfacing.

Target behavior:
- Catch the error value.
- Emit a minimal `console.error` message that identifies auto-review failure.
- Do not change the auto-review trigger logic, cooldown logic, or session ID resolution in this plan.

**Verify**: `rg -n 'console\\.error|promptAsync|catch' src/index.ts` → the empty catch is gone and replaced with a logged error path.

## Test plan

- No new test files in this plan. This repo does not yet have test infrastructure.
- Structural verification only:
  - `review_changes` still has a real empty-diff path.
  - Failure paths are now distinct and visible.
  - `session.idle` auto-review errors are logged, not swallowed.
- Optional compilation check:
  - `npx tsc --noEmit`
  - If this fails because `typescript` is unavailable locally, STOP and report; do not add new toolchain dependencies in this plan.

## Done criteria

- [ ] `src/tools/review-changes.ts` no longer treats command failure as empty output
- [ ] `src/index.ts` no longer contains `catch {}`
- [ ] `rg -n 'catch \\{\\}|return ""' src/tools/review-changes.ts src/index.ts` returns no matches for the replaced patterns
- [ ] `git diff --stat -- src/tools/review-changes.ts src/index.ts` shows only in-scope file changes
- [ ] `plans/README.md` status row updated

## STOP conditions

- The code at the cited locations does not match the excerpts above.
- `runCommand` is imported or reused outside `src/tools/review-changes.ts`; this plan assumes it is file-local.
- A reasonable implementation appears to require changing public output contracts beyond one clear error message path.
- `npx tsc --noEmit` fails due to unrelated pre-existing repo issues you cannot isolate quickly.

## Maintenance notes

- A reviewer should scrutinize whether the new error messages leak too much raw shell detail; keep them useful but concise.
- This plan intentionally does not change shell command construction. That is handled separately by Plan 002.
- Once test infrastructure exists, add direct unit tests around the failure/empty-success distinction in `review_changes`.
