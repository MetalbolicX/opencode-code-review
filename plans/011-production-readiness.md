# Plan 011: Fix production-readiness blockers

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat c2c6a26..HEAD -- .gitignore package.json vitest.config.ts src/index.ts src/tools/review-changes.ts src/tools/toggle-auto-review.js`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (plans 001–010 are all DONE)
- **Category**: tech-debt
- **Planned at**: commit `c2c6a26`, 2026-07-03

## Why this matters

`pnpm verify` (the repo's single release gate) is broken because Biome emits 26 lint errors. Stale compiled `.js` files sit in `src/` alongside `.ts` sources, which biome also catches and which could shadow the TypeScript sources in editors. Test coverage exists locally but is not enforced, and vitest is configured to silently pass with zero tests (`--passWithNoTests`). The plugin entry and tool files use `as any` and `@ts-expect-error` to evade the compiler on the hot path. Fixing all five makes the verify gate green, prevents future drift, and gives the repo a trustworthy baseline for release.

## Current state

### Files in scope

- `.gitignore` — has `!src/` re-include that allows `.js` files under `src/` (lines 4, 7)
- `package.json:20-24` — scripts: test uses `--passWithNoTests`, no coverage or format script
- `vitest.config.ts:1-11` — no `coverage` section at all, despite `@vitest/coverage-v8` in devDeps
- `src/index.ts:11` — `@ts-expect-error TS2322: pre-existing type bug — config hook returns void not Promise<void>`
- `src/index.ts:117` — `const ev = event as any;`
- `src/tools/review-changes.ts:25-26` — `// biome-ignore` + `const $ = (context as any).$;`
- `src/cli/install.test.ts:75-79` — `process.env["HOME"]` should be `process.env.HOME` (biome useLiteralKeys, 3×)
- `src/dimensions/index.ts:114-126` — formatting errors (indentation)
- `src/tools/toggle-auto-review.js` — stale untracked `.js` file on disk (caught by biome, not in git)

### Biome lint baseline (from `biome check src/ 2>&1 | head -60`)

```
src/cli/install.test.ts:75 useLiteralKeys FIXABLE
src/cli/install.test.ts:77 useLiteralKeys FIXABLE
src/cli/install.test.ts:79 useLiteralKeys FIXABLE
src/dimensions/index.ts:114-126 format FIXABLE
src/tools/toggle-auto-review.js format FIXABLE
... 49+ additional diagnostics (--max-diagnostics exceeded)
```

Most errors are `useLiteralKeys` (auto-fixable) or `format` (auto-fixable by `biome check --write`). The stale `.js` file is one of them.

### Repo conventions

- Co-located tests: `*.test.ts` next to source files
- Biome recommended preset, space indentation 2-width
- TypeScript strict mode, ESM
- All 10 prior plans in `plans/README.md` are DONE
- The auto-review event handler at `src/index.ts:110-139` already has Plan 010's `lastAutoReviewTime = 0` reset in the catch block — that is by-design, do NOT change it

## Locked decisions (do NOT deviate)

1. **Use `pnpm exec biome check --write src/`** to auto-fix the biome errors — do not fix them one by one. After the write pass, run a read-only check to confirm zero errors.
2. **Delete `src/tools/toggle-auto-review.js`** — it is a stale untracked artifact, not a source file. Add a blanket `src/**/*.js` pattern to `.gitignore` instead.
3. **Remove `--passWithNoTests`** and add a `coverage.reporter` + `coverage.include` block to `vitest.config.ts`. Do not set a `coverage.threshold` number yet — record the baseline first.
4. **For `src/index.ts:117` (`as any` on event)**: define a local `SessionIdleEvent` interface that captures the shape the handler actually reads, and cast to that instead of `any`.
5. **For `src/tools/review-changes.ts:26` (`as any` on context)**: define a local `ToolContextWithShell` type that extends `ToolContext` with BunShell properties, cast to that, and remove the `biome-ignore` comment.
6. **For `src/index.ts:11` (`@ts-expect-error`)**: investigate whether `return Promise.resolve()` satisfies the type; if not, keep the suppression with a tighter comment. Do NOT change the plugin contract unless upstream types are verified.
7. **Do NOT add retry/backoff, CI workflows, or any other category** — this plan is scoped to the five blockers in "Why this matters."

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint (fix) | `pnpm exec biome check --write src/` | exit 0, fixes applied |
| Lint (verify) | `pnpm lint` | exit 0, no errors |
| Build | `pnpm build` | exit 0 |
| Tests | `pnpm test` | exit 0, all pass |
| Coverage | `pnpm exec vitest run --coverage` | exit 0, html/text output generated |
| Full verify | `pnpm verify` | exit 0 |

## Scope

**In scope**: `.gitignore`, `package.json` (scripts only), `vitest.config.ts`, `src/index.ts` (lines 11, 117), `src/tools/review-changes.ts` (lines 1-6, 25-26), `src/tools/toggle-auto-review.js` (delete).

**Out of scope**: `src/config.ts`, `src/rule-files.ts`, `src/prompts/*`, `src/cli/*` (auto-fixable lint only), CI workflows, retry/backoff logic, `coverage.threshold`.

## Git workflow

Use the current branch. Commit after all steps pass. Message style: `fix: repair verify gate and harden production baseline`. Do not push or open a PR.

