# Plan 006 — Split `src/agent.ts` into prompt modules

## Status
- [x] Written
- [ ] In Progress
- [ ] Done

## Motivation

`src/agent.ts` is 347 lines with 4 exported functions, 4 private helpers, and large inline string literals. Each prompt variant (parallel, single, fixer, toggle) is independently readable and edit-able — but currently any change to one risks touching the others. Splitting into modules follows the same pattern as `src/dimensions/index.ts`: separate file per logical concern, barrel re-export from the main index.

## Goal

Refactor `src/agent.ts` into `src/prompts/` modules — zero behavior change, all 26 tests from Plan 005 continue to pass.

## New structure

```
src/prompts/
├── index.ts              # public API: re-exports all build* functions
├── shared.ts             # DIMENSION_LABELS, buildDimensionList, buildCustomRules
├── parallel.ts           # buildParallelPrompt + REPORT_FORMAT/AUTO_FIX_INSTRUCTION
├── single.ts             # buildSinglePrompt (full zh/en strings)
├── fixer.ts              # buildFixerPrompt (full zh/en strings)
└── toggle.ts             # buildTogglePrompt (full zh/en strings)

src/
├── agent.ts              # REMOVED — replaced by prompts/index.ts
```

**Key invariant**: `src/prompts/index.ts` exports the exact same public API as the old `src/agent.ts`:
- `buildAgentPrompt`
- `buildFixerPrompt`
- `buildTogglePrompt`

Consumers (in `src/index.ts`) import from `src/agent.ts` today — they must switch to `src/prompts/index.ts`. No other file may import from the new internal modules.

## Implementation steps

### Step 1 — Create `src/prompts/shared.ts`
Extract:
- `DIMENSION_LABELS` (const)
- `buildDimensionList` (function)
- `buildCustomRules` (function)

### Step 2 — Create `src/prompts/parallel.ts`
Extract:
- `REPORT_FORMAT` (const — moved from agent.ts)
- `AUTO_FIX_INSTRUCTION` (const — moved from agent.ts)
- `buildParallelPrompt` (function)

`buildParallelPrompt` imports `getDimensionPrompts` from `../dimensions/index.ts` and `buildDimensionList` is NOT needed here (parallel uses `dimensionList` built from `getDimensionPrompts`).

### Step 3 — Create `src/prompts/single.ts`
Extract:
- `buildSinglePrompt` (function — full zh/en string literals inline)

Imports `buildDimensionList` and `buildCustomRules` from `./shared.ts`.

### Step 4 — Create `src/prompts/fixer.ts`
Extract:
- `buildFixerPrompt` (function — full zh/en string literals inline)

### Step 5 — Create `src/prompts/toggle.ts`
Extract:
- `buildTogglePrompt` (function — full zh/en string literals inline)

### Step 6 — Create `src/prompts/index.ts`
```ts
export { buildAgentPrompt } from "./agent.ts";  // ← wait, agent.ts is gone
```

Correction — the barrel re-export must be:
```ts
export { buildAgentPrompt } from "./parallel.ts";  // buildAgentPrompt lives in parallel.ts? No — it's in agent.ts
```

Correction 2 — `buildAgentPrompt` is the router that calls `buildParallelPrompt` or `buildSinglePrompt`. It needs to live somewhere. Options:
- **Option A**: Keep `buildAgentPrompt` in `parallel.ts` (since it returns parallel or single, but delegates to `buildParallelPrompt` which it contains)
- **Option B**: Keep `buildAgentPrompt` in a new `agent.ts` inside `src/prompts/agent.ts`
- **Option C**: Move `buildAgentPrompt` into `src/prompts/index.ts` as a thin wrapper

**Chosen: Option A** — `buildAgentPrompt` lives in `parallel.ts` alongside `buildParallelPrompt` (the parallel module). The parallel/single split is at the `buildAgentPrompt` level, so grouping them is logical.

So `src/prompts/parallel.ts` exports both `buildAgentPrompt` and `buildParallelPrompt`.

Final exports from `src/prompts/index.ts`:
```ts
export { buildAgentPrompt } from "./parallel.ts";
export { buildFixerPrompt } from "./fixer.ts";
export { buildTogglePrompt } from "./toggle.ts";
```

### Step 7 — Update imports in `src/index.ts`

Change:
```ts
import { buildAgentPrompt, buildFixerPrompt, buildTogglePrompt } from "./agent.ts";
```
To:
```ts
import { buildAgentPrompt, buildFixerPrompt, buildTogglePrompt } from "./prompts/index.ts";
```

### Step 8 — Verify

```bash
pnpm verify
```

All 26 tests must pass. No behavior change.

## Stop conditions

- `pnpm verify` exits 0
- All 26 tests pass
- `src/agent.ts` no longer exists
- `src/prompts/index.ts` re-exports the 3 public functions
- No file imports from internal `prompts/` submodules except `prompts/index.ts`
