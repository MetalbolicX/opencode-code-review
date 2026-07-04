# Plan 010: Retry auto-review after a failed prompt

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 5136194..HEAD -- src/index.ts src/index.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `5136194`, 2026-07-03
- **Issue**: n/a

## Why this matters

The auto-review cooldown timestamp is stamped *before* the review prompt is dispatched. If `promptAsync` rejects (transient client error, session gone, etc.), the plugin still consumes the cooldown as if a review ran. The next `session.idle` event is then suppressed for `cooldown_seconds`, so a single transient failure silently skips reviews until the window expires. The fix is a one-line reset in the catch path so failed prompts can be retried on the next idle event.

## Current state

**Files in scope:**
- `src/index.ts:110-139` — the `session.idle` event handler.
- `src/index.test.ts:1-56` — smoke tests; there is NO coverage for the idle event's failure path.

**Verbatim code that must change:**

`src/index.ts:110-139` — note that `lastAutoReviewTime = now` (line 115) runs BEFORE the `await promptAsync` (line 123), and the catch (line 135) only logs:
```typescript
    event: async ({ event }) => {
      if (event.type === "session.idle" && autoEnabled) {
        const now = Date.now();
        if (now - lastAutoReviewTime < config.trigger.cooldown_seconds * 1000)
          return;
        lastAutoReviewTime = now;

        const ev = event as any;
        const sessionID =
          ev.properties?.sessionID ?? ev.properties?.id ?? ev.id;
        if (!sessionID) return;

        try {
          await client.session.promptAsync({
            body: {
              agent: "review",
              parts: [
                {
                  type: "text",
                  text: "Session completed. Running automatic code review on staged changes...",
                },
              ],
            },
            path: { id: sessionID },
          });
        } catch (e) {
          console.error("[auto-review] promptAsync failed:", e);
        }
      }
    },
```

`src/index.test.ts:5-15` — the module-level mock hardcodes `auto_on_idle: false`, so the idle guard at `src/index.ts:111` short-circuits in every current test:
```typescript
vi.mock("./config.ts", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    language: "zh",
    dimensions: ["code-quality"],
    max_diff_lines: 500,
    trigger: { auto_on_idle: false, cooldown_seconds: 120 },
    custom_rules: [],
    file_rules: [],
    parallel: true,
  }),
}));
```

## Locked decisions (do NOT deviate)

These resolve the ambiguities a cold executor would otherwise face:

1. **Approach: reset `lastAutoReviewTime = 0` in the catch path** — NOT "move the stamp to after success". Reasons:
   - It is a single additive line; the success-path timing is unchanged (cooldown still starts at dispatch, matching current documented behavior).
   - Moving the stamp after the `await` would shift the cooldown window to start at prompt *completion*, a silent behavioral change for the success path. Avoid it.