## Steps

### Step 1: Run full biome diagnostics

```bash
pnpm exec biome check --max-diagnostics=none src/ 2>&1 | tee /tmp/biome-full.txt
```

Read `/tmp/biome-full.txt`. Confirm errors are `useLiteralKeys`, `format`, or the stale `.js` file. If anything else appears, read that file+line before proceeding.

**Verify**: `/tmp/biome-full.txt` lists all biome issues.

### Step 2: Auto-fix all biome errors

```bash
pnpm exec biome check --write --max-diagnostics=none src/
```

**Verify**: `pnpm lint` → exit 0, zero errors.

### Step 3: Delete stale `.js` artifact

```bash
rm src/tools/toggle-auto-review.js
```

**Verify**: `ls src/tools/toggle-auto-review.js` → "No such file or directory". `pnpm lint` → still exit 0.

### Step 4: Harden `.gitignore`

In `.gitignore`, add `src/**/*.js` after `!src/`. Result:

```
node_modules/
dist/
coverage/
*.js
*.d.ts
*.js.map
!src/
src/**/*.js
.DS_Store
.serena
```

**Verify**: `touch src/test-artifact.js && git check-ignore -v src/test-artifact.js` → `src/**/*.js` matches. `rm src/test-artifact.js`.

### Step 5: Remove `--passWithNoTests`

In `package.json:21`:
```json
"test": "vitest run",
```

**Verify**: `pnpm test` → exit 0, all 161 tests pass.

### Step 6: Add coverage config to vitest

Replace `vitest.config.ts` content:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.test.js", "**/*.js", "dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html"],
    },
  },
});
```

**Verify**: `pnpm exec vitest run --coverage` → exit 0, `coverage/index.html` generated. Note the line coverage % as the baseline.

### Step 7: Replace `as any` on event in `src/index.ts`

Add after imports in `src/index.ts`:

```typescript
interface SessionIdleEvent {
  type: string;
  properties?: { sessionID?: string; id?: string };
  id?: string;
}
```

Change line 117:
```typescript
const ev = event as any;
// becomes
const ev = event as unknown as SessionIdleEvent;
```

**Verify**: `pnpm typecheck` → exit 0. `grep -rn "as any" src/index.ts` → no matches.

### Step 8: Replace `as any` on context in `src/tools/review-changes.ts`

Update import to include `ToolContext`:

```typescript
import { tool, type ToolDefinition, type ToolContext } from "@opencode-ai/plugin";
```

Add below `CommandResult` type:

```typescript
interface ToolContextWithShell extends ToolContext {
  $: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<CommandResult>;
  command: (parts: string[]) => Promise<CommandResult>;
}
```

Change lines 25-26:
```typescript
// biome-ignore lint/suspicious/noExplicitAny: runtime provides BunShell but ToolContext type doesn't include it
const $ = (context as any).$;
// becomes
const ctx = context as unknown as ToolContextWithShell;
const $ = ctx.$;
const command = ctx.command;
```

If `ToolContext` is not exported from `@opencode-ai/plugin`, define `interface ToolContext { [key: string]: unknown }` locally and skip its import.

**Verify**: `pnpm typecheck` → exit 0. `grep -rn "as any" src/tools/review-changes.ts` → no matches. `grep -rn "biome-ignore" src/tools/review-changes.ts` → no matches.

### Step 9: Fix `@ts-expect-error` on plugin entry

```bash
grep -rn "config" node_modules/@opencode-ai/plugin/dist/*.d.ts 2>/dev/null | head -20
```

If the upstream type expects `Promise<void>` from the config callback and it currently returns `void`: add `return Promise.resolve();` at the end of the config callback and remove `@ts-expect-error`. Otherwise keep it with a tighter comment naming the upstream type file.

**Verify**: `pnpm typecheck` → exit 0.

### Step 10: Full verification

```bash
pnpm verify
```

**Verify**: exit 0.

## Test plan

No new tests — existing 161 tests serve as regression guard. Coverage run generates a baseline report (Step 6 verify) but does not gate.

## Done criteria

- [ ] `pnpm verify` exits 0
- [ ] `src/tools/toggle-auto-review.js` deleted from disk
- [ ] `.gitignore` contains `src/**/*.js`
- [ ] `grep -rn "as any" src/index.ts src/tools/review-changes.ts` → no matches
- [ ] `grep -rn "biome-ignore" src/tools/review-changes.ts` → no matches
- [ ] `--passWithNoTests` removed from `package.json`
- [ ] `vitest.config.ts` has `coverage` block
- [ ] `pnpm exec vitest run --coverage` generates `coverage/index.html`
- [ ] `git status --short` shows only in-scope files

## STOP conditions

Stop and report if:
- Biome write pass leaves residual errors
- `pnpm test` fails or finds zero tests after removing `--passWithNoTests`
- Step 9 reveals an unresolvable upstream type mismatch
- Any change causes a type error outside in-scope files
- A verification command fails twice

## Maintenance notes

- After landing: set a `coverage.threshold` once the baseline % is reviewed.
- If `@opencode-ai/plugin` exports proper BunShell types later, revisit Step 8 to remove the local interface.
- The `!src/` + `src/**/*.js` gitignore pattern relies on last-match-wins ordering — add a comment warning if another negate pattern is added below `src/**/*.js`.
