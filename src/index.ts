import type { Plugin } from "@opencode-ai/plugin";
import { loadConfig } from "./config.ts";
import {
  buildAgentPrompt,
  buildFixerPrompt,
  buildTogglePrompt,
} from "./prompts/index.ts";
import { getDimensionPrompts } from "./dimensions/index.ts";
import {
  createReviewChangesTool,
  createToggleAutoReviewTool,
} from "./tools/index.ts";

interface SessionIdleEvent {
  type: string;
  properties?: { sessionID?: string; id?: string };
  id?: string;
}

/**
 * Extract session ID from a session.idle event.
 * Priority: properties.sessionID > properties.id > top-level id
 * Returns undefined if no ID is present.
 */
export const extractSessionId = (
  event: SessionIdleEvent,
): string | undefined => {
  return event.properties?.sessionID ?? event.properties?.id ?? event.id;
};

const opencodeReview: Plugin = async ({
  project: _project,
  client,
  $: _$,
  directory,
  worktree: _worktree,
}) => {
  const config = await loadConfig(directory);
  const agentPrompt = buildAgentPrompt(config);
  const fixerPrompt = buildFixerPrompt(config);
  const dimensionPrompts = getDimensionPrompts(
    config,
    config.file_rules,
    config.custom_rules,
  );

  let autoEnabled = config.trigger.auto_on_idle;
  let lastAutoReviewTime = 0;

  return {
    async config(openCodeConfig) {
      openCodeConfig.agent ??= {};

      openCodeConfig.agent["ocr-review"] = {
        mode: "primary",
        temperature: 0.1,
        steps: 30,
        color: "accent",
        tools: {
          write: false,
          edit: false,
          bash: false,
          task: true,
        },
        permission: {
          bash: {
            "git diff*": "allow",
            "git log*": "allow",
            "git show*": "allow",
          },
        },
      };

      openCodeConfig.agent["ocr-review:fixer"] = {
        mode: "subagent",
        temperature: 0.2,
        steps: 20,
        tools: {
          write: true,
          edit: true,
          bash: true,
          read: true,
          grep: true,
          glob: true,
        },
        prompt: fixerPrompt,
      };

      if (config.parallel) {
        for (const dim of dimensionPrompts) {
          openCodeConfig.agent[dim.agentName] = {
            mode: "subagent",
            temperature: 0.1,
            steps: 30,
            tools: {
              write: false,
              edit: false,
              bash: false,
              task: false,
            },
            prompt: dim.prompt,
          };
        }
      }

      openCodeConfig.command ??= {};
      openCodeConfig.command["ocr-review"] = {
        agent: "ocr-review",
        description: "Review code changes with structured feedback",
        template: agentPrompt,
      };

      openCodeConfig.command["ocr-review:auto"] = {
        agent: "ocr-review",
        description:
          config.language === "zh"
            ? "切换自动审查开关（on/off）"
            : "Toggle auto-review on/off",
        template: buildTogglePrompt(config),
      };
    },

    tool: {
      review_changes: createReviewChangesTool(config.max_diff_lines),
      toggle_auto_review: createToggleAutoReviewTool(
        () => autoEnabled,
        (v) => {
          autoEnabled = v;
        },
      ),
    },

    event: async ({ event }) => {
      if (event.type === "session.idle" && autoEnabled) {
        const now = Date.now();
        if (now - lastAutoReviewTime < config.trigger.cooldown_seconds * 1000)
          return;

        const ev = event as unknown as SessionIdleEvent;
        const sessionID = extractSessionId(ev);
        if (!sessionID) return;
        lastAutoReviewTime = now;

        try {
          await client.session.promptAsync({
            body: {
            agent: "ocr-review",
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
          lastAutoReviewTime = 0;
        }
      }
    },
  };
};

export default opencodeReview;
