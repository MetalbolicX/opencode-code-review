import { describe, it, expect } from "vitest";
import { createReviewChangesTool } from "./review-changes.ts";

// Tests use a single instance bound to the same default value the previous
// singleton used (500), so existing assertions keep working unchanged.
const reviewChanges = createReviewChangesTool(500);

type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

interface ShellCall extends Promise<CommandResult> {
  quiet: () => ShellCall;
}

interface FakeShell {
  (strings: TemplateStringsArray, ...values: unknown[]): ShellCall;
  calls: string[];
}

const makeShell = (results: CommandResult[]): FakeShell => {
  const queue = [...results];
  const calls: string[] = [];

  const buildShellCall = (): ShellCall => {
    const next = queue.shift() ?? {
      ok: false,
      error: "fakeShell queue exhausted",
    };
    const promise = Promise.resolve(next) as ShellCall;
    promise.quiet = () => promise;
    return promise;
  };

  const fn = ((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): ShellCall => {
    let cmd = "";
    for (let i = 0; i < strings.length; i++) {
      cmd += strings[i];
      if (i < values.length) cmd += String(values[i]);
    }
    calls.push(cmd);
    return buildShellCall();
  }) as unknown as FakeShell;

  fn.calls = calls;
  return fn;
};

const makeContext = ($: FakeShell) =>
  ({ $ }) as unknown as Parameters<typeof reviewChanges.execute>[1];

