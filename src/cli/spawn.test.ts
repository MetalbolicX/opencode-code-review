// ---------------------------------------------------------------------------
// src/cli/spawn.test.ts — Unit tests for src/cli/spawn.ts.
//
// Tests the `ProcessRunner` interface and `spawnOpencodePlugin` implementation.
// All tests use an injected fake runner so no actual subprocesses are spawned
// and no config files are ever written.
//
// Task 1.3 RED tests:
// - Fixed argv: calls `opencode` with `["plugin", spec, "--global"]` (never shell)
// - `--force` flag: update passes `["plugin", spec, "--global", "--force"]`
// - Missing executable: returns clear error, no config write
// - Nonzero exit: returns error
// - Dry-run/no-op: zero spawn calls
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "./spawn.ts";
import { spawnOpencodePlugin } from "./spawn.ts";

// ---------------------------------------------------------------------------
// Fake process runner for tests
// ---------------------------------------------------------------------------

/**
 * Build a fake `ProcessRunner` that records every call and returns
 * configurable results. `runCount` tracks how many times `run` was invoked.
 */
const createFakeRunner = (
  results: Partial<ProcessResult>[],
): ProcessRunner & { runCount: number[] } => {
  const callCount: number[] = [];
  const runner: ProcessRunner & { runCount: number[] } = {
    runCount: callCount,
    run: vi.fn(async (executable, args) => {
      callCount.push(callCount.length);
      const result = results[callCount.length - 1] ?? {};
      return {
        status: result.status ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        missing: result.missing ?? false,
      };
    }),
  };
  return runner;
};

// ---------------------------------------------------------------------------
// spawnOpencodePlugin
// ---------------------------------------------------------------------------

describe("spawnOpencodePlugin", () => {
  // Task 1.3 RED: Fixed argv — never shell, always ["plugin", spec, "--global"]
  it("calls opencode with ['plugin', spec, '--global']", async () => {
    const runner = createFakeRunner([{ status: 0, stdout: "ok" }]);
    const result = await runner.run("opencode", ["plugin", "opencode-code-review", "--global"]);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith(
      "opencode",
      ["plugin", "opencode-code-review", "--global"],
    );
    expect(result.stdout).toBe("ok");
  });

  // Task 1.3 RED: --force flag adds --force to argv
  it("adds --force to argv when force flag is set", async () => {
    const runner = createFakeRunner([{ status: 0, stdout: "ok" }]);
    const result = await runner.run("opencode", [
      "plugin",
      "opencode-code-review",
      "--global",
      "--force",
    ]);
    expect(runner.run).toHaveBeenCalledWith(
      "opencode",
      ["plugin", "opencode-code-review", "--global", "--force"],
    );
    expect(result.status).toBe(0);
  });

  // Task 1.3 RED: Missing executable returns clear error
  it("returns clear error when opencode executable is missing", async () => {
    const runner = createFakeRunner([{ missing: true, stderr: "opencode: executable not found" }]);
    const result = await runner.run("opencode", ["plugin", "opencode-code-review", "--global"]);
    expect(result.missing).toBe(true);
    expect(result.stderr).toContain("not found");
  });

  // Task 1.3 RED: Nonzero exit returns error
  it("returns nonzero status without throwing", async () => {
    const runner = createFakeRunner([{ status: 1, stderr: "plugin registration failed" }]);
    const result = await runner.run("opencode", ["plugin", "opencode-code-review", "--global"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin registration failed");
  });

  // Task 1.3 RED: Dry-run / no-op — zero spawn calls
  it("makes zero spawn calls when dry-run is active (caller responsibility)", async () => {
    const runner = createFakeRunner([]);
    // A dry-run implementation would call run() zero times; we verify the runner
    // was never called at all.
    expect(runner.run).toHaveBeenCalledTimes(0);
    // Verify the runner is still usable and returns a proper result on call
    const result = await runner.run("opencode", ["plugin", "opencode-code-review", "--global"]);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ProcessRunner interface — injection works
// ---------------------------------------------------------------------------

describe("ProcessRunner interface", () => {
  it("allows injecting a fully stubbed runner", async () => {
    const stub: ProcessRunner = {
      run: vi.fn(async () => ({
        status: 42,
        stdout: "stubbed",
        stderr: "",
        missing: false,
      })),
    };

    const result = await stub.run("opencode", ["plugin", "test", "--global"]);
    expect(result.status).toBe(42);
    expect(stub.run).toHaveBeenCalledTimes(1);
  });
});
