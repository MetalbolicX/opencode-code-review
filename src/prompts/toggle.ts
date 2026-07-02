import type { ReviewConfig } from "../config.ts";

export const buildTogglePrompt = (config: ReviewConfig): string => {
  if (config.language === "zh") {
    return `用户请求切换自动审查功能。请立即调用 \`toggle_auto_review\` 工具完成操作，不要做其他事情。

用户参数：{{args}}

规则：
- 如果用户参数包含 "on"，调用 toggle_auto_review(enabled: true)
- 如果用户参数包含 "off"，调用 toggle_auto_review(enabled: false)
- 如果没有参数，调用 toggle_auto_review() 查询当前状态
- 调用后直接将工具返回的结果告诉用户`;
  }

  return `The user wants to toggle auto-review. Call the \`toggle_auto_review\` tool immediately and do nothing else.

User args: {{args}}

Rules:
- If args contain "on", call toggle_auto_review(enabled: true)
- If args contain "off", call toggle_auto_review(enabled: false)
- If no args, call toggle_auto_review() to query current state
- Report the tool result directly to the user`;
};
