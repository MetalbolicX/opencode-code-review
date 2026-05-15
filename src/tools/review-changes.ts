import { tool } from "@opencode-ai/plugin"

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

    let diffCmd: string
    let statsCmd: string

    switch (scope) {
      case "staged":
        diffCmd = "git diff --cached"
        statsCmd = "git diff --cached --stat"
        break
      case "last-commit":
        diffCmd = "git show --format='' HEAD"
        statsCmd = "git show --format='' --stat HEAD"
        break
      case "branch": {
        const defaultBranch = await getDefaultBranch($, directory)
        diffCmd = `git diff ${defaultBranch}...HEAD`
        statsCmd = `git diff ${defaultBranch}...HEAD --stat`
        break
      }
    }

    const maxLines = args.max_lines ?? 500

    try {
      const [diffResult, statsResult] = await Promise.all([
        $`${diffCmd}`.quiet(),
        $`${statsCmd}`.quiet(),
      ])

      let diff = diffResult.stdout ?? ""
      const stats = statsResult.stdout ?? ""

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
    } catch (err: any) {
      return `Error gathering diff: ${err.message ?? err}`
    }
  },
})

async function getDefaultBranch($: any, _directory: string): Promise<string> {
  try {
    const result = await $`git remote show origin`.quiet()
    const match = (result.stdout ?? "").match(/HEAD branch: (.+)/)
    if (match) return match[1]
  } catch {
    // fallback
  }
  return "main"
}
