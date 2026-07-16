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

describe("THERMO_MARKER", () => {
  it("equals '[thermo]'", () => {
    expect(THERMO_MARKER).toBe("[thermo]");
  });
});
