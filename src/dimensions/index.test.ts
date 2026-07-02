import { describe, it, expect } from "vitest";
import type { ReviewConfig } from "../config.ts";
import { getDimensionPrompts } from "./index.ts";

const allFiveDimensions = [
  "code-quality",
  "security",
  "performance",
  "testing",
  "documentation",
];

const baseConfig: ReviewConfig = {
  language: "zh",
  dimensions: allFiveDimensions,
  max_diff_lines: 500,
  trigger: { auto_on_idle: false, cooldown_seconds: 120 },
  custom_rules: [],
  parallel: true,
};

describe("getDimensionPrompts", () => {
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
    expect(prompts[0].agentName).toBe("review:dim-code-quality");
  });

  it("returns non-empty prompt strings for known dimensions", () => {
    const config = { ...baseConfig, dimensions: ["code-quality"] };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0].prompt.length).toBeGreaterThan(0);
  });

  it("selects zh content when language is zh", () => {
    const config = { ...baseConfig, language: "zh" };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0].prompt).toContain("代码质量");
  });

  it("selects en content when language is en", () => {
    const config = { ...baseConfig, language: "en" };
    const prompts = getDimensionPrompts(config);
    expect(prompts[0].prompt).toContain("code quality");
  });

  it("with all 5 default dimensions returns exactly 5 entries", () => {
    const config = { ...baseConfig, dimensions: allFiveDimensions };
    const prompts = getDimensionPrompts(config);
    expect(prompts).toHaveLength(5);
  });
});
