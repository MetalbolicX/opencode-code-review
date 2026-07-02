import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "./config.ts";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
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
  parallel: true,
};

describe("loadConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns default config when no config files exist", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));
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
      .mockRejectedValue(new Error("ENOENT"));
    const config = await loadConfig("/fake/project");
    expect(config).toEqual(defaultConfig);
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
});
