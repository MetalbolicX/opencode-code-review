# Plan 002: Remove shell-assembled branch diff commands

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1513b1f..HEAD -- src/tools/review-changes.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `1513b1f`, 2026-07-01

## Why this matters

The branch review path currently assembles `git diff ${defaultBranch}...HEAD` as a shell string and passes it through `bash -c`. That is fragile even in a local plugin and creates unnecessary command-assembly risk from remote-derived branch metadata. This is a small, isolated fix with very good payoff: safer command execution and less dependence on shell parsing.

## Current state

- The relevant file:
  - `src/tools/review-changes.ts` — branch-scope diff logic and shell command execution.

- Current code excerpts:
  - `src/tools/review-changes.ts:31-34`
    - `case "branch": {`
    - `  const defaultBranch = await getDefaultBranch($)`
    - `  diffResult = await runCommand($, \`git diff ${defaultBranch}...HEAD\`)`
    - `  statsResult = await runCommand($, \`git diff ${defaultBranch}...HEAD --stat\`)`
    - `  break`
    - `}`
  - `src/tools/review-changes.ts:69-77`
    - `async function getDefaultBranch($: any): Promise<string> {`
    - `  try {`
    - `    const result = await \`bash -c 'git remote show origin'\`.quiet()`
    - `    const match = (result.stdout ?? "").match(/HEAD branch: (.+)/)`
    - `    if (match) return match[1]`
    - `  } catch {`
    - `  }`
    - `  return "main"`
    - `}`

- Repo conventions that apply here:
  - Keep the fix local to `src/tools/review-changes.ts`.
  - Do not combine this plan with broader error-handling refactors unless absolutely necessary; Plan 001 covers failure surfacing.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 1513b1f..HEAD -- src/tools/review-changes.ts` | no unexpected drift, or drift understood before editing |
| Locate branch diff assembly | `rg -n 'git diff .*HEAD|git remote show origin|bash -c' src/tools/review-changes.ts` | shows the current branch-scope shell assembly |
| Optional typecheck | `npx tsc --noEmit` | exit 0 if TypeScript is available locally |
| Verify shell assembly removed | `rg -n 'git diff \\$\\{|git remote show origin|bash -c' src/tools/review-changes.ts` | old branch-specific shell-assembled pattern gone |
| Scope check | `git diff --stat -- src/tools/review-changes.ts` | only this file changed |

## Scope

**In scope**:
- `src/tools/review-changes.ts`

**Out of scope**:
- `src/index.ts`
- Dependency/version changes
- CI/test infrastructure
- Any change to review prompt text or command registration

## Git workflow

- Branch: `advisor/002-remove-shell-assembled-branch-diff`
- Commit style: concise imperative or conventional commit is acceptable.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Stop deriving the default branch through `git remote show origin`

Replace the current default-branch discovery with a git plumbing command or another safe approach that does not require parsing `git remote show origin` output through `bash -c`.

Preferred target shape:
- Use a direct git ref such as the symbolic ref for `refs/remotes/origin/HEAD`, then normalize it to the branch name.
- Keep the fallback to `"main"` if the ref cannot be resolved.
- Avoid text parsing of a human-oriented command when a machine-oriented ref command exists.

**Verify**: `rg -n 'symbolic-ref|origin/HEAD|return "main"' src/tools/review-changes.ts` → shows a machine-oriented branch lookup with the fallback preserved.

### Step 2: Stop interpolating the branch name into a shell command string

Update the branch diff path so the branch comparison no longer relies on a shell-assembled string.

Acceptable target shapes:
- Change `runCommand` to accept command arguments safely and use that API here.
- Or add a narrow branch-specific helper that runs `git diff` without string interpolation through `bash -c`.

Constraints:
- Do not keep `git diff ${defaultBranch}...HEAD` inside a shell string.
- Do not widen this into a generic command-runner abstraction across the repo.

**Verify**: `rg -n 'defaultBranch.*HEAD|bash -c' src/tools/review-changes.ts` → the old interpolated branch diff pattern is gone.

### Step 3: Keep staged and last-commit behavior unchanged

After changing only the branch path, confirm the other scopes still exist and still use the same commands unless your chosen safe API required mechanical updates.

**Verify**: `rg -n 'git diff --cached|git show --format=' src/tools/review-changes.ts` → staged and last-commit scope behavior still present.

## Test plan

- No new tests in this plan; repo test infrastructure does not exist yet.
- Structural checks:
  - The branch scope no longer uses shell string interpolation with `defaultBranch`.
  - The branch lookup uses a machine-oriented git ref command, not `git remote show origin`.
  - Staged and last-commit scopes remain intact.
- Optional compilation:
  - `npx tsc --noEmit`
  - If unavailable locally, STOP and report rather than adding dependencies.

## Done criteria

- [ ] `src/tools/review-changes.ts` no longer contains `git remote show origin`
- [ ] `src/tools/review-changes.ts` no longer builds branch diffs with ``git diff ${defaultBranch}...HEAD``
- [ ] fallback behavior for unresolved default branch still exists
- [ ] `git diff --stat -- src/tools/review-changes.ts` shows only the in-scope file changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- The current branch-scope implementation no longer matches the excerpts above.
- Safely removing shell assembly requires changing files outside `src/tools/review-changes.ts`.
- The host command API cannot run git safely without `bash -c`, and there is no local narrow alternative.
- `npx tsc --noEmit` fails for unrelated repo-wide reasons you cannot isolate quickly.

## Maintenance notes

- Reviewers should check that fallback-to-`main` still behaves sensibly for repos whose remote HEAD is unavailable.
- This plan intentionally does not redesign all command execution. Keep the change as surgical as possible.
- If the repo later adds tests, add cases for branch scope with unusual default branch names and missing `origin/HEAD`.
