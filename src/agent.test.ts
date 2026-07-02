import { describe, it, expect } from "vitest";
import type { ReviewConfig } from "./config.ts";
import {
  buildAgentPrompt,
  buildFixerPrompt,
  buildTogglePrompt,
} from "./prompts/index.ts";

const baseConfig: ReviewConfig = {
  language: "zh",
  dimensions: ["code-quality", "security"],
  max_diff_lines: 500,
  trigger: { auto_on_idle: false, cooldown_seconds: 120 },
  custom_rules: [],
  parallel: true,
};

describe("buildAgentPrompt", () => {
  it("returns single-review prompt when parallel is false", () => {
    const config = { ...baseConfig, parallel: false };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("review_changes");
  });

  it("returns orchestrator prompt when parallel is true", () => {
    const config = { ...baseConfig, parallel: true };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("review:dim-code-quality");
  });

  it("produces different output for zh vs en", () => {
    const zhConfig = { ...baseConfig, language: "zh" as const };
    const enConfig = { ...baseConfig, language: "en" as const };
    const zhPrompt = buildAgentPrompt(zhConfig);
    const enPrompt = buildAgentPrompt(enConfig);
    expect(zhPrompt).not.toBe(enPrompt);
  });

  it("injects custom rules section when custom_rules is non-empty (single-prompt mode)", () => {
    const config = {
      ...baseConfig,
      custom_rules: ["no-console-log", "prefer-const"],
      parallel: false,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("Custom Rules");
    expect(prompt).toContain("no-console-log");
    expect(prompt).toContain("prefer-const");
  });

  it("does NOT inject Custom Rules section when custom_rules is empty", () => {
    const config = { ...baseConfig, custom_rules: [] };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("Custom Rules");
  });
});

describe("buildFixerPrompt", () => {
  it("returns non-empty output for zh", () => {
    const config = { ...baseConfig, language: "zh" };
    const prompt = buildFixerPrompt(config);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("returns non-empty output for en", () => {
    const config = { ...baseConfig, language: "en" };
    const prompt = buildFixerPrompt(config);
    expect(prompt.length).toBeGreaterThan(0);
  });
});

describe("buildTogglePrompt", () => {
  it("returns non-empty output for zh", () => {
    const config = { ...baseConfig, language: "zh" };
    const prompt = buildTogglePrompt(config);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("returns non-empty output for en", () => {
    const config = { ...baseConfig, language: "en" };
    const prompt = buildTogglePrompt(config);
    expect(prompt.length).toBeGreaterThan(0);
  });
});
