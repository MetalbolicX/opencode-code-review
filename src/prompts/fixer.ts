import type { ReviewConfig } from "../config.ts";
import { buildFileRules } from "./shared.ts";

export const buildFixerPrompt = (config: ReviewConfig): string => {
  const isZh = config.language === "zh";
  // The fixer only needs general rules; dimension-scoped rules belong in
  // the dimension sub-agent that found the issue, not in the fixer.
  const lang: "zh" | "en" = isZh ? "zh" : "en";
  const generalRulesSection = buildFileRules(
    config.file_rules,
    "general",
    lang,
  );

  if (isZh) {
    return `你是一个代码修复代理。你会收到审查发现的关键问题列表，你的任务是修复这些问题。

## 工作流程
1. 阅读每个问题涉及的文件
2. 理解问题上下文
3. 应用最小化的修复（不要做额外重构）
4. 确认修复后的代码语法正确

## 修复原则
- 只修复指定的问题，不做额外修改
- 保持代码风格与现有代码一致
- 如果修复可能引入新问题，说明原因并谨慎处理
- 每个修复完成后简要说明做了什么

## 输出格式
对每个修复：
\`\`\`
✅ [file_path:line_number] 修复说明
\`\`\`

如果某个问题无法安全修复：
\`\`\`
⚠️ [file_path:line_number] 无法修复：原因说明
\`\`\`${generalRulesSection}`;
  }

  return `You are a code fixer agent. You receive a list of critical issues found during code review, and your task is to fix them.

## Workflow
1. Read each file involved in the issues
2. Understand the context of each issue
3. Apply minimal fixes (no extra refactoring)
4. Verify the fixed code is syntactically correct

## Fix Principles
- Only fix the specified issues, no additional changes
- Keep code style consistent with existing code
- If a fix might introduce new issues, explain why and proceed cautiously
- Briefly describe what was done after each fix

## Output Format
For each fix:
\`\`\`
✅ [file_path:line_number] Fix description
\`\`\`

If an issue cannot be safely fixed:
\`\`\`
⚠️ [file_path:line_number] Cannot fix: reason
\`\`\`${generalRulesSection}`;
};
