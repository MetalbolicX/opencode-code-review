# Plan 008: Surface malformed review.json instead of silently falling back

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5136194..HEAD -- src/config.ts src/config.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5136194`, 2026-07-03
- **Issue**: n/a

## Why this matters

`review.json` currently disappears into defaults when it is malformed, so a typo or a bad merge can silently disable the user's intended review settings. The plugin keeps running with behavior the user did not ask for, and there is no signal telling them their config is broken. The fix keeps the plugin resilient (it must not crash the host) but makes the failure **visible** so the user can correct it.

## Current state

**Files in scope:**
- `src/config.ts:60-101` — `readJsonFile()` and `loadConfig()`.
- `src/config.test.ts:1-100` — regression tests; the malformed-JSON case is at lines 82-88.

**Verbatim code that must change:**

`src/config.ts:60-69` — today `readJsonFile` returns `null` for *every* failure, including malformed content:
```typescript
const readJsonFile = async (
  path: string,
): Promise<Partial<ReviewConfig> | null> => {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};
```

`src/config.ts:90-98` — `loadConfig` spreads the raw parsed value unconditionally:
```typescript
  return {
    ...DEFAULT_CONFIG,
    ...globalCfg,
    ...projectCfg,
    trigger: {
      ...DEFAULT_CONFIG.trigger,
      ...(globalCfg?.trigger ?? {}),
      ...(projectCfg?.trigger ?? {}),
    },
```

`src/config.test.ts:82-88` — the existing test asserts silent fallback:
```typescript
  it("malformed JSON falls back safely without throwing", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce("not valid json {")
      .mockRejectedValue(new Error("ENOENT"));
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
  });
```

## Locked decisions (do NOT deviate)

These resolve the ambiguities a cold executor would otherwise face:

1. **Mechanism**: use `console.warn(...)`. This matches the `[review-rules] ...` warning style already used in `src/rule-files.ts:297-305`. Do NOT add a `parseError` return field (that is the CLI's pattern at `src/cli/config.ts:445`, which is a different contract — out of scope here).
2. **Warning format**: `` `[opencode-code-review] ${path}: malformed config JSON — ${message}` `` where `message` is the error's `.message`. Use the same prefix and path-inclusion style.
3. **Missing file (`ENOENT`)**: return `null` silently. This is the current, correct behavior for absent files and must be preserved — see the existing test at `src/config.test.ts:46-50`.
4. **Malformed JSON (parse `SyntaxError`)**: `console.warn(...)` with the path and message, then return `null`. The plugin still falls back to defaults (resilient), but now visibly.
5. **Non-object root** (e.g. `JSON.parse("[]")` or `JSON.parse('"x"')`): `console.warn(...)` with a message like `"config root must be a JSON object"`, then treat the value as `null` (do NOT spread it into the defaults). This mirrors the guard at `src/cli/config.ts:185-187` but warns instead of throwing, because the plugin must not crash the host.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test -- src/config.test.ts` | exit 0; all pass |

## Suggested executor toolkit

(Optional.) Skills that may help if present in the executor's environment:
- If a `good-comments` / `doc-comments` skill is available, use it when adding the "why this warns rather than throws" comment at the new guard.

## Scope

**In scope**:
- `src/config.ts`
- `src/config.test.ts`

**Out of scope**:
- `src/cli/config.ts` — use it only as the behavioral reference for the object-root guard pattern. Do NOT change it.
- The `ReviewConfig` interface and any caller of `loadConfig`.
- Rule-file loading (`src/rule-files.ts`) — that path already warns correctly.

## Git workflow

- Use the current branch; no branch-naming convention is evident in this repo.
- Do not commit, push, or open a PR.

## Steps

### Step 1: Split `readJsonFile` into read-error vs parse-error paths

Rewrite `src/config.ts:60-69` so the read (`readFile`) and parse (`JSON.parse`) failures are caught separately. The target shape:

