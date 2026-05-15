import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from "./config.ts"
import { buildAgentPrompt } from "./agent.ts"
import { reviewChanges } from "./tools/index.ts"

const opencodeReview: Plugin = async ({ project, client, $, directory, worktree }) => {
  const config = await loadConfig(directory)
  const agentPrompt = buildAgentPrompt(config)

  return {
    config(openCodeConfig) {
      openCodeConfig.agents ??= {}
      openCodeConfig.agents["review"] = {
        mode: "primary",
        temperature: 0.1,
        steps: 20,
        color: "accent",
        tools: {
          write: false,
          edit: false,
          bash: false,
        },
        permission: {
          bash: {
            "git diff*": "allow",
            "git log*": "allow",
            "git show*": "allow",
          },
        },
      }

      openCodeConfig.commands ??= {}
      openCodeConfig.commands["review"] = {
        agent: "review",
        description: "Review code changes with structured feedback",
        prompt: agentPrompt,
      }
    },

    tool: {
      review_changes: reviewChanges,
    },

    event: async ({ event }) => {
      if (event.type === "session.idle" && config.trigger.auto_on_idle) {
        await client.chat.send({
          message:
            "Session completed. Running automatic code review on staged changes...",
          agent: "review",
        })
      }
    },
  }
}

export default opencodeReview
