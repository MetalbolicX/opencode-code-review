# Plan 009: Accept CRLF (Windows) line endings in review rule files

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5136194..HEAD -- src/rule-files.ts src/rule-files.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5136194`, 2026-07-03
- **Issue**: n/a

## Why this matters

Markdown rule files edited on Windows carry `\r\n` line endings. The rule loader currently only recognizes `---\n` at the opening fence, so **every CRLF rule file is silently skipped** with a "missing frontmatter block" warning. Worse, even if the opening fence passed, the parser's `split("\n")` would leave a trailing `\r` on every line, which breaks closing-fence detection and the `dimensions:` regex. This makes the rule system platform-sensitive. The fix normalizes line endings once, at the entry, so the entire parser works on clean LF input.

## Current state

**Files in scope:**
- `src/rule-files.ts:117-145` — `parseFrontmatter()` (the parser).
- `src/rule-files.ts:326-359` — `tryParseFile()` (the loader gate that runs *before* the parser).
- `src/rule-files.test.ts:99-183` — `ruleFile` / `yamlRuleFile` helpers and `parseFrontmatter` tests.

**Verbatim code that must change — TWO gatekeeper sites, in execution order:**

`src/rule-files.ts:341` — this is the OUTER gate. It runs at line 341, *before* `parseFrontmatter` is called at line 346. A CRLF file fails this check and is skipped before the parser ever sees it:
```typescript
  const hasFrontmatter = raw.startsWith("---\n") || raw === "---";
