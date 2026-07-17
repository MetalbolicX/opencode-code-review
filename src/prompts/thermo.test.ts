import { describe, it, expect } from "vitest";
import { THERMO_MARKER, buildProfileDirective } from "./thermo.ts";

describe("buildProfileDirective", () => {
  it("returns empty string for 'default' profile (en)", () => {
    const result = buildProfileDirective("default", "en");
    expect(result).toBe("");
  });

  it("returns empty string for 'default' profile (zh)", () => {
    const result = buildProfileDirective("default", "zh");
    expect(result).toBe("");
  });

  it("returns non-empty string for 'thermo-nuclear' profile (en)", () => {
    const result = buildProfileDirective("thermo-nuclear", "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for 'thermo-nuclear' profile (zh)", () => {
    const result = buildProfileDirective("thermo-nuclear", "zh");
    expect(result.length).toBeGreaterThan(0);
  });

  it("thermo-nuclear EN directive contains [thermo] marker", () => {
    const result = buildProfileDirective("thermo-nuclear", "en");
    expect(result).toContain(THERMO_MARKER);
  });

  it("thermo-nuclear ZH directive contains [thermo] marker", () => {
    const result = buildProfileDirective("thermo-nuclear", "zh");
    expect(result).toContain(THERMO_MARKER);
  });

  it("thermo-nuclear EN directive contains rubric content (code-judo)", () => {
    const result = buildProfileDirective("thermo-nuclear", "en");
    expect(result).toContain("simplif");
  });

  it("thermo-nuclear directive does NOT contain thermo content when profile is default", () => {
    const en = buildProfileDirective("default", "en");
    const zh = buildProfileDirective("default", "zh");
    expect(en).not.toContain("[thermo]");
    expect(zh).not.toContain("[thermo]");
  });
});

// ---------------------------------------------------------------------------
// Task 2.1 RED: Profile ladder composition
// ---------------------------------------------------------------------------

describe("buildProfileDirective — YAGNI ladder (task 2.1 RED)", () => {
  // -- default: exact empty string -----------------------------------------

  it("returns empty string for 'default' profile in EN", () => {
    const result = buildProfileDirective("default", "en");
    expect(result).toBe("");
  });

  it("returns empty string for 'default' profile in ZH", () => {
    const result = buildProfileDirective("default", "zh");
    expect(result).toBe("");
  });

  // -- basic: rungs 1-3 advisory -------------------------------------------

  it("returns non-empty string for 'basic' profile (en)", () => {
    const result = buildProfileDirective("basic", "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for 'basic' profile (zh)", () => {
    const result = buildProfileDirective("basic", "zh");
    expect(result.length).toBeGreaterThan(0);
  });

  it("'basic' EN directive mentions rung 1 (need to exist)", () => {
    const result = buildProfileDirective("basic", "en");
    // Rung 1 asks "need to exist?" → tags: delete, yagni
    expect(result.toLowerCase()).toContain("delete");
    expect(result.toLowerCase()).toContain("yagni");
  });

  it("'basic' ZH directive mentions rung 1 (need to exist)", () => {
    const result = buildProfileDirective("basic", "zh");
    // Rung 1 asks "need to exist?" — tag annotation uses English tag names (language-agnostic)
    expect(result.length).toBeGreaterThan(0);
    // ZH question text is in Chinese (not English)
    expect(result).toContain("是否必须存在");
  });

  it("'basic' EN directive mentions rung 2 (codebase reuse)", () => {
    const result = buildProfileDirective("basic", "en");
    expect(result.toLowerCase()).toContain("reuse");
    expect(result.toLowerCase()).toContain("yagni");
    expect(result.toLowerCase()).toContain("shrink");
  });

  it("'basic' EN directive mentions rung 3 (stdlib)", () => {
    const result = buildProfileDirective("basic", "en");
    expect(result.toLowerCase()).toContain("stdlib");
  });

  it("'basic' directive uses advisory posture wording", () => {
    const en = buildProfileDirective("basic", "en");
    const zh = buildProfileDirective("basic", "zh");
    // Advisory posture: explicit "advisory" keyword in heading and "consider" in sub-text
    expect(en).toContain("advisory");
    expect(en).toContain("consider");
    expect(zh).toContain("建议");
    expect(zh).toContain("考量");
  });

  it("'basic' directive does NOT emit [thermo]", () => {
    const en = buildProfileDirective("basic", "en");
    const zh = buildProfileDirective("basic", "zh");
    expect(en).not.toContain(THERMO_MARKER);
    expect(zh).not.toContain(THERMO_MARKER);
  });

  // -- medium: rungs 1-5 enforced -----------------------------------------

  it("returns non-empty string for 'medium' profile (en)", () => {
    const result = buildProfileDirective("medium", "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for 'medium' profile (zh)", () => {
    const result = buildProfileDirective("medium", "zh");
    expect(result.length).toBeGreaterThan(0);
  });

  it("'medium' EN directive mentions rung 4 (native)", () => {
    const result = buildProfileDirective("medium", "en");
    expect(result.toLowerCase()).toContain("native");
  });

  it("'medium' EN directive mentions rung 5 (installed dependency)", () => {
    const result = buildProfileDirective("medium", "en");
    expect(result.toLowerCase()).toContain("stdlib");
    expect(result.toLowerCase()).toContain("dependency");
  });

  it("'medium' directive uses enforced/posture wording", () => {
    const en = buildProfileDirective("medium", "en");
    const zh = buildProfileDirective("medium", "zh");
    // Enforced posture: explicit "enforced" keyword in heading and mandatory-language body
    expect(en).toContain("enforced");
    expect(en).toMatch(/\bmust\b/);
    expect(zh).toContain("强制");
    expect(zh).toMatch(/必须/);
  });

  it("'medium' directive does NOT emit [thermo]", () => {
    const en = buildProfileDirective("medium", "en");
    const zh = buildProfileDirective("medium", "zh");
    expect(en).not.toContain(THERMO_MARKER);
    expect(zh).not.toContain(THERMO_MARKER);
  });

  // -- thermo-nuclear: rungs 1-7 + thermo rubric + [thermo] ---------------

  it("returns non-empty string for 'thermo-nuclear' (en)", () => {
    const result = buildProfileDirective("thermo-nuclear", "en");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns non-empty string for 'thermo-nuclear' (zh)", () => {
    const result = buildProfileDirective("thermo-nuclear", "zh");
    expect(result.length).toBeGreaterThan(0);
  });

  it("'thermo-nuclear' directive contains [thermo] marker", () => {
    const en = buildProfileDirective("thermo-nuclear", "en");
    const zh = buildProfileDirective("thermo-nuclear", "zh");
    expect(en).toContain(THERMO_MARKER);
    expect(zh).toContain(THERMO_MARKER);
  });

  it("'thermo-nuclear' directive contains thermo rubric content", () => {
    const en = buildProfileDirective("thermo-nuclear", "en");
    expect(en).toContain("Thermo-Nuclear");
    expect(en).toContain("simplif");
  });

  it("'thermo-nuclear' directive mentions rung 6 (one-liner / shrink)", () => {
    const result = buildProfileDirective("thermo-nuclear", "en");
    expect(result.toLowerCase()).toContain("shrink");
  });

  it("'thermo-nuclear' directive mentions rung 7 (safety fallback)", () => {
    const result = buildProfileDirective("thermo-nuclear", "en");
    // Rung 7 is the safety fallback baseline — look for functional safety
    expect(result.toLowerCase()).toContain("safety");
  });

  // -- tag boundary: only existing SIMPLIFICATION_TAGS are referenced ------

  it("'basic' directive does not introduce new tags", () => {
    const en = buildProfileDirective("basic", "en");
    const zh = buildProfileDirective("basic", "zh");
    // Must not contain tags outside delete, yagni, shrink, stdlib, native
    // Use word-boundary-aware check to avoid substring hits (e.g. "remove" hits "move")
    const hasForbiddenEn = /\bextract\b|\brefactor\b|\binline\b|\bmove\b/.test(
      en,
    );
    expect(hasForbiddenEn).toBe(false);
    // ZH forbidden: 提取(refactor), 移动(move), 内联(inline) — not in Chinese question text
    expect(zh).not.toContain("提取");
    expect(zh).not.toContain("移动");
    expect(zh).not.toContain("内联");
  });

  it("'medium' directive does not introduce new tags", () => {
    const en = buildProfileDirective("medium", "en");
    expect(en).not.toContain("extract");
    expect(en).not.toContain("inline");
  });

  it("'thermo-nuclear' directive does not introduce new tags beyond rubric", () => {
    const en = buildProfileDirective("thermo-nuclear", "en");
    // Word-boundary-aware to avoid "remove" hitting "move"
    const hasForbidden = /\bextract\b|\binline\b|\bmove\b/.test(en);
    expect(hasForbidden).toBe(false);
  });

  // -- bilingual: EN and ZH differ -----------------------------------------

  it("EN and ZH outputs differ for 'basic'", () => {
    const en = buildProfileDirective("basic", "en");
    const zh = buildProfileDirective("basic", "zh");
    expect(en).not.toBe(zh);
  });

  it("EN and ZH outputs differ for 'medium'", () => {
    const en = buildProfileDirective("medium", "en");
    const zh = buildProfileDirective("medium", "zh");
    expect(en).not.toBe(zh);
  });

  it("EN and ZH outputs differ for 'thermo-nuclear'", () => {
    const en = buildProfileDirective("thermo-nuclear", "en");
    const zh = buildProfileDirective("thermo-nuclear", "zh");
    expect(en).not.toBe(zh);
  });
});

describe("THERMO_MARKER", () => {
  it("equals '[thermo]'", () => {
    expect(THERMO_MARKER).toBe("[thermo]");
  });
});