```typescript
const readJsonFile = async (
  path: string,
): Promise<Partial<ReviewConfig> | null> => {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    // Missing file is normal on fresh installs — stay silent so defaults apply cleanly.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    console.warn(
      `[opencode-code-review] ${path}: could not read config — ${(err as Error).message}`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    // Reject non-object roots (arrays, strings, numbers) before they reach the spread merge.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(
        `[opencode-code-review] ${path}: config root must be a JSON object`,
      );
      return null;
    }
    return parsed as Partial<ReviewConfig>;
  } catch (err) {
    console.warn(
      `[opencode-code-review] ${path}: malformed config JSON — ${(err as Error).message}`,
    );
    return null;
  }
};
```

Note: `loadConfig` at lines 90-98 does NOT need to change — it already spreads `globalCfg ?? {}` and `projectCfg ?? {}` style via the optional chaining on `trigger`. After this step, `globalCfg`/`projectCfg` are either a valid plain object or `null`, so the spread is safe.

**Verify**: `pnpm typecheck` → exit 0. (The existing malformed-JSON test at `src/config.test.ts:82-88` will still pass functionally — it asserts `config` equals `defaultConfig`, which is still true — but it does not yet assert the warning. That comes in Step 2.)

### Step 2: Update tests — assert the warning, add the non-object-root case

In `src/config.test.ts`:

1. **Tighten the existing malformed-JSON test** (lines 82-88): spy on `console.warn` and assert it was called with a message containing `malformed config JSON`. Add a `vi.spyOn(console, "warn").mockImplementation(() => {})` in `beforeEach` (extend the existing `beforeEach` at lines 42-44) and restore in an `afterEach` (add one if absent). Keep the existing `expect(config).toEqual(defaultConfig)` assertion.

2. **Add a new test** for the non-object-root case, modeled on the same `mockResolvedValueOnce` pattern:
```typescript
  it("warns and falls back when the config root is not an object", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce('["not", "an", "object"]')
      .mockRejectedValue(new Error("ENOENT"));
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("config root must be a JSON object"),
    );
  });
```

3. **Add a test** confirming a missing file stays silent (no warn):
```typescript
  it("missing config file applies defaults silently (no warning)", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
    expect(console.warn).not.toHaveBeenCalled();
  });
```

**Verify**: `pnpm test -- src/config.test.ts` → exit 0, all tests pass including the 2 new ones.

### Step 3: Full repo check

**Verify**: `pnpm typecheck` → exit 0.

## Test plan

- `src/config.test.ts`
  - (modified) malformed JSON falls back AND emits a `console.warn` containing `malformed config JSON`
  - (new) non-object JSON root falls back AND warns with `config root must be a JSON object`
  - (new) missing file applies defaults silently with no warning
  - existing override/merge tests keep passing unchanged

Verification: `pnpm test -- src/config.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- src/config.test.ts` exits 0 with the 2 new tests present and passing
- [ ] `grep -n "console.warn" src/config.ts` returns the 3 warning sites (unreadable, non-object, malformed)
- [ ] `git status --short` shows only `src/config.ts`, `src/config.test.ts`, and `plans/*` changes from this plan
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live code at `src/config.ts:60-69` no longer matches the excerpt in "Current state" (the drift check above flagged a change).
- `readJsonFile` is called from anywhere other than `loadConfig` in `src/config.ts` (it is currently private/module-scoped — if it gained other callers, the return-type change has wider blast radius).
- The existing test at `src/config.test.ts:46-50` ("returns default config when no config files exist") breaks — the missing-file path MUST stay silent.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- If `ReviewConfig` grows a schema validator, keep it here in `readJsonFile`/`loadConfig` rather than scattering type guards across callers.
- Reviewers: confirm the warning messages never echo raw file *contents* (only the path + the parse error message) — config files can hold values the user would not want logged.
- The distinction between "missing file" (silent) and "broken file" (warn) is load-bearing for DX; preserve it in future refactors.
