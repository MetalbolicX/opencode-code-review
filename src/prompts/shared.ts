import type { ReviewConfig } from "../config.ts";
import type { RuleFile } from "../rule-files.ts";

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
};

const buildDimensionList = (config: ReviewConfig): string => {
  const lang = config.language === "zh" ? "zh" : "en";
  return config.dimensions
    .map((d) => {
      const label = DIMENSION_LABELS[d]?.[lang] ?? d;
      return `- ${label}`;
    })
    .join("\n");
};

const buildCustomRules = (rules: string[]): string => {
  if (rules.length === 0) return "";
  return `\n### Custom Rules\n${rules.map((r) => `- ${r}`).join("\n")}`;
};

// ---------------------------------------------------------------------------
// Markdown rule-document rendering
//
// `buildFileRules(rules, kind, lang)` turns a list of `RuleFile` into a
// markdown section. The `kind` filter narrows which rules reach the caller's
// prompt without leaking scoped bodies into the wrong place:
//
//   "general" → only rules with `dimensions: []` (apply everywhere)
//   "scoped"  → only rules with at least one named dimension
//   "all"     → every rule, in the order received (used by the single
//                agent, which does its own per-dimension reporting)
//
// `buildScopedRuleSummary(rules, lang)` renders a compact bullet list that
// the parallel orchestrator uses to know which markdown rule files cover
// which dimensions — bodies stay with each dimension sub-agent.
// ---------------------------------------------------------------------------

const RULE_SECTION_TITLE: Record<string, string> = {
  zh: "## 附加规则",
  en: "## Review Rules",
};

const SCOPED_SUMMARY_TITLE: Record<string, string> = {
  zh: "## 维度规则概览",
  en: "## Scoped Rules Summary",
};

const basename = (filePath: string): string => {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
};

export type FileRulesKind = "general" | "scoped" | "all";

export const buildFileRules = (
  rules: readonly RuleFile[],
  kind: FileRulesKind,
  lang: "zh" | "en",
): string => {
  const filtered = rules.filter((r) => {
    if (kind === "general") return r.dimensions.length === 0;
    if (kind === "scoped") return r.dimensions.length > 0;
    return true; // "all"
  });
  if (filtered.length === 0) return "";
  const title =
    RULE_SECTION_TITLE[lang] ?? RULE_SECTION_TITLE.en ?? "## Review Rules";
  const bodies = filtered.map((r) => r.body).join("\n\n---\n\n");
  return `\n\n${title}\n\n${bodies}`;
};

export const buildScopedRuleSummary = (
  rules: readonly RuleFile[],
  lang: "zh" | "en",
): string => {
  const scoped = rules.filter((r) => r.dimensions.length > 0);
  if (scoped.length === 0) return "";
  const title =
    SCOPED_SUMMARY_TITLE[lang] ??
    SCOPED_SUMMARY_TITLE.en ??
    "## Scoped Rules Summary";
  const items = scoped
    .map((r) => {
      const filename = basename(r.path);
      const dimText = r.dimensions.join(", ");
      const label =
        lang === "zh"
          ? `来源 \`${r.scope}\`：\`${filename}\` → ${dimText}`
          : `source \`${r.scope}\`: \`${filename}\` → ${dimText}`;
      return `- ${label}`;
    })
    .join("\n");
  return `\n\n${title}\n\n${items}`;
};

export { DIMENSION_LABELS, buildDimensionList, buildCustomRules };
