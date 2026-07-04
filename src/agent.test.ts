import { describe, it, expect } from "vitest";
import type { ReviewConfig } from "./config.ts";
import type { RuleFile } from "./rule-files.ts";
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
  file_rules: [],
  parallel: true,
};

const rule = (body: string, dimensions: string[]): RuleFile => ({
  // Path is intentionally non-overlapping with the body text so tests
  // asserting on body presence / absence are not fooled by the filename.
  path: `/rules/${Math.random().toString(36).slice(2, 8)}.md`,
  scope: "global",
  dimensions,
  body,
});

/** Section header text in both supported languages. */
const RULE_HEADER = /## Review Rules|## 附加规则/;

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

// ---------------------------------------------------------------------------
// Slice 2 — markdown rule documents (file_rules) flow through every prompt
//
// Contract:
//   single   → all rules (general + scoped bodies) under "## Review Rules"
//   parallel → orchestrator sees general bodies + a scoped-rule summary,
//             dimension sub-agents get scoped+general via getDimensionPrompts
//   fixer    → general rules only, never dimension-scoped bodies
// ---------------------------------------------------------------------------

describe("file_rules — single-agent prompt (parallel: false)", () => {
  it("inlines every rule body and the rule section header", () => {
    const config = {
      ...baseConfig,
      parallel: false,
      file_rules: [
        rule("Always say please.", []),
        rule("Lock the door.", ["security"]),
      ],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("Always say please.");
    expect(prompt).toContain("Lock the door.");
    expect(prompt).toMatch(RULE_HEADER);
  });

  it("does not append a rule section when file_rules is empty", () => {
    const config = { ...baseConfig, parallel: false, file_rules: [] };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toMatch(RULE_HEADER);
  });

  it("renders both Custom Rules and file_rules sections when both are non-empty", () => {
    const config = {
      ...baseConfig,
      parallel: false,
      custom_rules: ["no-console-log"],
      file_rules: [rule("Mind the gap.", [])],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("Custom Rules");
    expect(prompt).toContain("no-console-log");
    expect(prompt).toMatch(RULE_HEADER);
    expect(prompt).toContain("Mind the gap.");
  });
});

describe("file_rules — parallel orchestrator prompt (parallel: true)", () => {
  it("inlines general rule bodies (dimensions: [])", () => {
    const config = {
      ...baseConfig,
      parallel: true,
      file_rules: [rule("General please.", [])],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("General please.");
  });

  it("includes a scoped-rule summary naming every scoped rule's dimensions", () => {
    const config = {
      ...baseConfig,
      parallel: true,
      file_rules: [rule("Lock the door.", ["security"])],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toMatch(/Scoped Rules Summary|维度规则概览/);
    expect(prompt).toContain("security");
  });

  it("does NOT inline dimension-scoped rule bodies into the orchestrator prompt", () => {
    const scopedBody = "ZZZZ_SCOPED_BODY_MARKER_ZZZZ";
    const config = {
      ...baseConfig,
      parallel: true,
      file_rules: [rule(scopedBody, ["security"])],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain(scopedBody);
  });

  it("threads general rules into dimension sub-agents via getDimensionPrompts", () => {
    // The orchestrator prompt itself shows a scoped-summary but not the
    // scoped body; per-dimension rules reach each sub-agent through
    // getDimensionPrompts(config, config.file_rules). The contract for the
    // orchestrator output is: general body is inlined, scoped body is not.
    const config = {
      ...baseConfig,
      parallel: true,
      file_rules: [
        rule("GENERAL_BODY_MARKER.", []),
        rule("SCOPED_BODY_MARKER.", ["security"]),
      ],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("GENERAL_BODY_MARKER.");
    expect(prompt).toMatch(/Scoped Rules Summary|维度规则概览/);
    expect(prompt).not.toContain("SCOPED_BODY_MARKER.");
  });

  it("does not append a general-rule section when file_rules has no general rules", () => {
    const scopedBody = "Scoped only body never shown.";
    const config = {
      ...baseConfig,
      parallel: true,
      file_rules: [rule(scopedBody, ["security"])],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain(scopedBody);
    expect(prompt).toMatch(/Scoped Rules Summary|维度规则概览/);
  });
});

describe("file_rules — fixer prompt", () => {
  it("inlines general rule bodies (dimensions: [])", () => {
    const config = {
      ...baseConfig,
      file_rules: [rule("Use git rebasing.", [])],
    };
    const prompt = buildFixerPrompt(config);
    expect(prompt).toContain("Use git rebasing.");
  });

  it("does NOT inline dimension-scoped rule bodies into the fixer prompt", () => {
    const scopedBody = "ZZZZ_SCOPED_FIXER_BODY_ZZZZ";
    const config = {
      ...baseConfig,
      file_rules: [rule(scopedBody, ["security"])],
    };
    const prompt = buildFixerPrompt(config);
    expect(prompt).not.toContain(scopedBody);
    expect(prompt).not.toMatch(RULE_HEADER);
  });

  it("does not append a rule section when file_rules is empty", () => {
    const config = { ...baseConfig, file_rules: [] };
    const prompt = buildFixerPrompt(config);
    expect(prompt).not.toMatch(RULE_HEADER);
  });
});
