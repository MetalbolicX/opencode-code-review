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
  intensity: "full",
  profile: "default",
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

// ---------------------------------------------------------------------------
// Custom rules on parallel path (plan 016)
//
// Before the factory + third-arg fix, the parallel orchestrator prompt and
// its dimension sub-prompts silently dropped `config.custom_rules`. After
// the fix the orchestrator sees the same Custom Rules block that the
// single-mode prompt already had, and `getDimensionPrompts` receives the
// rules via its new third optional argument.
// ---------------------------------------------------------------------------

describe("parallel-mode custom_rules propagation", () => {
  it("includes Custom Rules in the parallel orchestrator prompt when non-empty", () => {
    const config = {
      ...baseConfig,
      parallel: true,
      custom_rules: ["no-console-log", "prefer-const"],
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("Custom Rules");
    expect(prompt).toContain("- no-console-log");
    expect(prompt).toContain("- prefer-const");
  });

  it("does NOT include Custom Rules in the parallel orchestrator prompt when empty", () => {
    const config = { ...baseConfig, parallel: true, custom_rules: [] };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("Custom Rules");
  });

  it("renders Custom Rules in both zh and en parallel orchestrators", () => {
    for (const lang of ["zh", "en"] as const) {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: true,
        custom_rules: ["no-console-log"],
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain("Custom Rules");
      expect(prompt).toContain("- no-console-log");
    }
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

// ---------------------------------------------------------------------------
// Slice 3 — integration & fixer safety (Phase 3 / PR 3)
//
// Contract:
//   single   → surface the active intensity in the prompt so reviewers see
//              the strictness level; document the optional [tag] output prefix
//   parallel → same surface for the orchestrator; merged-report docs must
//              remain compatible with the optional [tag] prefix
//   fixer    → NEVER auto-fix a finding tagged delete / yagni / shrink /
//              stdlib / native — defense in depth on top of the dimension
//              boundary rule
// ---------------------------------------------------------------------------

const INTENSITIES = ["lite", "full", "ultra"] as const;
type Intensity = (typeof INTENSITIES)[number];

const isIntensityToken = (prompt: string, lang: "zh" | "en", i: Intensity) =>
  prompt.includes(i) &&
  (lang === "zh" ? prompt.includes("精简") : prompt.includes("Simplification"));

describe("single-agent prompt — surfaces intensity directive (Phase 3)", () => {
  for (const intensity of INTENSITIES) {
    for (const lang of ["zh", "en"] as const) {
      it(`includes the active intensity (${intensity}, ${lang})`, () => {
        const config = {
          ...baseConfig,
          language: lang,
          intensity,
          parallel: false,
        };
        const prompt = buildAgentPrompt(config);
        expect(isIntensityToken(prompt, lang, intensity)).toBe(true);
      });
    }
  }

  it("returns a different single-prompt per intensity in zh (triangulation)", () => {
    const liteCfg = {
      ...baseConfig,
      language: "zh" as const,
      intensity: "lite" as const,
      parallel: false,
    };
    const ultraCfg = {
      ...baseConfig,
      language: "zh" as const,
      intensity: "ultra" as const,
      parallel: false,
    };
    const litePrompt = buildAgentPrompt(liteCfg);
    const ultraPrompt = buildAgentPrompt(ultraCfg);
    expect(litePrompt).not.toBe(ultraPrompt);
  });

  it("documents the optional [tag] output prefix in zh output", () => {
    const config = { ...baseConfig, language: "zh" as const, parallel: false };
    const prompt = buildAgentPrompt(config);
    // Behavioral: the optional [tag] prefix is a documented affordance for
    // simplification findings; we expect the prompt to mention it explicitly
    // so reviewers know the convention. The tag text itself must surface in
    // the output documentation (not just in dimension bodies).
    expect(prompt).toMatch(/\[(tag|yagni|delete|shrink|stdlib|native)\]/);
  });

  it("documents the optional [tag] output prefix in en output", () => {
    const config = { ...baseConfig, language: "en" as const, parallel: false };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toMatch(/\[(tag|yagni|delete|shrink|stdlib|native)\]/);
  });
});

describe("parallel orchestrator prompt — surfaces intensity directive (Phase 3)", () => {
  for (const intensity of INTENSITIES) {
    for (const lang of ["zh", "en"] as const) {
      it(`includes the active intensity (${intensity}, ${lang})`, () => {
        const config = {
          ...baseConfig,
          language: lang,
          intensity,
          parallel: true,
        };
        const prompt = buildAgentPrompt(config);
        expect(isIntensityToken(prompt, lang, intensity)).toBe(true);
      });
    }
  }

  it("returns a different orchestrator prompt per intensity in en (triangulation)", () => {
    const liteCfg = {
      ...baseConfig,
      language: "en" as const,
      intensity: "lite" as const,
      parallel: true,
    };
    const ultraCfg = {
      ...baseConfig,
      language: "en" as const,
      intensity: "ultra" as const,
      parallel: true,
    };
    expect(buildAgentPrompt(liteCfg)).not.toBe(buildAgentPrompt(ultraCfg));
  });

  it("merged-report docs remain compatible with the optional [tag] prefix (zh)", () => {
    const config = { ...baseConfig, language: "zh" as const, parallel: true };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toMatch(/\[(tag|yagni|delete|shrink|stdlib|native)\]/);
  });

  it("merged-report docs remain compatible with the optional [tag] prefix (en)", () => {
    const config = { ...baseConfig, language: "en" as const, parallel: true };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toMatch(/\[(tag|yagni|delete|shrink|stdlib|native)\]/);
  });
});

describe("fixer prompt — excludes simplification findings from auto-fix (Phase 3)", () => {
  // The five tags are spelled in source so a literal substring assertion is a
  // behavioral guard: a fixer's prompt that omits even one tag leaves a hole.
  const ALL_FIVE_TAGS = ["delete", "yagni", "shrink", "stdlib", "native"];

  it("names all five simplification tags in zh", () => {
    const config = { ...baseConfig, language: "zh" as const };
    const prompt = buildFixerPrompt(config);
    for (const tag of ALL_FIVE_TAGS) {
      expect(prompt).toContain(tag);
    }
  });

  it("names all five simplification tags in en", () => {
    const config = { ...baseConfig, language: "en" as const };
    const prompt = buildFixerPrompt(config);
    for (const tag of ALL_FIVE_TAGS) {
      expect(prompt).toContain(tag);
    }
  });

  it("explicitly forbids auto-fix in zh", () => {
    const config = { ...baseConfig, language: "zh" as const };
    const prompt = buildFixerPrompt(config);
    // Defense-in-depth: a Chinese-positive exclusion phrase must appear near
    // the tag list. Acceptable phrasings include 不自动修复 / 不要修复 /
    // 禁止修复 / 不会自动修复. The presence of any one is the contract.
    expect(prompt).toMatch(
      /(不自动修复|不要(自动)?修复|禁止自动修复|不会自动修复|不修复)/,
    );
  });

  it("explicitly forbids auto-fix in en", () => {
    const config = { ...baseConfig, language: "en" as const };
    const prompt = buildFixerPrompt(config);
    expect(prompt).toMatch(/never\s+(auto[-\s]?fix|fix)/i);
    // Belt-and-suspenders: "do not auto-fix" is also an acceptable phrasing.
    expect(prompt).toMatch(/(do\s+not\s+(auto[-\s]?fix|fix))/i);
  });
});

// ---------------------------------------------------------------------------
// Fixer thermo exclusion (Phase B1 / PR #1)
//
// Contract:
//   default profile → fixer prompt does NOT contain [thermo] exclusion
//   thermo-nuclear   → fixer prompt contains [thermo] exclusion wording
// ---------------------------------------------------------------------------

describe("fixer prompt — thermo exclusion (Phase B1)", () => {
  it("does NOT contain [thermo] exclusion when profile is 'default' (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      profile: "default" as const,
    };
    const prompt = buildFixerPrompt(config);
    expect(prompt).not.toContain("[thermo]");
    expect(prompt).not.toContain("thermo");
  });

  it("does NOT contain [thermo] exclusion when profile is 'default' (en)", () => {
    const config = {
      ...baseConfig,
      language: "en" as const,
      profile: "default" as const,
    };
    const prompt = buildFixerPrompt(config);
    expect(prompt).not.toContain("[thermo]");
    expect(prompt).not.toContain("thermo");
  });

  it("contains [thermo] exclusion when profile is 'thermo-nuclear' (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildFixerPrompt(config);
    expect(prompt).toContain("[thermo]");
  });

  it("contains [thermo] exclusion when profile is 'thermo-nuclear' (en)", () => {
    const config = {
      ...baseConfig,
      language: "en" as const,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildFixerPrompt(config);
    expect(prompt).toContain("[thermo]");
  });

  it("still contains simplification exclusion alongside thermo exclusion (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildFixerPrompt(config);
    // Both exclusions must coexist
    for (const tag of ["delete", "yagni", "shrink", "stdlib", "native"]) {
      expect(prompt).toContain(tag);
    }
    expect(prompt).toContain("[thermo]");
  });
});

// ---------------------------------------------------------------------------
// YAGNI ladder in orchestrator prompts — basic / medium profiles (Phase 3 / PR 2)
//
// Contract:
//   basic / medium → ladder directive (YAGNI heading) appears in BOTH
//                    single and parallel orchestrator prompts
//   default       → no ladder directive in any orchestrator prompt
//   thermo-nuclear → tested in Phase C section above (unchanged)
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — YAGNI ladder in orchestrators (Phase 3)", () => {
  for (const lang of ["zh", "en"] as const) {
    // -- single-prompt (parallel: false) ---------------------------------------

    it(`basic: ladder heading in single-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: false,
        profile: "basic" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain("YAGNI");
      if (lang === "en") {
        expect(prompt).toContain("Simplification Lens");
      } else {
        expect(prompt).toContain("精简视角");
      }
    });

    it(`medium: ladder heading in single-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: false,
        profile: "medium" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain("YAGNI");
      if (lang === "en") {
        expect(prompt).toContain("Simplification Lens");
      } else {
        expect(prompt).toContain("精简视角");
      }
    });

    it(`basic: 'advisory' posture in single-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: false,
        profile: "basic" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain(lang === "en" ? "advisory" : "建议");
    });

    it(`medium: 'enforced' posture in single-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: false,
        profile: "medium" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain(lang === "en" ? "enforced" : "强制审查");
    });

    it(`default: no ladder heading in single-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: false,
        profile: "default" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).not.toContain("YAGNI");
      expect(prompt).not.toContain("Simplification Lens");
    });

    // -- parallel-prompt (parallel: true) -------------------------------------

    it(`basic: ladder heading in parallel-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: true,
        profile: "basic" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain("YAGNI");
      if (lang === "en") {
        expect(prompt).toContain("Simplification Lens");
      } else {
        expect(prompt).toContain("精简视角");
      }
    });

    it(`medium: ladder heading in parallel-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: true,
        profile: "medium" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain("YAGNI");
      if (lang === "en") {
        expect(prompt).toContain("Simplification Lens");
      } else {
        expect(prompt).toContain("精简视角");
      }
    });

    it(`basic: 'advisory' posture in parallel-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: true,
        profile: "basic" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain(lang === "en" ? "advisory" : "建议");
    });

    it(`medium: 'enforced' posture in parallel-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: true,
        profile: "medium" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).toContain(lang === "en" ? "enforced" : "强制审查");
    });

    it(`default: no ladder heading in parallel-prompt (${lang})`, () => {
      const config = {
        ...baseConfig,
        language: lang,
        parallel: true,
        profile: "default" as const,
      };
      const prompt = buildAgentPrompt(config);
      expect(prompt).not.toContain("YAGNI");
      expect(prompt).not.toContain("Simplification Lens");
    });
  }
});

// ---------------------------------------------------------------------------
// Agent prompts — thermo-nuclear profile (Phase C / PR #2)
// ---------------------------------------------------------------------------

describe("buildAgentPrompt — thermo-nuclear profile (Phase C)", () => {
  it("[thermo] marker appears in single-prompt when profile is thermo-nuclear (en)", () => {
    const config = {
      ...baseConfig,
      language: "en" as const,
      parallel: false,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("[thermo]");
  });

  it("[thermo] marker appears in single-prompt when profile is thermo-nuclear (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      parallel: false,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("[thermo]");
  });

  it("[thermo] marker is absent from single-prompt when profile is default (en)", () => {
    const config = {
      ...baseConfig,
      language: "en" as const,
      parallel: false,
      profile: "default" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("[thermo]");
  });

  it("[thermo] marker is absent from single-prompt when profile is default (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      parallel: false,
      profile: "default" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("[thermo]");
  });

  it("[thermo] marker appears in parallel-prompt when profile is thermo-nuclear (en)", () => {
    const config = {
      ...baseConfig,
      language: "en" as const,
      parallel: true,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("[thermo]");
  });

  it("[thermo] marker appears in parallel-prompt when profile is thermo-nuclear (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      parallel: true,
      profile: "thermo-nuclear" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).toContain("[thermo]");
  });

  it("[thermo] marker is absent from parallel-prompt when profile is default (en)", () => {
    const config = {
      ...baseConfig,
      language: "en" as const,
      parallel: true,
      profile: "default" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("[thermo]");
  });

  it("[thermo] marker is absent from parallel-prompt when profile is default (zh)", () => {
    const config = {
      ...baseConfig,
      language: "zh" as const,
      parallel: true,
      profile: "default" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("[thermo]");
  });

  it("default-profile single-prompt has zero thermo content", () => {
    const config = {
      ...baseConfig,
      parallel: false,
      profile: "default" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("[thermo]");
    expect(prompt).not.toContain("thermo-nuclear");
    expect(prompt).not.toContain("Thermo");
  });

  it("default-profile parallel-prompt has zero thermo content", () => {
    const config = {
      ...baseConfig,
      parallel: true,
      profile: "default" as const,
    };
    const prompt = buildAgentPrompt(config);
    expect(prompt).not.toContain("[thermo]");
    expect(prompt).not.toContain("thermo-nuclear");
    expect(prompt).not.toContain("Thermo");
  });
});
