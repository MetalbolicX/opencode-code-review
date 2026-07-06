import { describe, it, expect } from "vitest";
import type { ReviewIntensity } from "../config.ts";
import {
  buildCustomRules,
  buildIntensityDirective,
  formatTagList,
  formatTagListSlash,
} from "./shared.ts";

const INTENSITIES: readonly ReviewIntensity[] = ["lite", "full", "ultra"];

describe("buildIntensityDirective", () => {
  it("returns a non-empty string for every (intensity, lang) combination", () => {
    for (const intensity of INTENSITIES) {
      const zh = buildIntensityDirective(intensity, "zh");
      const en = buildIntensityDirective(intensity, "en");
      expect(zh).toBeTypeOf("string");
      expect(zh.length).toBeGreaterThan(0);
      expect(en).toBeTypeOf("string");
      expect(en.length).toBeGreaterThan(0);
    }
  });

  it("reflects the active intensity in zh output", () => {
    expect(buildIntensityDirective("lite", "zh")).toContain("lite");
    expect(buildIntensityDirective("full", "zh")).toContain("full");
    expect(buildIntensityDirective("ultra", "zh")).toContain("ultra");
  });

  it("reflects the active intensity in en output", () => {
    expect(buildIntensityDirective("lite", "en")).toContain("lite");
    expect(buildIntensityDirective("full", "en")).toContain("full");
    expect(buildIntensityDirective("ultra", "en")).toContain("ultra");
  });

  it("produces zh-specific wording for zh (not just english copy)", () => {
    // Lock the language channels: zh output should differ from en output
    // by more than just the locale tag. A real reviewer-facing directive
    // carries chinese-style wording in zh and english wording in en.
    const zh = buildIntensityDirective("lite", "zh");
    const en = buildIntensityDirective("lite", "en");
    expect(zh).not.toBe(en);
    // Each language carries concrete language-specific markers. These
    // are stable vocabulary tokens we expect the helper to render.
    expect(zh).toContain("精简");
    expect(en).toContain("Simplification");
  });

  it("emits a different directive per intensity within the same language", () => {
    // Triangulation: a single hardcoded "return ''" helper would still pass
    // the non-empty test above. This forces distinct outputs per level.
    const lite = buildIntensityDirective("lite", "zh");
    const full = buildIntensityDirective("full", "zh");
    const ultra = buildIntensityDirective("ultra", "zh");
    expect(lite).not.toBe(full);
    expect(full).not.toBe(ultra);
    expect(lite).not.toBe(ultra);
  });

  it("surfaces a 'full' marker in both languages so the default is identifiable", () => {
    // The spec mandates `full` as default. Even if a caller forgets the
    // active intensity, a reader of the prompt should be able to recognize
    // that default from the directive itself.
    expect(buildIntensityDirective("full", "zh")).toContain("默认");
    expect(buildIntensityDirective("full", "en")).toContain("default");
  });
});

// ---------------------------------------------------------------------------
// Simplification tag helpers (Phase 3 refactor: single-source of truth)
//
// The five simplification tags (`delete`, `yagni`, `shrink`, `stdlib`,
// `native`) live in shared.ts. The dimension body, the orchestrator
// prompts, and the fixer exclusion clause all read from here.
// ---------------------------------------------------------------------------

describe("formatTagList", () => {
  it("renders all five tags as backticked words", () => {
    for (const lang of ["zh", "en"] as const) {
      const out = formatTagList(lang);
      for (const tag of ["delete", "yagni", "shrink", "stdlib", "native"]) {
        expect(out).toContain(`\`${tag}\``);
      }
    }
  });

  it("uses a language-native separator (、 for zh, ', ' for en)", () => {
    expect(formatTagList("zh")).toContain("、");
    expect(formatTagList("en")).toContain(", ");
  });

  it("is a strict superset of formatTagListSlash output (just different separators)", () => {
    // Triangulation: changing the separator between dimension body and
    // fixer exclusion must stay consistent. The slash form drops the
    // western/ideographic separator in favour of '/' for inline prose.
    const enSlash = formatTagListSlash().replace(/`/g, "");
    const enList = formatTagList("en").replace(/`/g, "");
    // enList: "delete, yagni, shrink, stdlib, native"; enSlash: "delete / yagni / ..."
    expect(enList.replace(/, /g, " / ")).toBe(enSlash.replace(/ \/ /g, " / "));
  });
});

describe("formatTagListSlash", () => {
  it("renders all five tags separated by ' / '", () => {
    const out = formatTagListSlash();
    expect(out).toContain(
      "`delete` / `yagni` / `shrink` / `stdlib` / `native`",
    );
  });

  it("uses the slash separator", () => {
    // The slash form is reserved for inline narrative (fixer exclusion,
    // orchestrator prompts). Same render in every language.
    expect(formatTagListSlash()).toContain(" / ");
  });
});

// ---------------------------------------------------------------------------
// Custom rules helper (plan 016)
//
// `buildCustomRules` renders the configured `custom_rules` bullets into a
// markdown section appended to prompts. Empty arrays MUST short-circuit to
// an empty string so callers don't append a stray header in the no-op case.
// ---------------------------------------------------------------------------

describe("buildCustomRules", () => {
  it("returns an empty string when the rules array is empty (no-op)", () => {
    // The empty-array no-op is the spec contract: callers concatenate the
    // result directly so an empty string keeps the prompt unchanged.
    expect(buildCustomRules([])).toBe("");
  });

  it("renders each rule as a markdown bullet under a Custom Rules header", () => {
    const out = buildCustomRules(["no-console-log", "prefer-const"]);
    expect(out).toContain("### Custom Rules");
    expect(out).toContain("- no-console-log");
    expect(out).toContain("- prefer-const");
  });

  it("preserves the order of the input array in the rendered bullets", () => {
    const out = buildCustomRules(["alpha-rule", "beta-rule", "gamma-rule"]);
    expect(out.indexOf("- alpha-rule")).toBeLessThan(
      out.indexOf("- beta-rule"),
    );
    expect(out.indexOf("- beta-rule")).toBeLessThan(
      out.indexOf("- gamma-rule"),
    );
  });

  it("does not render a header when the array is empty", () => {
    const out = buildCustomRules([]);
    expect(out).not.toContain("Custom Rules");
    expect(out.length).toBe(0);
  });
});
