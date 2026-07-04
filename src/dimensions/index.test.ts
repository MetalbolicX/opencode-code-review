import { describe, it, expect } from "vitest";
import type { ReviewConfig } from "../config.ts";
import type { RuleFile } from "../rule-files.ts";
import { getDimensionPrompts } from "./index.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const allFiveDimensions = [
  "code-quality",
  "security",
  "performance",
  "testing",
  "documentation",
];

const allNineDimensions = [
  ...allFiveDimensions,
  "error-handling",
  "api-design",
  "dependencies",
  "maintainability",
];

const baseConfig: ReviewConfig = {
  language: "zh",
  dimensions: allFiveDimensions,
  max_diff_lines: 500,
  trigger: { auto_on_idle: false, cooldown_seconds: 120 },
  custom_rules: [],
  file_rules: [],
  parallel: true,
};

const rule = (
  body: string,
  dimensions: string[],
  scope: "global" | "project" = "global",
): RuleFile => ({
  path: `/rules/${body.replace(/\s+/g, "-")}.md`,
  scope,
  dimensions,
  body,
});

// ---------------------------------------------------------------------------
// Existing behavior (regression)
// ---------------------------------------------------------------------------

describe("getDimensionPrompts — existing behavior", () => {
  it("filters out unknown dimension names", () => {
    const config = {
      ...baseConfig,
      dimensions: ["code-quality", "not-a-dimension", "security"],
    };
    const prompts = getDimensionPrompts(config);
    expect(prompts.map((p) => p.name)).toEqual(["code-quality", "security"]);
  });

  it("deduplicates repeated dimension names", () => {
    const config = {
      ...baseConfig,
      dimensions: ["code-quality", "code-quality", "security", "code-quality"],
    };
    const prompts = getDimensionPrompts(config);
    expect(prompts.map((p) => p.name)).toEqual(["code-quality", "security"]);
  });

  it("returns correct agentName format", () => {
    const config = { ...baseConfig, dimensions: ["code-quality"] };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0]?.agentName).toBe("review:dim-code-quality");
  });

  it("returns non-empty prompt strings for known dimensions", () => {
    const config = { ...baseConfig, dimensions: ["code-quality"] };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0]?.prompt.length).toBeGreaterThan(0);
  });

  it("selects zh content when language is zh", () => {
    const config = { ...baseConfig, language: "zh" };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0]?.prompt).toContain("代码质量");
  });

  it("selects en content when language is en", () => {
    const config = { ...baseConfig, language: "en" };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0]?.prompt).toContain("code quality");
  });

  it("with all 5 default dimensions returns exactly 5 entries", () => {
    const config = { ...baseConfig, dimensions: allFiveDimensions };
    const prompts = getDimensionPrompts(config);
    expect(prompts).toHaveLength(5);
  });

  it("accepts (config) with no rules argument — backward compat", () => {
    const config = { ...baseConfig, dimensions: ["security"] };
    const prompts = getDimensionPrompts(config);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.prompt).not.toContain("## Review Rules");
  });

  it("accepts an empty rules array — no rule section appended", () => {
    const config = { ...baseConfig, dimensions: ["security"] };
    const prompts = getDimensionPrompts(config, []);
    expect(prompts[0]?.prompt).not.toContain("## Review Rules");
  });
});

// ---------------------------------------------------------------------------
// New built-in dimensions
// ---------------------------------------------------------------------------

describe("getDimensionPrompts — new built-in dimensions", () => {
  for (const dim of [
    "error-handling",
    "api-design",
    "dependencies",
    "maintainability",
  ]) {
    it(`includes ${dim} as a known dimension`, () => {
      const config = { ...baseConfig, dimensions: [dim] };
      const prompts = getDimensionPrompts(config);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.name).toBe(dim);
      expect(prompts[0]?.agentName).toBe(`review:dim-${dim}`);
    });

    it(`returns non-empty zh prompt for ${dim}`, () => {
      const config = { ...baseConfig, dimensions: [dim], language: "zh" };
      const prompts = getDimensionPrompts(config);
      expect(prompts[0]?.prompt.length).toBeGreaterThan(0);
      // Chinese characters are required to confirm zh content is real
      expect(prompts[0]?.prompt).toMatch(/[\u4e00-\u9fff]/);
    });

    it(`returns non-empty en prompt for ${dim}`, () => {
      const config = { ...baseConfig, dimensions: [dim], language: "en" };
      const prompts = getDimensionPrompts(config);
      expect(prompts[0]?.prompt.length).toBeGreaterThan(0);
      // Should mention "review" / "code" / "focus" — generic English hints
      expect(prompts[0]?.prompt).toMatch(/review|code|focus/i);
    });
  }

  it("all 9 dimensions can be selected at once", () => {
    const config = { ...baseConfig, dimensions: allNineDimensions };
    const prompts = getDimensionPrompts(config);
    expect(prompts).toHaveLength(9);
    expect(prompts.map((p) => p.name)).toEqual(allNineDimensions);
  });
});

// ---------------------------------------------------------------------------
// Rule injection — scoping
// ---------------------------------------------------------------------------

