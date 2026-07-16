import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./config.ts";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("./rule-files.ts", () => ({
  KNOWN_DIMENSIONS: new Set([
    "code-quality",
    "security",
    "performance",
    "testing",
    "documentation",
    "error-handling",
    "api-design",
    "dependencies",
    "maintainability",
  ]),
  loadRuleFiles: vi.fn().mockReturnValue([]),
}));

const { readFile } = await import("node:fs/promises");

const defaultConfig = {
  language: "zh",
  dimensions: [
    "code-quality",
    "security",
    "performance",
    "testing",
    "documentation",
  ],
  max_diff_lines: 500,
  trigger: { auto_on_idle: false, cooldown_seconds: 120 },
  custom_rules: [] as string[],
  file_rules: [] as unknown as never[],
  parallel: true,
  intensity: "full" as const,
  profile: "default" as const,
};

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns default config when no config files exist", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
  });

  it("global config overrides defaults", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ language: "en" }))
      .mockRejectedValue(new Error("ENOENT"));
    const config = await loadConfig("/fake/project");
    expect(config.language).toBe("en");
    expect(config.dimensions).toEqual(defaultConfig.dimensions);
  });

  it("project config overrides global config", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ language: "en" }))
      .mockResolvedValueOnce(JSON.stringify({ language: "zh" }));
    const config = await loadConfig("/fake/project");
    expect(config.language).toBe("zh");
  });

  it("nested trigger merges correctly (global auto_on_idle + project cooldown_seconds)", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(
        JSON.stringify({ trigger: { auto_on_idle: true } }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ trigger: { cooldown_seconds: 60 } }),
      );
    const config = await loadConfig("/fake/project");
    expect(config.trigger.auto_on_idle).toBe(true);
    expect(config.trigger.cooldown_seconds).toBe(60);
  });

  it("malformed JSON falls back safely without throwing", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce("not valid json {")
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("malformed config JSON"),
    );
  });

  it("warns and falls back when the config root is not an object", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce('["not", "an", "object"]')
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("config root must be a JSON object"),
    );
  });

  it("missing config file applies defaults silently (no warning)", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("partial config merges without losing unrelated default fields", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ max_diff_lines: 1000 }))
      .mockRejectedValue(new Error("ENOENT"));
    const config = await loadConfig("/fake/project");
    expect(config.max_diff_lines).toBe(1000);
    expect(config.language).toBe(defaultConfig.language);
    expect(config.dimensions).toEqual(defaultConfig.dimensions);
    expect(config.trigger).toEqual(defaultConfig.trigger);
  });

  // -- intensity normalization -------------------------------------------------
  // The spec says intensity must default to `full`, accept `lite`/`full`/`ultra`,
  // and normalize any other/missing value to `full`. These tests pin all four.

  it("intensity defaults to 'full' when no config files exist", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const config = await loadConfig("/fake/project");
    expect(config.intensity).toBe("full");
  });

  it("global config intensity is applied when project is missing", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ intensity: "lite" }))
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    const config = await loadConfig("/fake/project");
    expect(config.intensity).toBe("lite");
  });

  it("project config intensity overrides global", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ intensity: "lite" }))
      .mockResolvedValueOnce(JSON.stringify({ intensity: "ultra" }));
    const config = await loadConfig("/fake/project");
    expect(config.intensity).toBe("ultra");
  });

  it("invalid intensity value in project config falls back to 'full'", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ intensity: "extreme" }))
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    const config = await loadConfig("/fake/project");
    expect(config.intensity).toBe("full");
  });

  it("missing intensity field in both configs resolves to 'full'", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ language: "en" }))
      .mockResolvedValueOnce(JSON.stringify({ dimensions: ["security"] }));
    const config = await loadConfig("/fake/project");
    expect(config.intensity).toBe("full");
  });

  it("intensity normalization accepts every valid literal", async () => {
    const expected: Record<"lite" | "full" | "ultra", string> = {
      lite: "lite",
      full: "full",
      ultra: "ultra",
    };
    for (const [value, want] of Object.entries(expected)) {
      vi.mocked(readFile).mockReset();
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify({ intensity: value }))
        .mockRejectedValue(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
      const config = await loadConfig("/fake/project");
      expect(config.intensity).toBe(want);
    }
  });

  // -- profile normalization -------------------------------------------------
  // The spec says profile must default to "default", accept "default"/"thermo-nuclear",
  // and normalize any other/missing value to "default". These tests pin all four.

  it("profile defaults to 'default' when no config files exist", async () => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const config = await loadConfig("/fake/project");
    expect(config.profile).toBe("default");
  });

  it("global config profile is applied when project is missing", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ profile: "thermo-nuclear" }))
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    const config = await loadConfig("/fake/project");
    expect(config.profile).toBe("thermo-nuclear");
  });

  it("project config profile overrides global", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ profile: "thermo-nuclear" }))
      .mockResolvedValueOnce(JSON.stringify({ profile: "default" }));
    const config = await loadConfig("/fake/project");
    expect(config.profile).toBe("default");
  });

  it("invalid profile value in project config falls back to 'default'", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ profile: "extreme" }))
      .mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    const config = await loadConfig("/fake/project");
    expect(config.profile).toBe("default");
  });

  it("invalid profile value in global config falls back to 'default'", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ profile: "ultra-aggressive" }))
      .mockResolvedValueOnce(JSON.stringify({}));
    const config = await loadConfig("/fake/project");
    expect(config.profile).toBe("default");
  });

  it("missing profile field in both configs resolves to 'default'", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce(JSON.stringify({ language: "en" }))
      .mockResolvedValueOnce(JSON.stringify({ dimensions: ["security"] }));
    const config = await loadConfig("/fake/project");
    expect(config.profile).toBe("default");
  });

  it("profile normalization accepts every valid literal", async () => {
    const expected: Record<"default" | "thermo-nuclear", string> = {
      default: "default",
      "thermo-nuclear": "thermo-nuclear",
    };
    for (const [value, want] of Object.entries(expected)) {
      vi.mocked(readFile).mockReset();
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify({ profile: value }))
        .mockRejectedValue(
          Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
      const config = await loadConfig("/fake/project");
      expect(config.profile).toBe(want);
    }
  });
});
