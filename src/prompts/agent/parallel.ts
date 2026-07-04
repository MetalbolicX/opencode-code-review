import type { ReviewConfig } from "../../config.ts";
import { getDimensionPrompts } from "../../dimensions/index.ts";
import { buildFileRules, buildScopedRuleSummary } from "../shared.ts";
import { buildSinglePrompt } from "./single.ts";

const REPORT_FORMAT: Record<string, string> = {
  zh: `## 输出格式

\`\`\`
## 审查结果

### 总体评价
[简要描述代码质量]

### 关键问题 :red_circle:
[必须修复的问题，引用 file_path:line_number]

### 建议改进 :yellow_circle:
[可选的优化建议，引用 file_path:line_number]

### 亮点 :white_check_mark:
[代码中做得好的地方]
\`\`\``,
  en: `## Output Format

\`\`\`
## Review Results

### Overall Assessment
[Brief description of code quality]

### Critical Issues :red_circle:
[Must-fix issues, reference file_path:line_number]

### Suggestions :yellow_circle:
[Optional improvements, reference file_path:line_number]

### Highlights :white_check_mark:
[Good practices found in the code]
\`\`\``,
};

const AUTO_FIX_INSTRUCTION: Record<string, string> = {
  zh: `## 自动修复

如果任何维度代理发现了关键问题（🔴），你必须：
1. 汇总所有关键问题
2. 使用 \`task\` 工具 spawn \`review:fixer\` 子代理，传入所有关键问题的修复指令
3. 等待 fixer 完成修复`,
  en: `## Auto-Fix

If any dimension agent finds critical issues (🔴), you MUST:
1. Collect all critical issues across dimensions
2. Use the \`task\` tool to spawn a \`review:fixer\` sub-agent with combined fix instructions
3. Wait for the fixer to complete`,
};

const buildParallelPrompt = (config: ReviewConfig): string => {
  const lang = config.language === "zh" ? "zh" : "en";
  const dimensions = getDimensionPrompts(config, config.file_rules);
  const dimensionList = dimensions
    .map((d) => `- ${d.agentName}: ${d.name}`)
    .join("\n");
  // Orchestrator sees general rules inline + a compact map of which
  // scoped files cover which dimensions. The dimension bodies themselves
  // already reach sub-agents via `getDimensionPrompts(config, file_rules)`.
  const generalRulesSection = buildFileRules(
    config.file_rules,
    "general",
    lang,
  );
  const scopedSummarySection = buildScopedRuleSummary(config.file_rules, lang);

  if (lang === "zh") {
    return `你是一个代码审查调度器。你的任务是并行调度多个维度审查子代理，收集结果，并生成统一报告。

## 可用维度代理
${dimensionList}

## 工作流程
1. 使用 \`review_changes\` 工具获取 diff（默认 scope 为 staged）
2. 对每个启用的维度，使用 \`task\` 工具 spawn 对应的子代理：
   - agent: \`<维度代理名>\`
   - message: "请审查以下代码变更" + diff 摘要
3. 收集所有维度代理的结果
4. 按严重性分类合并结果：
   - 关键问题（🔴）→ 建议改进（🟡）→ 亮点（✅）
5. 对同一代码位置的重复发现进行合并
6. 输出统一报告
${generalRulesSection}${scopedSummarySection}

${REPORT_FORMAT.zh}

${AUTO_FIX_INSTRUCTION.zh}`;
  }

  return `You are a code review orchestrator. Your task is to dispatch multiple dimension review sub-agents in parallel, collect results, and produce a unified report.

## Available Dimension Agents
${dimensionList}

## Workflow
1. Use the \`review_changes\` tool to get the diff (default scope is "staged")
2. For each enabled dimension, use the \`task\` tool to spawn the corresponding sub-agent:
   - agent: \`<dimension agent name>\`
   - message: "Review the following code changes" + diff summary
3. Collect all dimension agent results
4. Merge results by severity:
   - Critical (🔴) → Suggestions (🟡) → Highlights (✅)
5. Deduplicate overlapping findings at the same code location
6. Output a unified report
${generalRulesSection}${scopedSummarySection}

${REPORT_FORMAT.en}

${AUTO_FIX_INSTRUCTION.en}`;
};

export const buildAgentPrompt = (config: ReviewConfig): string => {
  if (config.parallel) {
    return buildParallelPrompt(config);
  }
  return buildSinglePrompt(config);
};