describe("getDimensionPrompts — rule injection", () => {
  it("injects general rules (dimensions: []) into every dimension prompt", () => {
    const general = rule("Always say please.", []);
    const config = {
      ...baseConfig,
      language: "en",
      dimensions: ["security", "testing"],
    };
    const prompts = getDimensionPrompts(config, [general]);
    for (const p of prompts) {
      expect(p.prompt).toContain("## Review Rules");
      expect(p.prompt).toContain("Always say please.");
    }
  });

  it("uses the zh rule-section header when language is zh", () => {
    const general = rule("通用规则", []);
    const config = {
      ...baseConfig,
      language: "zh",
      dimensions: ["security"],
    };
    const prompts = getDimensionPrompts(config, [general]);
    expect(prompts[0]?.prompt).toContain("## 附加规则");
    expect(prompts[0]?.prompt).toContain("通用规则");
  });

  it("injects dimension-scoped rules only into matching dimensions", () => {
    const securityRule = rule("Lock the door.", ["security"]);
    const testingRule = rule("Test the lock.", ["testing"]);
    const config = {
      ...baseConfig,
      language: "en",
      dimensions: ["security", "testing"],
    };
    const prompts = getDimensionPrompts(config, [securityRule, testingRule]);

    const sec = prompts.find((p) => p.name === "security");
    const tst = prompts.find((p) => p.name === "testing");
    expect(sec?.prompt).toContain("Lock the door.");
    expect(sec?.prompt).not.toContain("Test the lock.");
    expect(tst?.prompt).toContain("Test the lock.");
    expect(tst?.prompt).not.toContain("Lock the door.");
  });

  it("injects a rule scoped to two dimensions into both of them", () => {
    const shared = rule("Always be kind.", ["security", "testing"]);
    const config = {
      ...baseConfig,
      language: "en",
      dimensions: ["security", "testing", "performance"],
    };
    const prompts = getDimensionPrompts(config, [shared]);
    const sec = prompts.find((p) => p.name === "security");
    const tst = prompts.find((p) => p.name === "testing");
    const perf = prompts.find((p) => p.name === "performance");
    expect(sec?.prompt).toContain("Always be kind.");
    expect(tst?.prompt).toContain("Always be kind.");
    expect(perf?.prompt).not.toContain("Always be kind.");
  });

  it("appends general rules AFTER dimension-scoped rules", () => {
    const general = rule("General last.", []);
    const scoped = rule("Scoped first.", ["security"]);
    const config = { ...baseConfig, language: "en", dimensions: ["security"] };
    const prompts = getDimensionPrompts(config, [general, scoped]);
    const prompt = prompts[0]?.prompt ?? "";
    const scopedIdx = prompt.indexOf("Scoped first.");
    const generalIdx = prompt.indexOf("General last.");
    expect(scopedIdx).toBeGreaterThan(-1);
    expect(generalIdx).toBeGreaterThan(scopedIdx);
  });

  it("preserves rule order from the loader within each group", () => {
    const general1 = rule("GENERAL_ONE", []);
    const general2 = rule("GENERAL_TWO", []);
    const config = { ...baseConfig, language: "en", dimensions: ["security"] };
    const prompts = getDimensionPrompts(config, [general1, general2]);
    const prompt = prompts[0]?.prompt ?? "";
    expect(prompt.indexOf("GENERAL_ONE")).toBeLessThan(
      prompt.indexOf("GENERAL_TWO"),
    );
  });

  it("skips rules that match none of the active dimensions", () => {
    const inactive = rule("Do nothing.", ["performance"]);
    const config = { ...baseConfig, language: "en", dimensions: ["security"] };
    const prompts = getDimensionPrompts(config, [inactive]);
    expect(prompts[0]?.prompt).not.toContain("Do nothing.");
    expect(prompts[0]?.prompt).not.toContain("## Review Rules");
  });

  it("handles multiple general rules without duplicating the section header", () => {
    const g1 = rule("G1", []);
    const g2 = rule("G2", []);
    const config = { ...baseConfig, language: "en", dimensions: ["security"] };
    const prompts = getDimensionPrompts(config, [g1, g2]);
    const prompt = prompts[0]?.prompt ?? "";
    const matches = prompt.match(/## Review Rules/g) ?? [];
    expect(matches.length).toBe(1);
    expect(prompt).toContain("G1");
    expect(prompt).toContain("G2");
  });

  it("keeps the original built-in content above the rule section", () => {
    const general = rule("GENERAL_BODY", []);
    const config = { ...baseConfig, dimensions: ["security"], language: "en" };
    const prompts = getDimensionPrompts(config, [general]);
    const prompt = prompts[0]?.prompt ?? "";
    const builtInIdx = prompt.indexOf(
      "expert reviewer focused on **security**",
    );
    const ruleIdx = prompt.indexOf("## Review Rules");
    expect(builtInIdx).toBeGreaterThan(-1);
    expect(ruleIdx).toBeGreaterThan(builtInIdx);
  });

  it("injects the new built-in dimensions into rule scoping correctly", () => {
    const apiRule = rule("Version your routes.", ["api-design"]);
    const config = {
      ...baseConfig,
      dimensions: ["api-design", "security"],
    };
    const prompts = getDimensionPrompts(config, [apiRule]);
    const api = prompts.find((p) => p.name === "api-design");
    const sec = prompts.find((p) => p.name === "security");
    expect(api?.prompt).toContain("Version your routes.");
    expect(sec?.prompt).not.toContain("Version your routes.");
  });
});
