import { describe, it, expect, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import opencodeReview from "./index.ts";

vi.mock("./config.ts", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    language: "zh",
    dimensions: ["code-quality"],
    max_diff_lines: 500,
    trigger: { auto_on_idle: false, cooldown_seconds: 120 },
    custom_rules: [],
    file_rules: [],
    parallel: true,
  }),
}));

const makeFakeContext = (): PluginInput => {
  return {
    project: "",
    client: { session: { promptAsync: vi.fn() } },
    $: vi.fn(),
    directory: "/fake",
    worktree: "",
    experimental_workspace: "",
    serverUrl: "",
  } as unknown as PluginInput;
};

describe("plugin smoke test", () => {
  it("default export is a function (plugin factory)", () => {
    expect(typeof opencodeReview).toBe("function");
  });

  it("calling the factory returns an object with config, tool, and event keys", async () => {
    const result = await opencodeReview(makeFakeContext());
    expect(result).toHaveProperty("config");
    expect(result).toHaveProperty("tool");
    expect(result).toHaveProperty("event");
  });

  it("tool object contains review_changes and toggle_auto_review", async () => {
    const result = await opencodeReview(makeFakeContext());
    expect(result.tool).toHaveProperty("review_changes");
    expect(result.tool).toHaveProperty("toggle_auto_review");
  });

  it("config function registers review and review:auto commands", async () => {
    const result = await opencodeReview(makeFakeContext());
    // biome-ignore lint: openCodeConfig is a plugin-internal mutable contract
    const openCodeConfig: Record<string, any> = {};
    result.config?.(openCodeConfig);
    expect(openCodeConfig.agent).toHaveProperty("review");
    expect(openCodeConfig.command).toHaveProperty("review");
    expect(openCodeConfig.command).toHaveProperty("review:auto");
  });
});