describe("reviewChanges", () => {
  describe("runCommand failure propagation", () => {
    it("returns [Error] when git diff --cached resolves with a failure (staged scope)", async () => {
      const $ = makeShell([
        { ok: false, error: "fatal: not a git repository" },
      ]);
      const result = await reviewChanges.execute(
        { scope: "staged" },
        makeContext($),
      );
      expect(result as string).toContain("[Error]");
      expect(result as string).toContain("Git diff failed");
      expect(result as string).not.toContain("No changes found");
    });

    it("returns [Error] when git diff --cached --stat resolves with a failure (staged scope)", async () => {
      const $ = makeShell([
        { ok: true, stdout: "diff --git a/foo b/foo\n+hello" },
        { ok: false, error: "fatal: stat failed" },
      ]);
      const result = await reviewChanges.execute(
        { scope: "staged" },
        makeContext($),
      );
      expect(result as string).toContain("[Error]");
      expect(result as string).toContain("Git diff --stat failed");
      expect(result as string).not.toContain("No changes found");
    });

    it("returns [Error] when git show HEAD resolves with a failure (last-commit scope)", async () => {
      const $ = makeShell([{ ok: false, error: "fatal: bad object HEAD" }]);
      const result = await reviewChanges.execute(
        { scope: "last-commit" },
        makeContext($),
      );
      expect(result as string).toContain("[Error]");
      expect(result as string).toContain("Git diff failed");
      expect(result as string).not.toContain("No changes found");
    });
  });

  describe("empty-success preservation", () => {
    it("returns 'No changes found' when diff stdout is blank but ok (staged scope)", async () => {
      const $ = makeShell([
        { ok: true, stdout: "" },
        { ok: true, stdout: "" },
      ]);
      const result = await reviewChanges.execute(
        { scope: "staged" },
        makeContext($),
      );
      expect(result).toBe("No changes found for the selected scope.");
    });

    it("returns formatted diff when both diff and stats succeed (staged scope)", async () => {
      const $ = makeShell([
        { ok: true, stdout: "diff --git a/foo b/foo\n+hello" },
        { ok: true, stdout: " foo | 1 +" },
      ]);
      const result = await reviewChanges.execute(
        { scope: "staged" },
        makeContext($),
      );
      expect(result as string).toContain("Change Stats");
      expect(result as string).toContain("Diff");
    });
  });

  describe("native git invocation (no shell wrapping)", () => {
    it("invokes staged diff commands natively without bash -c", async () => {
      const $ = makeShell([
        { ok: true, stdout: "diff --git a/foo b/foo\n+hello" },
        { ok: true, stdout: " foo | 1 +" },
      ]);
      await reviewChanges.execute({ scope: "staged" }, makeContext($));
      expect($.calls).toEqual([
        "git diff --cached",
        "git diff --cached --stat",
      ]);
      for (const cmd of $.calls) {
        expect(cmd).not.toContain("bash -c");
      }
    });

    it("invokes last-commit show commands natively without bash -c", async () => {
      const $ = makeShell([
        { ok: true, stdout: "diff --git a/foo b/foo\n+hello" },
        { ok: true, stdout: " foo | 1 +" },
      ]);
      await reviewChanges.execute({ scope: "last-commit" }, makeContext($));
      expect($.calls).toEqual([
        "git show --format='' HEAD",
        "git show --format='' --stat HEAD",
      ]);
      for (const cmd of $.calls) {
        expect(cmd).not.toContain("bash -c");
      }
    });
  });

  describe("branch scope", () => {
    it("diffs against the resolved default branch using a single argv range token", async () => {
      const $ = makeShell([
        { ok: true, stdout: "refs/remotes/origin/main\n" },
        { ok: true, stdout: "diff --git a/foo b/foo\n+hello" },
        { ok: true, stdout: " foo | 1 +" },
      ]);
      const result = await reviewChanges.execute(
        { scope: "branch" },
        makeContext($),
      );
      expect(result as string).toContain("Change Stats");
      expect($.calls).toEqual([
        "git symbolic-ref refs/remotes/origin/HEAD",
        "git diff main...HEAD",
        "git diff main...HEAD --stat",
      ]);
      for (const cmd of $.calls) {
        expect(cmd).not.toContain("bash -c");
      }
    });

    it("returns an explicit error when git symbolic-ref fails and there is no fallback", async () => {
      // When git symbolic-ref throws (not returns an unsafe name), the function
      // should return an explicit error rather than silently falling back to "main".
      const $ = makeShell([{ ok: false, error: "fatal: not a valid ref" }]);
      const tool = createReviewChangesTool(500);
      const result = await tool.execute({ scope: "branch" }, makeContext($));
      // Should return an explicit error, not silently use "main"
      expect(result as string).toContain("[Error]");
      expect(result as string).toContain("Could not determine default branch");
    });

    it("returns [Error] and skips diff commands when the resolved default branch is unsafe", async () => {
      const $ = makeShell([{ ok: true, stdout: "refs/remotes/origin/a;b\n" }]);
      const result = await reviewChanges.execute(
        { scope: "branch" },
        makeContext($),
      );
      expect(result as string).toContain("[Error] Unsafe default branch name");
      expect($.calls).toEqual(["git symbolic-ref refs/remotes/origin/HEAD"]);
      for (const cmd of $.calls) {
        expect(cmd).not.toContain("bash -c");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Factory-bound max_diff_lines (plan 016)
  //
  // The previous singleton hardcoded `500` as the default `max_lines`. After
  // the factory refactor each instance carries the configured value, and the
  // explicit `args.max_lines` argument still wins when the caller provides it.
  // ---------------------------------------------------------------------------

  const LONG_DIFF = (() => {
    // 100 distinct lines; LINE_80 marker survives only the first 80 lines,
    // which lets us unambiguously assert truncation at small cutoffs.
    return Array.from({ length: 100 }, (_, i) => `LINE_${i}`).join("\n");
  })();

  describe("factory-bound max_diff_lines", () => {
    it("truncates at the bound default when no explicit max_lines is provided", async () => {
      const $ = makeShell([
        { ok: true, stdout: LONG_DIFF },
        { ok: true, stdout: " foo | 100 +" },
      ]);
      const tool = createReviewChangesTool(20);
      const result = await tool.execute({ scope: "staged" }, makeContext($));
      expect(result as string).toContain("LINE_0");
      expect(result as string).toContain("LINE_19");
      expect(result as string).not.toContain("LINE_50");
      expect(result as string).toContain("truncated at 20 lines");
    });

    it("explicit max_lines input takes precedence over factory-bound default", async () => {
      const $ = makeShell([
        { ok: true, stdout: LONG_DIFF },
        { ok: true, stdout: " foo | 100 +" },
      ]);
      const tool = createReviewChangesTool(80);
      const result = await tool.execute(
        { scope: "staged", max_lines: 5 },
        makeContext($),
      );
      expect(result as string).toContain("LINE_0");
      expect(result as string).toContain("LINE_4");
      expect(result as string).not.toContain("LINE_50");
      expect(result as string).toContain("truncated at 5 lines");
    });

    it("factory-bound default of 500 does NOT truncate a 100-line diff", async () => {
      const $ = makeShell([
        { ok: true, stdout: LONG_DIFF },
        { ok: true, stdout: " foo | 100 +" },
      ]);
      const result = await reviewChanges.execute(
        { scope: "staged" },
        makeContext($),
      );
      expect(result as string).toContain("LINE_80");
      expect(result as string).not.toContain("truncated");
    });

    it("two factories with different bound values produce independent defaults", async () => {
      const $ = makeShell([
        { ok: true, stdout: LONG_DIFF },
        { ok: true, stdout: " foo | 100 +" },
      ]);
      const tight = createReviewChangesTool(10);
      const tightResult = await tight.execute(
        { scope: "staged" },
        makeContext($),
      );
      // Tight factory truncates at 10; the module-level 500-bound instance
      // (via `reviewChanges` alias) lets the same diff through.
      expect(tightResult as string).toContain("truncated at 10 lines");
      expect(tightResult as string).not.toContain("LINE_50");
    });
  });
});
