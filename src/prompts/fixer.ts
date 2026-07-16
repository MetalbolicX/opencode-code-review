import type { ReviewConfig } from "../config.ts";
import { buildFileRules, formatTagListSlash } from "./shared.ts";

// The five allowed simplification tags live in shared.ts so the dimension
// body, the orchestrator prompts, this exclusion clause, and tests reference
// the same canonical list. Auto-fix safety is a defense-in-depth rule: any
// tag emitted by `code-quality` MUST be excluded here.
const SIMPLIFICATION_EXCLUSION: Record<string, string> = {
  zh: `## 精简类自动修复保护（防御性边界）

不要自动修复任何使用 \`[tag]\` 前缀归类的精简类发现。即使上游审查将精简类问题转交给 fixer，你也必须将其排除在自动修复之外。

适用标签：${formatTagListSlash()}

精简类发现涉及架构与代码品味判断，修复它们可能改变行为、削弱校验或语义；必须由人工在审查中决策。`,
  en: `## Simplification auto-fix protection (defense-in-depth)

Do NOT auto-fix any finding classified as a simplification via a \`[tag]\` prefix (${formatTagListSlash()}). Even if an upstream review forwards a simplification finding to the fixer, you must never auto-fix it — these exclusions take priority over any other auto-fix rule.

These five tags require human judgment — auto-fixing them risks changing behavior, weakening validation, or shifting semantics.`,
};

// Thermo exclusion: only active when profile is "thermo-nuclear"
const THERMO_EXCLUSION: Record<string, string> = {
  zh: `## 热核类自动修复保护（防御性边界）

不要自动修复任何标记为 \`[thermo]\` 的发现。即使上游审查将热核类问题转交给 fixer，你也必须将其排除在自动修复之外。

热核类发现涉及架构与代码品味判断，修复它们可能改变行为、削弱校验或语义；必须由人工在审查中决策。`,
  en: `## Thermo auto-fix protection (defense-in-depth)

Do NOT auto-fix any finding tagged \`[thermo]\`. Even if an upstream review forwards a thermo finding to the fixer, you must never auto-fix it — these exclusions take priority over any other auto-fix rule.

Thermo findings require human judgment — auto-fixing them risks changing behavior, weakening validation, or shifting semantics.`,
};

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
  const exclusionSection = SIMPLIFICATION_EXCLUSION[lang];
  const thermoExclusionSection =
    config.profile === "thermo-nuclear" ? THERMO_EXCLUSION[lang] : "";
  const exclusionInline = formatTagListSlash();

  if (isZh) {
    const thermoOutputFormat = thermoExclusionSection
      ? `

如果问题属于热核类发现（标记为 [thermo]），输出：

\`\`\`
⚠️ [file_path:line_number] 热核类发现，不自动修复：原因说明
\`\`\``
      : "";

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

${exclusionSection}
${thermoExclusionSection}

## 输出格式
对每个修复：

\`\`\`
✅ [file_path:line_number] 修复说明
\`\`\`

如果某个问题无法安全修复：

\`\`\`
⚠️ [file_path:line_number] 无法修复：原因说明
\`\`\`

如果问题属于精简类发现（标签见上文 ${exclusionInline}），输出：

\`\`\`
⚠️ [file_path:line_number] 精简类发现，不自动修复：原因说明
\`\`\`${thermoOutputFormat}
${generalRulesSection}`;
  }

  const thermoOutputFormat = thermoExclusionSection
    ? `

If the issue is a thermo finding (tagged [thermo]), output:

\`\`\`
⚠️ [file_path:line_number] Thermo finding, do not auto-fix: reason
\`\`\``
    : "";

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

${exclusionSection}
${thermoExclusionSection}

## Output Format
For each fix:

\`\`\`
✅ [file_path:line_number] Fix description
\`\`\`

If an issue cannot be safely fixed:

\`\`\`
⚠️ [file_path:line_number] Cannot fix: reason
\`\`\`

If the issue is a simplification finding (tags: ${exclusionInline}), output:

\`\`\`
⚠️ [file_path:line_number] Simplification finding, do not auto-fix: reason
\`\`\`${thermoOutputFormat}
${generalRulesSection}`;
};
