import { tool } from "@opencode-ai/plugin";
import type { ToolContext, ToolDefinition } from "@opencode-ai/plugin";

type CommandResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

type ShellCall = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => ShellPromise;

type ShellPromise = Promise<CommandResult> & {
  quiet: () => ShellPromise;
};

interface ShellRunner extends ShellCall {
  quiet: () => ShellRunner;
}

interface ToolContextWithShell extends ToolContext {
  $: ShellRunner;
}

const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9._/-]+$/;

/**
 * Create the `review_changes` tool bound to a configured `maxDiffLines` default.
 *
 * The factory mirrors the `createToggleAutoReviewTool` seam so that
 * `loadConfig()` can hand its `max_diff_lines` value into the registered tool
 * without widening the tool's runtime dependencies. The explicit
 * `args.max_lines` argument still overrides the bound default when the caller
 * passes one — preserving the tool contract while making config-driven
 * truncation work end-to-end.
 */
export const createReviewChangesTool = (maxDiffLines: number): ToolDefinition =>
  tool({
    description:
      "Gather git diff for code review. Returns file list, change stats, and diff content.",
    args: {
      scope: tool.schema
        .enum(["staged", "last-commit", "branch"])
        .describe(
          "Review scope: 'staged' for git staged changes, 'last-commit' for the most recent commit, 'branch' for all changes on the current branch vs default branch",
        ),
      max_lines: tool.schema
        .number()
        .optional()
        .describe("Maximum diff lines to return (default from config)"),
    },
    async execute(args, context) {
      const ctx = context as unknown as ToolContextWithShell;
      const $ = ctx.$;
      const { directory: _directory } = context;
      const scope = args.scope ?? "branch";
      // Explicit `max_lines` always wins over the configured default. The
      // truncation warning below uses this same `maxLines` so it reports
      // whichever limit was actually applied (config or caller override).
      const maxLines = args.max_lines ?? maxDiffLines;

      let diffResult: CommandResult;
      let statsResult: CommandResult;

      switch (scope) {
        case "staged":
          diffResult = await runCommand(() => $`git diff --cached`.quiet());
          statsResult = await runCommand(() =>
            $`git diff --cached --stat`.quiet(),
          );
          break;
        case "last-commit":
          diffResult = await runCommand(() =>
            $`git show --format='' HEAD`.quiet(),
          );
          statsResult = await runCommand(() =>
            $`git show --format='' --stat HEAD`.quiet(),
          );
          break;
        case "branch": {
          const defaultBranchResult = await getDefaultBranch($);
          if ("error" in defaultBranchResult) {
            return `[Error] ${defaultBranchResult.error}`;
          }
          const defaultBranch = defaultBranchResult.branch;
          if (!SAFE_BRANCH_REGEX.test(defaultBranch)) {
            return `[Error] Unsafe default branch name: "${defaultBranch}"`;
          }
          const range = `${defaultBranch}...HEAD`;
          diffResult = await runCommand(() => $`git diff ${range}`.quiet());
          statsResult = await runCommand(() =>
            $`git diff ${range} --stat`.quiet(),
          );
          break;
        }
      }

      if (!diffResult.ok) {
        return `[Error] Git diff failed for scope "${scope}": ${diffResult.error}`;
      }
      if (!statsResult.ok) {
        return `[Error] Git diff --stat failed for scope "${scope}": ${statsResult.error}`;
      }

      let diff = diffResult.stdout;
      const stats = statsResult.stdout;

      const truncated = diff.split("\n").length > maxLines;
      if (truncated) {
        diff = diff.split("\n").slice(0, maxLines).join("\n");
      }

      if (!diff.trim()) {
        return "No changes found for the selected scope.";
      }

      let output = `## Change Stats\n${stats}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\``;
      if (truncated) {
        output += `\n\n⚠️ Diff truncated at ${maxLines} lines. Use a smaller scope or increase max_lines for full review.`;
      }

      return output;
    },
  });

const runCommand = async (
  execute: () => ShellPromise,
): Promise<CommandResult> => {
  try {
    const result = await execute();
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, stdout: result.stdout };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
};

const getDefaultBranch = async (
  $: ShellRunner,
): Promise<{ branch: string } | { error: string }> => {
  try {
    const result = await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet();
    if (!result.ok) {
      return {
        error: `Could not determine default branch: ${result.error}`,
      };
    }
    const raw = result.stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (raw.startsWith(prefix)) {
      return { branch: raw.slice(prefix.length) };
    }
    if (raw.startsWith("refs/heads/")) {
      return { branch: raw.slice("refs/heads/".length) };
    }
    if (!raw) {
      return { error: "Could not determine default branch: empty response" };
    }
    return { branch: raw };
  } catch (e) {
    return {
      error: `Could not determine default branch: ${(e as Error).message}`,
    };
  }
};