2. **Keep the existing `console.error` log** — do not remove observability.
3. **Do NOT redesign the closure-based state model.** The fix is local to the catch block.
4. **Do NOT add retry/backoff.** Scope is only "a failed prompt should not consume the cooldown." Broader retry policy is explicitly out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test -- src/index.test.ts` | exit 0; all pass |

## Scope

**In scope**:
- `src/index.ts` (the catch block at line 135-137 only)
- `src/index.test.ts` (add a focused idle-event failure test)

**Out of scope**:
- `src/tools/*`, `src/prompts/*` — no prompt or tool changes.
- Any new retry/backoff policy, jitter, or max-retry count.
- Changes to `loadConfig` or config shapes.

## Git workflow

- Use the current branch; no branch-naming convention is evident in this repo.
- Do not commit, push, or open a PR.

## Steps

### Step 1: Write the failing test FIRST

Add a new `describe` block at the end of `src/index.test.ts`. The test needs three things the current file does not yet show: (a) override the module-level mock so `auto_on_idle` is true, (b) invoke the idle event handler directly, (c) pass the exact event payload shape the handler reads.

First, add these imports at the top of the file (extend the existing `vi` import line):
```typescript
import { vi, describe, it, expect } from "vitest";
```
Then reference the mocked `loadConfig` so it can be overridden per-test:
```typescript
const { loadConfig } = await import("./config.ts");
```

Then append this test block. **The event payload shape is load-bearing** — the handler reads `event.type`, and `src/index.ts:118-119` reads `sessionID` from `properties.sessionID ?? properties.id ?? id`. Pass all three so there is no early return:

```typescript
describe("session.idle failure retry", () => {
  it("a failed promptAsync does not consume the cooldown (next idle retries)", async () => {
    // Override the module-level mock so auto-review is ENABLED.
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 500,
      trigger: { auto_on_idle: true, cooldown_seconds: 120 },
      custom_rules: [],
      file_rules: [],
      parallel: true,
    });

    // Fresh context: promptAsync rejects once, then resolves.
    const promptAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({});
    const ctx = {
      project: "",
      client: { session: { promptAsync } },
      $: vi.fn(),
      directory: "/fake",
      worktree: "",
      experimental_workspace: "",
      serverUrl: "",
    } as unknown as Parameters<typeof opencodeReview>[0];

    vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = await opencodeReview(ctx);

    const idleEvent = {
      event: {
        type: "session.idle",
        properties: { sessionID: "sess-1" },
        id: "sess-1",
      },
    };

    // First idle: promptAsync rejects. Cooldown must NOT be consumed.
    await plugin.event?.(idleEvent as any);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    // Second idle, same session: must still reach promptAsync (retry),
    // not be blocked by the cooldown from the failed first attempt.
    await plugin.event?.(idleEvent as any);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });
});
```

**Verify**: `pnpm test -- src/index.test.ts` → the new test FAILS at the second `expect(promptAsync).toHaveBeenCalledTimes(2)` because the failed first prompt consumed the cooldown (so the second idle returned early at `src/index.ts:113-114`). If the test fails for a *different* reason (e.g. the handler was not reached at all), STOP and report — the event shape or mock may have drifted.

### Step 2: Reset the cooldown in the catch path

In `src/index.ts:135-137`, add a single line inside the existing `catch` block:

```typescript
        } catch (e) {
          console.error("[auto-review] promptAsync failed:", e);
          // A failed prompt should not consume the cooldown — let the next
          // idle event retry instead of suppressing it for the full window.
          lastAutoReviewTime = 0;
        }
```

Do NOT move the `lastAutoReviewTime = now` line at 115. Do NOT touch the success path.

**Verify**: `pnpm test -- src/index.test.ts` → the new test now PASSES, and all existing smoke tests still pass.

### Step 3: Typecheck

**Verify**: `pnpm typecheck` → exit 0.

## Test plan

- `src/index.test.ts`
  - (new) `session.idle failure retry` — a rejected `promptAsync` does not consume the cooldown; the next idle event retries and reaches `promptAsync` again. Asserts `toHaveBeenCalledTimes(2)`.
  - (unchanged) existing `plugin smoke test` cases keep passing.

Verification: `pnpm test -- src/index.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test -- src/index.test.ts` exits 0 with the new failure-retry test passing
- [ ] `grep -n "lastAutoReviewTime = 0" src/index.ts` returns exactly one match, inside the catch block
- [ ] `grep -n "lastAutoReviewTime = now" src/index.ts` still returns the one success-path stamp (unchanged)
- [ ] `git status --short` shows only `src/index.ts`, `src/index.test.ts`, and `plans/*` changes
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live code at `src/index.ts:110-139` no longer matches the excerpt in "Current state".
- The Step 1 test fails for a reason OTHER than the cooldown-consumption bug (e.g. the event handler is never reached — this means the event payload shape or the `auto_on_idle` override is wrong, and you must not guess at a new shape).
- `plugin.event` is `undefined` (the plugin contract changed — the test cannot reach the handler).
- The change would require touching `src/tools/*`, `src/prompts/*`, or `src/config.ts`.
- A verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- If the auto-review flow later gains explicit retry/backoff with a max-attempt count, revisit this — the `= 0` reset should then feed into the retry counter rather than unconditionally clearing.
- Reviewers: confirm that a *successful* prompt still respects the cooldown (the success path is untouched; the reset is catch-only).
- Keep the event handler small and local. Do not lift `lastAutoReviewTime` into config or a shared store as part of this fix.
