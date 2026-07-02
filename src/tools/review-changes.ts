import { tool } from "@opencode-ai/plugin"

type CommandResult = { ok: true; stdout: string } | { ok: false; error: string }

const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9._\/\-]+$/

export const reviewChanges = tool({
  description:
    "Gather git diff for code review. Returns file list, change stats, and diff content.",
  args: {
    scope: tool.schema.enum(["staged", "last-commit", "branch"]).describe(
      "Review scope: 'staged' for git staged changes, 'last-commit' for the most recent commit, 'branch' for all changes on the current branch vs default branch",
    ),
    max_lines: tool.schema.number().optional().describe(
      "Maximum diff lines to return (default from config)",
    ),
  },
  async execute(args, context) {
    const { $, directory } = context
    const scope = args.scope ?? "staged"
    const maxLines = args.max_lines ?? 500

    let diffResult: CommandResult
    let statsResult: CommandResult

    switch (scope) {
      case "staged":
        diffResult = await runCommand($, "git diff --cached")
        statsResult = await runCommand($, "git diff --cached --stat")
        break
      case "last-commit":
        diffResult = await runCommand($, "git show --format='' HEAD")
        statsResult = await runCommand($, "git show --format='' --stat HEAD")
        break
      case "branch": {
        const defaultBranch = await getDefaultBranch($)
        if (!SAFE_BRANCH_REGEX.test(defaultBranch)) {
          return `[Error] Unsafe default branch name: "${defaultBranch}"`
        }
        diffResult = await runCommand($, "git diff " + defaultBranch + "...HEAD")
        statsResult = await runCommand($, "git diff " + defaultBranch + "...HEAD --stat")
        break
      }
    }

    if (!diffResult.ok) {
      return `[Error] Git diff failed for scope "${scope}": ${diffResult.error}`
    }
    if (!statsResult.ok) {
      return `[Error] Git diff --stat failed for scope "${scope}": ${statsResult.error}`
    }

    let diff = diffResult.stdout
    const stats = statsResult.stdout

    const truncated = diff.split("\n").length > maxLines
    if (truncated) {
      diff = diff.split("\n").slice(0, maxLines).join("\n")
    }

    if (!diff.trim()) {
      return "No changes found for the selected scope."
    }

    let output = `## Change Stats\n${stats}\n\n## Diff\n\`\`\`diff\n${diff}\n\`\`\``
    if (truncated) {
      output += `\n\n⚠️ Diff truncated at ${maxLines} lines. Use a smaller scope or increase max_lines for full review.`
    }

    return output
  },
})

async function runCommand($: any, cmd: string): Promise<CommandResult> {
  try {
    const result = await $`bash -c ${cmd}`.quiet()
    const stdout = result.stdout ?? ""
    return { ok: true, stdout }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message }
  }
}

async function getDefaultBranch($: any): Promise<string> {
  try {
    const result = await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet()
    const raw = (result.stdout ?? "").trim()
    const prefix = "refs/remotes/origin/"
    if (raw.startsWith(prefix)) {
      return raw.slice(prefix.length)
    }
    if (raw.startsWith("refs/heads/")) {
      return raw.slice("refs/heads/".length)
    }
    return raw
  } catch {
    // fallback
  }
  return "main"
}
