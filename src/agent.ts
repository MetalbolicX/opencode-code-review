import type { ReviewConfig } from "./config.ts"

const DIMENSION_LABELS: Record<string, { zh: string; en: string }> = {
  "code-quality": {
    zh: "代码质量（可读性、命名、结构、规范）",
    en: "Code quality (readability, naming, structure, conventions)",
  },
  security: {
    zh: "安全性（输入验证、注入防护、敏感信息、认证授权）",
    en: "Security (input validation, injection prevention, auth)",
  },
  performance: {
    zh: "性能（算法复杂度、查询优化、内存使用）",
    en: "Performance (algorithm complexity, query optimization, memory)",
  },
  testing: {
    zh: "测试（单元测试覆盖、边界条件、集成测试）",
    en: "Testing (unit coverage, edge cases, integration tests)",
  },
  documentation: {
    zh: "文档（注释、API 文档、README/CHANGELOG）",
    en: "Documentation (comments, API docs, README/CHANGELOG)",
  },
}

function buildDimensionList(config: ReviewConfig): string {
  const lang = config.language === "zh" ? "zh" : "en"
  return config.dimensions
    .map((d) => {
      const label = DIMENSION_LABELS[d]?.[lang] ?? d
      return `- ${label}`
    })
    .join("\n")
}

function buildCustomRules(rules: string[]): string {
  if (rules.length === 0) return ""
  return `\n### Custom Rules\n${rules.map((r) => `- ${r}`).join("\n")}`
}

export function buildAgentPrompt(config: ReviewConfig): string {
  const isZh = config.language === "zh"

  if (isZh) {
    return `你是一个专业的代码审查员。请使用 \`review_changes\` 工具获取代码变更，然后进行审查。

## 审查维度
${buildDimensionList(config)}
${buildCustomRules(config.custom_rules)}

## 工作流程
1. 调用 \`review_changes\` 工具获取 diff（默认 scope 为 staged）
2. 使用 \`read\` 阅读相关文件获取上下文
3. 使用 \`grep\` 或 \`glob\` 搜索相关代码
4. 分析变更的影响范围

## 输出格式

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
\`\`\`

引用具体代码时，使用格式 \`file_path:line_number\`。
如果 diff 为空或没有变更，直接告知用户。`
  }

  return `You are a professional code reviewer. Use the \`review_changes\` tool to get code changes, then review them.

## Review Dimensions
${buildDimensionList(config)}
${buildCustomRules(config.custom_rules)}

## Workflow
1. Call \`review_changes\` tool to get the diff (default scope is "staged")
2. Use \`read\` to read related files for context
3. Use \`grep\` or \`glob\` to search related code
4. Analyze the impact of changes

## Output Format

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
\`\`\`

Reference specific code using \`file_path:line_number\` format.
If diff is empty or no changes found, inform the user directly.`
}
