// ---------------------------------------------------------------------------
// src/cli/main.test.ts — Unit tests for the async `ocr` CLI dispatcher.
//
// `runMain` is now async and returns `Promise<MainResult>`. Tests `await`
// every call. Command runners are mocked via vi.mock so the tests are pure
// dispatch logic — no real fs, no real config, no real spawn.
//
// Task 2.3 RED tests:
//   - Bare `ocr` (no command) → routes to install (not exit 2)
//   - Unknown command → exit 2
//   - `--help`/`-h` → exit 0, shows all 5 commands
//   - Install dispatches with correct options
//   - Uninstall dispatches with correct options
//   - Status dispatches correctly
//   - Awaited I/O rejection → exit 1
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Declare mock functions at module scope — hoisted by vi.mock
const mockRunInstall = vi.fn<() => Promise<{ status: "wrote" | "skipped"; specifier: string }>>();
const mockRunUninstall = vi.fn<() => Promise<{ status: "wrote" | "planned" | "noop"; path: string; removed: string[]; purged: string[] }>>();
const mockRunStatus = vi.fn<() => Promise<{ installed: boolean; path: string; format: "json" | "jsonc"; specifier: string | null; extras: string[] }>>();

vi.mock("./install.ts", () => ({
  runInstall: mockRunInstall,
}));

vi.mock("./uninstall.ts", () => ({
  runUninstall: mockRunUninstall,
}));

vi.mock("./status.ts", () => ({
  runStatus: mockRunStatus,
}));

const { runMain } = await import("./main.ts");

let savedExit: number;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedExit = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = 0;
  mockRunInstall.mockReset();
  mockRunUninstall.mockReset();
  mockRunStatus.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = savedExit;
  vi.restoreAllMocks();
});

describe("runMain (async dispatcher)", () => {
  // Task 2.3 RED: Bare `ocr` (no command) → routes to install (not exit 2)
  it("bare ocr with no command routes to install and exits 0", async () => {
    mockRunInstall.mockResolvedValue({ status: "wrote", specifier: "opencode-code-review" });
    const r = await runMain([]);
    expect(r.command).toBe("install");
    expect(r.exitCode).toBe(0);
    expect(mockRunInstall).toHaveBeenCalledTimes(1);
  });

  // Task 2.3 RED: Unknown command → exit 2
  it("unknown command returns exit 2", async () => {
    const r = await runMain(["frobnicate"]);
    expect(r.command).toBeNull();
    expect(r.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown command"),
    );
  });

  // Task 2.3 RED: `--help` → exit 0, shows all 5 commands
  it("--help shows usage and exits 0", async () => {
    const r = await runMain(["--help"]);
    expect(r.command).toBe("help");
    expect(r.exitCode).toBe(0);
    const usageCall = logSpy.mock.calls[0]?.[0] as string;
    expect(usageCall).toContain("Usage: ocr");
    expect(usageCall).toContain("install");
    expect(usageCall).toContain("uninstall");
    expect(usageCall).toContain("status");
    expect(usageCall).toContain("doctor");
    expect(usageCall).toContain("update");
  });

  // Task 2.3 RED: `-h` → exit 0
  it("-h shows usage and exits 0", async () => {
    const r = await runMain(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: ocr"));
  });

  // Task 2.3 RED: Install dispatches with correct options
  it("install command dispatches with correct options", async () => {
    mockRunInstall.mockResolvedValue({ status: "wrote", specifier: "opencode-code-review" });
    const r = await runMain(["install"]);
    expect(r.command).toBe("install");
    expect(r.exitCode).toBe(0);
    expect(mockRunInstall).toHaveBeenCalledTimes(1);
  });

  it("install --version forwards version option", async () => {
    mockRunInstall.mockResolvedValue({ status: "wrote", specifier: "opencode-code-review@1.2.3" });
    const r = await runMain(["install", "--version", "1.2.3"]);
    expect(r.command).toBe("install");
    expect(r.exitCode).toBe(0);
    expect(mockRunInstall).toHaveBeenCalledWith(
      expect.objectContaining({ version: "1.2.3" }),
    );
  });

  it("install --latest sets version to latest", async () => {
    mockRunInstall.mockResolvedValue({ status: "wrote", specifier: "opencode-code-review" });
    await runMain(["install", "--latest"]);
    expect(mockRunInstall).toHaveBeenCalledWith(
      expect.objectContaining({ version: "latest" }),
    );
  });

  it("install --dry-run forwards dryRun option", async () => {
    mockRunInstall.mockResolvedValue({ status: "skipped", specifier: "opencode-code-review" });
    await runMain(["install", "--dry-run"]);
    expect(mockRunInstall).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  // Task 2.3 RED: Uninstall dispatches with correct options
  it("uninstall command dispatches and exits 0", async () => {
    mockRunUninstall.mockResolvedValue({ status: "wrote", path: "/x", removed: [], purged: [] });
    const r = await runMain(["uninstall"]);
    expect(r.command).toBe("uninstall");
    expect(r.exitCode).toBe(0);
    expect(mockRunUninstall).toHaveBeenCalledTimes(1);
  });

  it("uninstall --purge forwards purge option", async () => {
    mockRunUninstall.mockResolvedValue({ status: "wrote", path: "/x", removed: [], purged: [] });
    await runMain(["uninstall", "--purge"]);
    expect(mockRunUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ purge: true }),
    );
  });

  it("uninstall --dry-run forwards dryRun option", async () => {
    mockRunUninstall.mockResolvedValue({ status: "planned", path: "/x", removed: [], purged: [] });
    await runMain(["uninstall", "--dry-run"]);
    expect(mockRunUninstall).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });

  // Task 2.3 RED: Status dispatches correctly
  it("status command dispatches and exits 0", async () => {
    mockRunStatus.mockResolvedValue({
      installed: true,
      path: "/x",
      format: "json",
      specifier: "opencode-code-review",
      extras: [],
    });
    const r = await runMain(["status"]);
    expect(r.command).toBe("status");
    expect(r.exitCode).toBe(0);
    expect(mockRunStatus).toHaveBeenCalledTimes(1);
  });

  // Task 2.3 RED: Awaited I/O rejection → exit 1
  it("returns exit 1 when install rejects", async () => {
    mockRunInstall.mockRejectedValue(new Error("spawn failed"));
    const r = await runMain(["install"]);
    expect(r.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("spawn failed"));
  });

  it("returns exit 1 when uninstall rejects", async () => {
    mockRunUninstall.mockRejectedValue(new Error("config locked"));
    const r = await runMain(["uninstall"]);
    expect(r.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("config locked"));
  });

  it("returns exit 1 when status rejects", async () => {
    mockRunStatus.mockRejectedValue(new Error("malformed JSON"));
    const r = await runMain(["status"]);
    expect(r.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
  });
});
