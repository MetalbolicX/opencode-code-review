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
  intensity: "full",
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

// ---------------------------------------------------------------------------
// Simplification lens (code-quality dimension body, zh+en)
//
// Phase 2 contract:
//   • all five tags (`delete`, `yagni`, `shrink`, `stdlib`, `native`) appear
//     in both languages
//   • functional boundary text forbids behavior/validation/security/
//     accessibility regressions
//   • the `shrink` rule is explicitly behavior-equivalent only
//   • `buildIntensityDirective` is appended at the active intensity
//   • `OUTPUT_FORMAT` documents an optional `[tag]` prefix while preserving
//     🔴/🟡/✅ severities
// ---------------------------------------------------------------------------

const SIMPLIFICATION_TAGS = [
  "delete",
  "yagni",
  "shrink",
  "stdlib",
  "native",
] as const;

describe("getDimensionPrompts — code-quality simplification lens", () => {
  for (const lang of ["zh", "en"] as const) {
    const config = {
      ...baseConfig,
      language: lang,
      dimensions: ["code-quality"],
    };

    it(`includes all 5 simplification tags (${lang})`, () => {
      const prompts = getDimensionPrompts(config);
      const prompt = prompts[0]?.prompt ?? "";
      for (const tag of SIMPLIFICATION_TAGS) {
        expect(prompt).toContain(tag);
      }
    });

    it(`states the functional safety boundary in ${lang}`, () => {
      // The body must forbid simplifications that change behavior, weaken
      // validation, drop security, or drop accessibility. We check only
      // language-stable tokens so the test survives prose adjustments.
      const prompts = getDimensionPrompts(config);
      const prompt = (prompts[0]?.prompt ?? "").toLowerCase();
      const markers = ["behavior", "validation", "security", "accessibility"];
      // Chinese prompt uses behavior/validation/security/accessibility
      // translations; markers check is for English; for zh we look at the
      // Chinese equivalents below.
      if (lang === "en") {
        for (const m of markers) expect(prompt).toContain(m);
      } else {
        // zh markers
        expect(prompt).toMatch(/行为/);
        expect(prompt).toMatch(/校验/);
        expect(prompt).toMatch(/安全/);
        expect(prompt).toMatch(/可访问性|无障碍/);
      }
    });

    it(`calls out shrink = behavior-equivalent only (${lang})`, () => {
      const prompts = getDimensionPrompts(config);
      const prompt = prompts[0]?.prompt ?? "";
      // shrink must appear next to behavior-equivalence wording.
      expect(prompt).toContain("shrink");
      if (lang === "en") {
        expect(prompt).toMatch(/shrink[\s\S]*equivalent/i);
      } else {
        // zh body uses 行为完全等价 / 行为等价; accept either phrasing
        // as long as it follows the `shrink` token.
        expect(prompt).toMatch(/shrink[\s\S]*行为(?:完全)?等价/);
      }
    });

    it(`appends the intensity directive at the active level (${lang})`, () => {
      const probes = [
        { intensity: "lite", enMarker: "lite", zhMarker: "lite" },
        { intensity: "full", enMarker: "default", zhMarker: "默认" },
        { intensity: "ultra", enMarker: "aggressive", zhMarker: "激进" },
      ] as const;
      for (const p of probes) {
        const cfg = {
          ...config,
          intensity: p.intensity,
        };
        const prompts = getDimensionPrompts(cfg);
        const text = prompts[0]?.prompt ?? "";
        expect(text).toContain(p.intensity);
        const marker = lang === "en" ? p.enMarker : p.zhMarker;
        expect(text).toContain(marker);
      }
    });

    it(`documents the optional [tag] prefix in OUTPUT_FORMAT (${lang})`, () => {
      const prompts = getDimensionPrompts(config);
      const prompt = prompts[0]?.prompt ?? "";
      // The output-format section must show a `[tag]` placeholder.
      expect(prompt).toMatch(/\[(tag|yagni)\]/);
      // Severity model must remain — at least one of 🔴 / 🟡 / ✅ should
      // still appear in the output-format section.
      expect(prompt).toMatch(/🔴|🟡|✅/);
    });
  }
});
