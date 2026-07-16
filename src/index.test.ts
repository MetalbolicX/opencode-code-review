import { describe, it, expect, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";
import opencodeReview, { extractSessionId } from "./index.ts";

const { loadConfig } = await import("./config.ts");

vi.mock("./config.ts", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    language: "zh",
    dimensions: ["code-quality"],
    max_diff_lines: 500,
    trigger: { auto_on_idle: false, cooldown_seconds: 120 },
    custom_rules: [],
    file_rules: [],
    parallel: true,
    intensity: "full",
    profile: "default",
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

describe("session.idle failure retry", () => {
  it("a failed promptAsync does not consume the cooldown (next idle retries)", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 500,
      trigger: { auto_on_idle: true, cooldown_seconds: 120 },
      custom_rules: [],
      file_rules: [],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const promptAsync = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({});
    const ctx = {
      project: "",
      client: { session: { promptAsync } },
      $: vi.fn(),
      directory: "/fake",
      worktree: "",
      experimental_workspace: "",
      serverUrl: "",
    } as unknown as Parameters<typeof opencodeReview>[0];

    vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = await opencodeReview(ctx);

    const idleEvent = {
      event: {
        type: "session.idle",
        properties: { sessionID: "sess-1" },
        id: "sess-1",
      },
    };

    await plugin.event?.(idleEvent as any);
    expect(promptAsync).toHaveBeenCalledTimes(1);

    await plugin.event?.(idleEvent as any);
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });
});

describe("parallel review:dim-* rule threading", () => {
  it("registers a review:dim-* prompt containing configured file rule body text", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 500,
      trigger: { auto_on_idle: false, cooldown_seconds: 120 },
      custom_rules: [],
      file_rules: [
        {
          path: "/x.md",
          scope: "project",
          dimensions: [],
          body: "NEVER_USE_DEPRECATED_API",
        },
      ],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const result = await opencodeReview(makeFakeContext());

    // biome-ignore lint: openCodeConfig is a plugin-internal mutable contract
    const openCodeConfig: Record<string, any> = {};
    result.config?.(openCodeConfig);

    expect(openCodeConfig.agent["review:dim-code-quality"].prompt).toContain(
      "NEVER_USE_DEPRECATED_API",
    );
  });
});

describe("custom_rules threading into dimension prompts", () => {
  it("registers a review:dim-* prompt containing configured custom rule text", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 500,
      trigger: { auto_on_idle: false, cooldown_seconds: 120 },
      custom_rules: [
        "All API endpoints must implement retry logic with exponential backoff",
      ],
      file_rules: [],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const result = await opencodeReview(makeFakeContext());

    // biome-ignore lint: openCodeConfig is a plugin-internal mutable contract
    const openCodeConfig: Record<string, any> = {};
    result.config?.(openCodeConfig);

    expect(openCodeConfig.agent["review:dim-code-quality"].prompt).toContain(
      "All API endpoints must implement retry logic with exponential backoff",
    );
  });

  it("threads multiple custom rules into dimension prompts", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "en",
      dimensions: ["code-quality", "security"],
      max_diff_lines: 500,
      trigger: { auto_on_idle: false, cooldown_seconds: 120 },
      custom_rules: [
        "Rule one: no console.log in production",
        "Rule two: all functions must have JSDoc",
      ],
      file_rules: [],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const result = await opencodeReview(makeFakeContext());

    // biome-ignore lint: openCodeConfig is a plugin-internal mutable contract
    const openCodeConfig: Record<string, any> = {};
    result.config?.(openCodeConfig);

    expect(openCodeConfig.agent["review:dim-code-quality"].prompt).toContain(
      "Rule one: no console.log in production",
    );
    expect(openCodeConfig.agent["review:dim-code-quality"].prompt).toContain(
      "Rule two: all functions must have JSDoc",
    );
  });
});

// ---------------------------------------------------------------------------
// review_changes bound to configured max_diff_lines (plan 016)
//
// The factory wraps the singleton so the plugin can hand its
// `config.max_diff_lines` value into the registered tool. Behavioural
// coverage asserts that the registered tool's execute function honours the
// configured default — a regression here would let the broken singleton
// pattern silently reappear.
// ---------------------------------------------------------------------------

const longDiffForIndex = Array.from(
  { length: 100 },
  (_, i) => `LINE_${i}`,
).join("\n");

const buildFakeShellForTool = () => {
  const responses = [
    { ok: true, stdout: longDiffForIndex },
    { ok: true, stdout: " foo | 100 +" },
  ];
  // biome-ignore lint/suspicious/noExplicitAny: tagged-template shell fake — quiet() chain
  const shellFn: any = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    let _cmd = "";
    for (let i = 0; i < strings.length; i++) {
      _cmd += strings[i];
      if (i < values.length) _cmd += String(values[i]);
    }
    const response = responses.shift() ?? { ok: true, stdout: "" };
    // biome-ignore lint/suspicious/noExplicitAny: shell promise chain in fake
    const p = Promise.resolve(response) as any;
    p.quiet = () => p;
    return p;
  };
  return shellFn;
};

