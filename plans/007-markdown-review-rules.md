# Plan 007: Load markdown review rules from `review-rules/` and inject them into all review agents

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 79480b6..HEAD -- src/config.ts src/dimensions/index.ts src/prompts/shared.ts src/prompts/agent/single.ts src/prompts/agent/parallel.ts src/prompts/fixer.ts src/index.ts src/config.test.ts src/agent.test.ts src/dimensions/index.test.ts src/index.test.ts plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `79480b6`, 2026-07-03
- **Issue**: none

## Why this matters

`custom_rules` is currently just a `string[]` in `review.json`, and those strings only reach the single-agent prompt. That makes review guidance hard to structure, impossible to scope to dimensions, and invisible to the parallel orchestrator, sub-agents, and fixer. This change introduces markdown rule documents under `review-rules/` so review policy can live in readable files, be scoped explicitly, and flow through every review path without breaking existing config.

## Current state

The executor needs these facts inlined:

- `src/config.ts` — `ReviewConfig` has `custom_rules: string[]` only; `loadConfig()` merges global JSON and project JSON, but does not load markdown files.
- `src/prompts/shared.ts` — `buildCustomRules()` only formats inline strings from config.
- `src/prompts/agent/single.ts` — only prompt builder that currently injects `custom_rules`.
- `src/prompts/agent/parallel.ts` — orchestrator prompt does not mention custom rules or rule documents.
- `src/prompts/fixer.ts` — fixer prompt has no custom rule injection.
- `src/dimensions/index.ts` — fixed built-in dimension registry; unknown dimensions are filtered out.
- `src/index.ts` — loads config once and builds prompts from it at plugin init.

Relevant current behavior:

- `custom_rules` is rendered as `### Custom Rules` only in `src/prompts/agent/single.ts`.
- Parallel mode uses `getDimensionPrompts(config)` and never sees `custom_rules`.
- `src/dimensions/index.ts` currently knows only: `code-quality`, `security`, `performance`, `testing`, `documentation`.

Repo conventions to match:

- Keep markdown bodies human-first.
- Preserve existing backward-compatible config keys unless there is a strong reason to remove them.
- Keep prompt text bilingual (`zh`/`en`) where the surrounding code already does so.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | all pass |
| Lint | `pnpm lint` | exit 0 |
| Build | `pnpm build` | exit 0 |

## Scope

**In scope** (the only files you should modify):

- `src/config.ts`
- `src/dimensions/index.ts`
- `src/prompts/shared.ts`
- `src/prompts/agent/single.ts`
- `src/prompts/agent/parallel.ts`
- `src/prompts/fixer.ts`
- `src/index.ts`
- `src/config.test.ts`
- `src/agent.test.ts`
- `src/dimensions/index.test.ts`
- `src/index.test.ts`
- `src/rule-files.ts` (create)
- `src/rule-files.test.ts` (create)
- `plans/README.md`

**Out of scope** (do NOT touch):

- `src/cli/*` — unrelated to review prompt generation.
- `README.md` — follow-up doc update only if the behavior lands and needs user-facing documentation.

## Design contract

The plan must implement the design that was agreed in discussion:

- The rules directory is named `review-rules`.
- Global rules live in `~/.config/opencode/review-rules/`.
- Project rules live in `.opencode/review-rules/`.
- The two scopes are merged, with global files first and project files after.
- Files are markdown documents containing many rules separated by headings/lists.
- Frontmatter is required and must contain `dimensions`.
- `dimensions: []` means general rules, applied to all review agents.
- `dimensions: [security, testing]` scopes that file to those active dimensions.
- Malformed or missing frontmatter must be skipped with a warning, not fail the whole load.
- Unknown dimensions in frontmatter must be skipped with a warning.
- `custom_rules: string[]` stays supported for backward compatibility.
- The built-in dimension registry expands to:
  - `code-quality`
  - `security`
  - `performance`
  - `testing`
  - `documentation`
  - `error-handling`
  - `api-design`
  - `dependencies`
  - `maintainability`
- Users customize active dimensions by editing `review.json.dimensions`.

## Steps

### Step 1: Add a markdown rule file loader

Create `src/rule-files.ts` with a small, explicit loader for `review-rules/`.

Required behavior:

