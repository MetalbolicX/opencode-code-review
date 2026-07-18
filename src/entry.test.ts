import { describe, expect, it, vi } from "vitest";

vi.mock("./index.ts", () => ({
  default: vi.fn(async () => ({
    config: vi.fn(),
    tool: {},
    event: vi.fn(),
  })),
}));

describe("plugin entry", () => {
  it("exports the V1 descriptor shape opencode expects", async () => {
    const entry = (await import("./entry.ts")).default as {
      id: unknown;
      server: unknown;
    };

    expect(entry).toBeTypeOf("object");
    expect(entry).not.toBeNull();
    expect(entry.id).toBe("opencode-code-review");
    expect(typeof entry.server).toBe("function");
  });

  it("does not re-export helper functions that would break the legacy loader path", async () => {
    const mod = (await import("./entry.ts")) as Record<string, unknown>;

    expect(Object.keys(mod)).toEqual(["default"]);
  });
});