describe("plugin — review_changes max_diff_lines binding", () => {
  it("registers review_changes with the configured max_diff_lines as default", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 25,
      trigger: { auto_on_idle: false, cooldown_seconds: 120 },
      custom_rules: [],
      file_rules: [],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const plugin = await opencodeReview(makeFakeContext());
    const tool = plugin.tool?.review_changes;
    expect(tool).toBeDefined();
    expect(typeof (tool as unknown as { execute?: unknown }).execute).toBe(
      "function",
    );

    const $ = buildFakeShellForTool();
    // biome-ignore lint: ToolDefinition.execute is the plugin seam under test
    const out = await (tool as any).execute({ scope: "staged" }, { $ } as any);

    // 100-line diff gets truncated at the configured 25-line default.
    expect(out).toContain("LINE_0");
    expect(out).not.toContain("LINE_50");
    expect(out).toContain("truncated at 25 lines");
  });

  it("explicit max_lines argument on review_changes still overrides the bound default", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 25,
      trigger: { auto_on_idle: false, cooldown_seconds: 120 },
      custom_rules: [],
      file_rules: [],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const plugin = await opencodeReview(makeFakeContext());
    const tool = plugin.tool?.review_changes;

    const $ = buildFakeShellForTool();
    // biome-ignore lint: ToolDefinition.execute is the plugin seam under test
    const out = await (tool as any).execute(
      { scope: "staged", max_lines: 10 },
      // biome-ignore lint/suspicious/noExplicitAny: shell-only test context
      { $ } as any,
    );
    expect(out).toContain("LINE_0");
    expect(out).not.toContain("LINE_50");
    expect(out).toContain("truncated at 10 lines");
  });
});

// ---------------------------------------------------------------------------
// Session ID extraction (Phase B1)
// ---------------------------------------------------------------------------

describe("extractSessionId", () => {
  it("returns sessionID from properties.sessionID", () => {
    const event = {
      type: "session.idle",
      properties: { sessionID: "sess-abc123", id: "legacy-id" },
      id: "top-level-id",
    } as SessionIdleEvent;
    const result = extractSessionId(event);
    expect(result).toBe("sess-abc123");
  });

  it("falls back to properties.id when sessionID is absent", () => {
    const event = {
      type: "session.idle",
      properties: { id: "legacy-id" },
      id: "top-level-id",
    } as SessionIdleEvent;
    const result = extractSessionId(event);
    expect(result).toBe("legacy-id");
  });

  it("falls back to top-level id when properties is absent", () => {
    const event = {
      type: "session.idle",
      id: "top-level-id",
    } as SessionIdleEvent;
    const result = extractSessionId(event);
    expect(result).toBe("top-level-id");
  });

  it("returns undefined when no ID is present", () => {
    const event = {
      type: "session.idle",
      properties: {},
    } as SessionIdleEvent;
    const result = extractSessionId(event);
    expect(result).toBeUndefined();
  });
});

interface SessionIdleEvent {
  type: string;
  properties?: { sessionID?: string; id?: string };
  id?: string;
}

// ---------------------------------------------------------------------------
// The extractSessionId helper is tested above; this section keeps the existing
// malformed-event cooldown guard tests.
// ---------------------------------------------------------------------------

describe("session.idle malformed event cooldown guard", () => {
  it("a malformed idle event does not consume cooldown (next valid event still triggers)", async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      language: "zh",
      dimensions: ["code-quality"],
      max_diff_lines: 500,
      trigger: { auto_on_idle: true, cooldown_seconds: 120 },
      custom_rules: [],
      file_rules: [],
      parallel: true,
      intensity: "full",
      profile: "default",
    });

    const promptAsync = vi.fn().mockResolvedValue({});
    const ctx = {
      project: "",
      client: { session: { promptAsync } },
      $: vi.fn(),
      directory: "/fake",
      worktree: "",
      experimental_workspace: "",
      serverUrl: "",
    } as unknown as Parameters<typeof opencodeReview>[0];

    const plugin = await opencodeReview(ctx);

    const malformedEvent = {
      event: {
        type: "session.idle",
      },
    };

    const validEvent = {
      event: {
        type: "session.idle",
        properties: { sessionID: "sess-valid" },
        id: "sess-valid",
      },
    };

    await plugin.event?.(malformedEvent as any);
    expect(promptAsync).not.toHaveBeenCalled();

    await plugin.event?.(validEvent as any);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "sess-valid" },
      }),
    );
  });
});