- Scan both `~/.config/opencode/review-rules/` and `<project>/.opencode/review-rules/` recursively for `.md` files.
- Parse a required frontmatter block from each file.
- Extract `dimensions` from frontmatter.
- Remove frontmatter from the body before returning it.
- Validate `dimensions` against the known built-in dimension registry.
- Sort deterministically:
  - global files before project files
  - numbered filenames before unnumbered ones
  - numeric order for numbered files
  - alphabetical fallback for unnumbered files
- Skip malformed files with a warning.

Implement minimal frontmatter parsing for the allowed shapes we agreed on:

- `dimensions: []`
- `dimensions: [security, testing]`
-
  ```yaml
  dimensions:
    - security
    - testing
  ```

**Verify**: `pnpm typecheck` → exit 0

### Step 2: Extend the dimension registry

Update `src/dimensions/index.ts` to add the four new built-in dimensions:

- `error-handling`
- `api-design`
- `dependencies`
- `maintainability`

Match the existing pattern in the file:

- bilingual `zh` and `en` prompt bodies
- short review-focus bullet lists
- same output format style as the current dimensions

Also update `getDimensionPrompts()` / `buildDimensionPrompt()` so a dimension prompt can receive loaded rule documents and inject:

- general rule documents (`dimensions: []`)
- dimension-scoped rule documents that include the current dimension

**Verify**: `pnpm test -- src/dimensions/index.test.ts` → all pass

### Step 3: Thread loaded rule documents through config and prompts

Update `src/config.ts` so `loadConfig()` also loads rule documents and returns them alongside JSON config.

Add a `file_rules` field to `ReviewConfig` and keep `custom_rules` unchanged.

Update prompt helpers in `src/prompts/shared.ts` to render:

- inline `custom_rules`
- markdown rule documents
- the orchestrator summary of which rule documents are scoped to which dimensions

Update prompt builders:

- `src/prompts/agent/single.ts` — include markdown rules in the single-agent prompt
- `src/prompts/agent/parallel.ts` — include general rules plus a scoped-rule summary for the orchestrator
- `src/prompts/fixer.ts` — include general rules only

Update `src/index.ts` to pass the enriched config through to the prompt builders.

**Verify**: `pnpm test -- src/agent.test.ts src/index.test.ts` → all pass

### Step 4: Add tests for the new loader and prompt behavior

Create `src/rule-files.test.ts` to cover:

- valid frontmatter parsing
- missing frontmatter warning and skip
- missing `dimensions` warning and skip
- unknown dimension warning and skip
- global/project merge order
- numeric-prefix ordering
- alphabetical fallback for unnumbered files
- recursive discovery

Extend existing tests:

- `src/config.test.ts` — include `file_rules` in fixtures and verify load behavior
- `src/agent.test.ts` — verify file rules show up in single and parallel prompts
- `src/dimensions/index.test.ts` — verify scoped files only reach matching dimensions
- `src/index.test.ts` — include `file_rules` in the mocked config

**Verify**: `pnpm test` → all pass

### Step 5: Final verification

Run the full checks in this order:

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm lint`
4. `pnpm build`

If any of these fail twice after a reasonable fix attempt, stop and report.

## Test plan

- Loader tests for frontmatter, validation, merge order, and recursion.
- Prompt tests for single, parallel, fixer, and dimension-specific injection.
- Regression tests to prove `custom_rules` still works unchanged.
- Registry tests for the four new dimensions and user-selected active subsets.

## Done criteria

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm build` exits 0
- [ ] `custom_rules` still works in `review.json`
- [ ] Markdown rule documents load from `review-rules/`
- [ ] Malformed frontmatter is skipped with a warning
- [ ] New dimensions exist in the registry and can be selected in config
- [ ] `plans/README.md` updated

## STOP conditions

Stop and report back if:

- frontmatter parsing cannot be implemented without a heavier parser dependency than expected
- the prompt changes require a wider refactor than the files listed in scope
- the new dimension prompts diverge from the current bilingual prompt style
- the repository drifted and the current code no longer matches the excerpts above

## Maintenance notes

- The next change after this plan should be a README update explaining `review-rules/` for users.
- Reviewers should scrutinize loader ordering and scoping, because those are the places where prompt drift becomes invisible.
- If a future version adds richer metadata, expand the frontmatter parser deliberately rather than inferring behavior from filenames.