```

`src/rule-files.ts:117-125` — `parseFrontmatter`'s entry. Even if the outer gate passed, this inner check plus the `split("\n")` would leave `\r` on every line:
```typescript
export const parseFrontmatter = (text: string): ParsedFrontmatter | null => {
  // Frontmatter must start at the very first line.
  if (!text.startsWith("---\n") && text !== "---") return null;

  const rest = text.startsWith("---\n") ? text.slice(4) : text.slice(3);
  const normalized = rest.startsWith("\r\n") ? rest.slice(2) : rest;
  const lines = normalized.split("\n");
```

**Why a "just fix the opening fence" approach FAILS:** line 125 `split("\n")` keeps a trailing `\r` on every line. The closing-fence check at line 128 (`lines[i] === "---"`) then compares `"---\r" === "---"` → false, so the fence is never found and the function returns `null`. The `dimensions:` regex at line 156 (`/^dimensions\s*:\s*(.*)$/`) also captures the trailing `\r` into the value. **Normalizing `\r\n → \n` once at the top of the parser fixes all of these in one stroke.**

## Locked decisions (do NOT deviate)

1. **Normalization strategy**: convert `\r\n` → `\n` at the very top of `parseFrontmatter`, before any splitting or fence matching. Do NOT attempt to handle `\r` per-line at each comparison site — that scatters the fix and is fragile.
2. **Outer gate** (`tryParseFile:341`): add `raw.startsWith("---\r\n")` to the existing check so CRLF files are not rejected before reaching the parser.
3. **CRLF test helper is MANDATORY**, not optional — the existing `ruleFile`/`yamlRuleFile` helpers hardcode `\n` and cannot produce CRLF input.
4. **LF behavior must not change** — all existing tests must keep passing unmodified.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test -- src/rule-files.test.ts` | exit 0; all pass |

## Scope

**In scope**:
- `src/rule-files.ts`
- `src/rule-files.test.ts`

**Out of scope**:
- `src/config.ts` — benefits automatically through `loadRuleFiles`; do not touch.
- Any change to the rule-file frontmatter *format* (keys, YAML syntax). Only line-ending handling changes.
- Standalone lone-`\r` (old Mac) endings — out of scope; only `\r\n` is in scope.

## Git workflow

- Use the current branch; no branch-naming convention is evident in this repo.
- Do not commit, push, or open a PR.

## Steps

### Step 1: Add a CRLF test helper and a failing test FIRST

In `src/rule-files.test.ts`, near the existing `ruleFile` helper (line 99), add a CRLF helper. The body is joined with `\r\n` so a real Windows-authored file is faithfully represented:

```typescript
/** Build a markdown string with inline-array frontmatter using CRLF endings. */
const crlfRuleFile = (body: string, dimensions: string[]): string =>
  `---\r\ndimensions: [${dimensions.join(", ")}]\r\n---\r\n\r\n${body}`;
```

Then add a test inside the existing `describe("parseFrontmatter", ...)` block (around line 183):

```typescript
  it("parses a CRLF document the same as its LF equivalent", () => {
    const crlf = crlfRuleFile("body text", ["security", "testing"]);
    const lf = ruleFile("body text", ["security", "testing"]);
    expect(parseFrontmatter(crlf)).toEqual(parseFrontmatter(lf));
  });
```

**Verify**: `pnpm test -- src/rule-files.test.ts` → the new CRLF test FAILS (returns `null` for the CRLF input). This confirms the bug is reproduced before you fix it. If it passes, STOP — the bug may already be fixed and the plan is stale.

### Step 2: Normalize line endings in `parseFrontmatter`

In `src/rule-files.ts`, rewrite the top of `parseFrontmatter` (lines 117-125) to normalize first:

```typescript
export const parseFrontmatter = (text: string): ParsedFrontmatter | null => {
  // Normalize CRLF (Windows) to LF so every downstream split/compare works on
  // clean line endings. This must happen before the opening-fence check.
  const src = text.replace(/\r\n/g, "\n");

  // Frontmatter must start at the very first line.
  if (!src.startsWith("---\n") && src !== "---") return null;

  const rest = src.startsWith("---\n") ? src.slice(4) : src.slice(3);
  const lines = rest.split("\n");
```

Remove the old `normalized` line (line 124) — it is now redundant because `src` is already LF-only. Leave the closing-fence loop (line 127-132), the body trimming (137-140), and `parseDimensionsKey` call (142) unchanged; they all operate on `lines`, which is now `\r`-free.

**Verify**: `pnpm test -- src/rule-files.test.ts` → the CRLF test from Step 1 now PASSES, and all existing LF tests still pass.

### Step 3: Fix the outer gate in `tryParseFile`

In `src/rule-files.ts:341`, add the CRLF opening-fence so the loader does not skip CRLF files before they reach the parser:

```typescript
  const hasFrontmatter =
    raw.startsWith("---\n") || raw.startsWith("---\r\n") || raw === "---";
```

Add a loader-level test near the existing `loadRuleFiles — basic loading` block (around line 219) to prove end-to-end CRLF loading:

```typescript
  it("loads a CRLF rule file the same as its LF equivalent", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/crlf.md": crlfRuleFile(
        "CRLF body",
        ["security"],
      ),
      "/home/user/.config/opencode/review-rules/lf.md": ruleFile(
        "CRLF body",
        ["security"],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ body: "CRLF body", dimensions: ["security"] });
    expect(result[1]).toMatchObject({ body: "CRLF body", dimensions: ["security"] });
  });
```

**Verify**: `pnpm test -- src/rule-files.test.ts` → all tests pass including the new loader test.

### Step 4: Typecheck

**Verify**: `pnpm typecheck` → exit 0.

## Test plan

- `src/rule-files.test.ts`
  - (new) `parseFrontmatter` parses a CRLF document identically to its LF equivalent
  - (new) `loadRuleFiles` loads a CRLF rule file end-to-end
  - (unchanged) all existing LF-only `parseFrontmatter` and `loadRuleFiles` tests keep passing
  - (new helper) `crlfRuleFile` is added next to `ruleFile`

Verification: `pnpm test -- src/rule-files.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- src/rule-files.test.ts` exits 0 with the 2 new CRLF tests passing
- [ ] `grep -n '\r\\\\n' src/rule-files.ts` shows the normalization in `parseFrontmatter` and the gate addition in `tryParseFile`
- [ ] All pre-existing tests in `src/rule-files.test.ts` pass unchanged (no LF regression)
- [ ] `git status --short` shows only `src/rule-files.ts`, `src/rule-files.test.ts`, and `plans/*` changes
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live code at `src/rule-files.ts:117-125` or `:341` no longer matches the excerpts in "Current state".
- The Step 1 failing test passes *before* any fix is applied (the bug is already fixed — the plan is stale).
- You find additional `\r` handling that the single normalization at the top of `parseFrontmatter` does NOT cover (e.g. lone `\r` without `\n`, or CRLF leaking through a different code path).
- The change would require touching `src/config.ts` or any out-of-scope file.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- Future rule-file parser changes MUST keep CRLF and LF parity. The single normalization point is the contract — do not add new `split("\n")` or `=== "---"` checks upstream of it.
- Reviewers: confirm the fix does not change rule ordering (`sortKey`) or dimension filtering (`validateDimensions`) — those operate on already-parsed values and should be unaffected.
- If a richer YAML parser is introduced later, keep this normalization as a regression guard (it is cheap and removes a whole class of platform bugs).
