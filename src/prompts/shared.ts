import type { ReviewConfig } from "../config.ts";

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

export { DIMENSION_LABELS, buildDimensionList, buildCustomRules };
