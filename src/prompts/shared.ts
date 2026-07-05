import type { ReviewConfig, ReviewIntensity } from "../config.ts";
import type { RuleFile } from "../rule-files.ts";

// ---------------------------------------------------------------------------
// Simplification tags
//
// The `code-quality` dimension emits simplification findings tagged with one
// of these five words. Centralising the list here means the dimension body,
// the orchestrator prompts, the fixer exclusion clause, and any future
// consumer share a single source of truth — adding or renaming a tag is a
// one-line change in this file. `formatTagList(lang)` renders them inline
// backticked, language-aware separator. The fixer uses the same `as const`
// array for its safety-boundary gate.
// ---------------------------------------------------------------------------

export const SIMPLIFICATION_TAGS = [
  "delete",
  "yagni",
  "shrink",
  "stdlib",
  "native",
] as const;

/** Render the tag list as inline backticked words with a language-native separator. */
export const formatTagList = (lang: "zh" | "en"): string => {
  const quoted = SIMPLIFICATION_TAGS.map((t) => `\`${t}\``);
  return lang === "zh" ? quoted.join("、") : quoted.join(", ");
};

/** Render the tag list as `` `delete` / `yagni` / ... `` — fixed separator for inline prose. */
export const formatTagListSlash = (): string => {
  const quoted = SIMPLIFICATION_TAGS.map((t) => `\`${t}\``);
  return quoted.join(" / ");
};

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

// ---------------------------------------------------------------------------
// Simplification intensity directive
//
// The `code-quality` dimension is the only lens whose strictness is
// user-tunable. `ReviewIntensity` controls how aggressive the simplification
// scan is; everything else stays identical. All wording lives in
// `INTENSITY_DIRECTIVE_TEXT` so future edits stay synchronized between
// the dimension body, the orchestrator prompts, and the test fixtures.
// ---------------------------------------------------------------------------

const INTENSITY_DIRECTIVE_TITLE: Record<"zh" | "en", string> = {
  zh: "## 精简严格度",
  en: "## Simplification Strictness",
};

const INTENSITY_DIRECTIVE_TEXT: Record<
  ReviewIntensity,
  Record<"zh" | "en", string>
> = {
  lite: {
    zh: "当前为 **lite** 模式（宽松）：仅当存在明确可删除的低风险冗余时给出精简建议，例如未使用的导入/变量、明显的死代码或重复逻辑。",
    en: "Strictness is **lite** (relaxed): only flag clearly deletable, low-risk redundancy such as unused imports/variables, obvious dead code, or trivially duplicated logic.",
  },
  full: {
    zh: "当前为 **full** 模式（默认）：按标准清单评估 `delete`、`yagni`、`shrink`、`stdlib`、`native` 五类精简机会。",
    en: "Strictness is **full** (default): evaluate the standard `delete`, `yagni`, `shrink`, `stdlib`, and `native` simplification checklist at normal depth.",
  },
  ultra: {
    zh: "当前为 **ultra** 模式（激进）：积极指出所有合理的精简候选，包括微妙的 `shrink` / `stdlib` / `native` 改写建议。",
    en: "Strictness is **ultra** (aggressive): flag every reasonable simplification candidate, including subtle `shrink`, `stdlib`, and `native` rewrites.",
  },
};

/**
 * Build a short, language-aware directive describing the active
 * simplification intensity. Consumers (dimension body, single/parallel
 * orchestrator prompts) append it so reviewers can see the active level.
 */
export const buildIntensityDirective = (
  intensity: ReviewIntensity,
  lang: "zh" | "en",
): string => {
  const title = INTENSITY_DIRECTIVE_TITLE[lang];
  const body = INTENSITY_DIRECTIVE_TEXT[intensity][lang];
  return `${title}\n\n${body}`;
};
