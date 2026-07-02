# Plan 006: Split `src/agent.ts` into smaller prompt modules without changing behavior

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat b826dcd..HEAD -- src/agent.ts src/index.ts src/dimensions/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: `plans/004-add-verification-scripts.md`, `plans/005-add-minimal-test-infrastructure.md`
- **Category**: tech-debt
- **Planned at**: commit `b826dcd`, 2026-07-02
- **Issue**: <GitHub issue URL — only when published via `--issues`; omit otherwise>

## Why this matters

`src/agent.ts` is a 345-line mixed-responsibility file. It holds shared constants, the orchestrator/parallel prompt, the single-review prompt, the fixer prompt, and the toggle prompt — all interleaved with zh/en conditionals. That makes prompt changes harder to review and easier to drift across language branches. Splitting by responsibility reduces cognitive load and change risk, while the tests from Plan 005 prove no behavior changed.

## Current state

- The relevant files:
  - `src/agent.ts` — the file being split; contains all prompt builders and shared constants.
  - `src/index.ts` — imports `buildAgentPrompt`, `buildFixerPrompt`, and `buildTogglePrompt` from `./agent.ts`.
  - `src/dimensions/index.ts` — imported by `src/agent.ts` for `getDimensionPrompts`.
  - `src/agent.test.ts` — tests created in Plan 005; must still pass after the split.

- Current code excerpts:
  - `src/agent.ts:1-2`
    - `import type { ReviewConfig } from "./config.ts"`
    - `import { getDimensionPrompts } from "./dimensions/index.ts"`
  - `src/agent.ts:4-25` — `DIMENSION_LABELS` constant (5 dimensions, zh/en labels).
  - `src/agent.ts:27-35` — `buildDimensionList` helper (maps config.dimensions to labeled bullet list).
  - `src/agent.ts:37-40` — `buildCustomRules` helper (formats custom rules section).
  - `src/agent.ts:42-77` — `REPORT_FORMAT` constant (zh/en output format templates).
  - `src/agent.ts:79-92` — `AUTO_FIX_INSTRUCTION` constant (zh/en auto-fix instructions).
  - `src/agent.ts:94-99` — `buildAgentPrompt` (dispatches to parallel vs single).
  - `src/agent.ts:101-147` — `buildParallelPrompt` (orchestrator prompt, zh/en).
  - `src/agent.ts:149-265` — `buildSinglePrompt` (single-review prompt, zh/en).
  - `src/agent.ts:267-321` — `buildFixerPrompt` (fixer agent prompt, zh/en).
  - `src/agent.ts:323-345` — `buildTogglePrompt` (toggle command prompt, zh/en).
  - `src/index.ts:3`
    - `import { buildAgentPrompt, buildFixerPrompt, buildTogglePrompt } from "./agent.ts"`

- Repo conventions that apply here:
  - TypeScript strict mode, ESM, no default exports for utilities.
  - The repo uses arrow functions for exported utilities (see `src/config.ts:46`, `src/dimensions/index.ts:130`). Match this style in new modules.
  - This is a pure refactor: no prompt wording changes, no behavior changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat b826dcd..HEAD -- src/agent.ts src/index.ts src/dimensions/index.ts` | no unexpected drift |
| Run tests (proves no behavior change) | `pnpm test` | all tests pass, same count as before |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Full verification | `pnpm verify` | exit 0 |
| Scope check | `git diff --stat -- src/agent.ts src/prompts/ src/index.ts` | only in-scope files changed |

## Scope

**In scope** (the only files you should modify or create):
- `src/agent.ts` (reduce to a thin facade)
- `src/prompts/shared.ts` (create — constants and helpers)
- `src/prompts/review.ts` (create — orchestrator + single prompt)
- `src/prompts/fixer.ts` (create — fixer prompt)
- `src/prompts/toggle.ts` (create — toggle prompt)
- `src/index.ts` (only if import paths need updating — see Step 5)

**Out of scope** (do NOT touch):
- `src/config.ts` — no changes
- `src/dimensions/index.ts` — no changes
- `src/tools/` — no changes
- Any prompt wording, agent configuration, or review workflow behavior
- Test files (`src/*.test.ts`) — they must pass unchanged, proving no behavior drift

## Git workflow

- Branch: `advisor/006-split-agent-prompts`
- Commit per step or per logical unit; message style: concise imperative or conventional commits.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create `src/prompts/shared.ts` with constants and helpers

Extract the shared building blocks used across multiple prompt types.

Move these from `src/agent.ts` into `src/prompts/shared.ts`:
- `DIMENSION_LABELS` (lines 4-25)
- `buildDimensionList` (lines 27-35)
- `buildCustomRules` (lines 37-40)
- `REPORT_FORMAT` (lines 42-77)
- `AUTO_FIX_INSTRUCTION` (lines 79-92)

Export all of them from `shared.ts`. Use the same export style (named exports, arrow functions for helpers, `const` for data).

**Verify**: `pnpm typecheck` exits 0 (shared.ts compiles; it may have unused-export warnings from lint but no errors).

### Step 2: Create `src/prompts/review.ts` with the review prompt builders

Extract the orchestrator and single-review prompt logic.

Move these from `src/agent.ts` into `src/prompts/review.ts`:
- `buildAgentPrompt` (lines 94-99) — the public dispatcher
- `buildParallelPrompt` (lines 101-147) — internal
- `buildSinglePrompt` (lines 149-265) — internal

Import shared helpers from `./shared.ts` and `getDimensionPrompts` from `../dimensions/index.ts`.

Export `buildAgentPrompt` from `review.ts`. Keep `buildParallelPrompt` and `buildSinglePrompt` as internal (not exported).

**Verify**: `pnpm typecheck` exits 0; `pnpm test src/agent.test.ts` passes (tests import from `../agent.ts` which still re-exports).

### Step 3: Create `src/prompts/fixer.ts` with the fixer prompt builder

Extract the fixer prompt.

Move this from `src/agent.ts` into `src/prompts/fixer.ts`:
- `buildFixerPrompt` (lines 267-321)

No shared imports needed (the fixer prompt is self-contained).

Export `buildFixerPrompt` from `fixer.ts`.

**Verify**: `pnpm typecheck` exits 0.

### Step 4: Create `src/prompts/toggle.ts` with the toggle prompt builder

Extract the toggle prompt.

Move this from `src/agent.ts` into `src/prompts/toggle.ts`:
- `buildTogglePrompt` (lines 323-345)

No shared imports needed.

Export `buildTogglePrompt` from `toggle.ts`.

**Verify**: `pnpm typecheck` exits 0.

### Step 5: Reduce `src/agent.ts` to a compatibility facade

Replace the full implementation in `src/agent.ts` with a thin re-export module.

Target content of `src/agent.ts`:
- Import `buildAgentPrompt` from `./prompts/review.ts`
- Import `buildFixerPrompt` from `./prompts/fixer.ts`
- Import `buildTogglePrompt` from `./prompts/toggle.ts`
- Re-export all three with the same names

This preserves backward compatibility: `src/index.ts:3` still imports from `./agent.ts` and works unchanged.

Do NOT change `src/index.ts` unless the re-export causes a type error — if it does, update the import path to point at the new modules directly.

**Verify**: `pnpm typecheck` exits 0; `src/agent.ts` is under 15 lines.

### Step 6: Run the full test suite to prove no behavior change

Run all tests from Plan 005. Every test must pass without modification.

This is the critical gate: if any test fails, the refactor changed behavior and must be corrected before proceeding.

**Verify**: `pnpm test` exits 0 with the same test count as before the refactor.

### Step 7: Run full verification

**Verify**: `pnpm verify` exits 0 (typecheck + lint + build + test).

## Test plan

- No new tests in this plan — it is a pure refactor.
- The tests from Plan 005 (`src/agent.test.ts`, `src/dimensions/index.test.ts`, etc.) serve as the regression guard.
- If the tests pass unchanged, the refactor preserved behavior.
- If any test fails, STOP — the refactor introduced a behavior change.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `src/agent.ts` is a thin facade under ~15 lines (re-exports only)
- [ ] `src/prompts/shared.ts` exists with constants and helpers
- [ ] `src/prompts/review.ts` exists with `buildAgentPrompt`
- [ ] `src/prompts/fixer.ts` exists with `buildFixerPrompt`
- [ ] `src/prompts/toggle.ts` exists with `buildTogglePrompt`
- [ ] `pnpm test` exits 0 with the same test count as before (no test modifications)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm verify` exits 0
- [ ] `src/index.ts` imports are unchanged or updated with no behavioral difference
- [ ] No prompt wording changes (diff shows only code movement, not text edits)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the codebase has drifted since this plan was written).
- The tests from Plan 005 do not exist yet — this plan depends on them as the regression guard.
- The refactor causes test failures that indicate prompt output drift (not just whitespace).
- Splitting the file forces unrelated runtime changes in plugin registration (`src/index.ts`).
- The new module layout creates circular imports that cannot be resolved without changing the architecture.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A reviewer should diff `src/agent.ts` against the new `src/prompts/` files to confirm the refactor is pure code movement — no wording changes, no logic changes, only file boundaries shifting.
- The shared module (`src/prompts/shared.ts`) may grow over time as more prompt types share constants. If it becomes a junk drawer, split it further by concern (e.g., `formats.ts` vs `labels.ts`).
- If new dimensions are added in the future, `DIMENSION_LABELS` and the `DIMENSIONS` map in `src/dimensions/index.ts` must stay in sync — consider a future plan to consolidate them into a single source of truth.
- The facade in `src/agent.ts` can be removed once all consumers (`src/index.ts`, tests) import directly from `src/prompts/`. That is a follow-up cleanup, not part of this plan.
