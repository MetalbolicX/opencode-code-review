// ---------------------------------------------------------------------------
// src/cli/install.test.ts — Unit tests for `ocr install` (async spawn-delegator).
//
// `runInstall` is now an async function that delegates plugin registration
// to `opencode plugin <specifier> --global` via a `ProcessRunner` seam.
// Tests inject a fake runner to assert exact argv and behaviour; no config
// file is ever written and no real subprocess is spawned.
//
// Tests removed (install no longer touches config):
//   - In-memory CliFs config-mutation tests
//   - noop/path/backup result fields
//
// Task 2.1 RED tests:
//   - Default bare install: spawns opencode plugin opencode-code-review --global
//   - Version pin (--version 2.0.0): spawns opencode plugin opencode-code-review@2.0.0 --global
//   - --latest: spawns bare specifier
//   - --dry-run: prints planned command, returns status "skipped", zero spawn calls
//   - Spawn failure (nonzero exit or missing executable): throws error, no config write
//   - Spawn injection: tests inject a mock ProcessRunner to assert exact argv
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "./spawn.ts";
import { PLUGIN_NAME } from "./config.ts";
import { runInstall } from "./install.ts";

// ---------------------------------------------------------------------------
// Fake process runner
// ---------------------------------------------------------------------------

const createFakeRunner = (
  results: Partial<ProcessResult>[] = [],
): ProcessRunner & { runCount: number[] } => {
  const callCount: number[] = [];
  const runner: ProcessRunner & { runCount: number[] } = {
    runCount: callCount,
    run: vi.fn(async (_executable, _args) => {
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

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = "/home/test";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("runInstall", () => {
  // Task 2.1 RED: Default bare install — spawns opencode plugin opencode-code-review --global
  it("spawns opencode plugin opencode-code-review --global", async () => {
    const runner = createFakeRunner([{ status: 0 }]);
    const r = await runInstall({ spawn: runner });
    expect(r.status).toBe("wrote");
    expect(r.specifier).toBe(PLUGIN_NAME);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      PLUGIN_NAME,
      "--global",
    ]);
  });

  // Task 2.1 RED: Version pin — --version 2.0.0 spawns with version suffix
  it("spawns with version suffix when --version is given", async () => {
    const runner = createFakeRunner([{ status: 0 }]);
    const r = await runInstall({ version: "2.0.0", spawn: runner });
    expect(r.status).toBe("wrote");
    expect(r.specifier).toBe(`${PLUGIN_NAME}@2.0.0`);
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      `${PLUGIN_NAME}@2.0.0`,
      "--global",
    ]);
  });

  // Task 2.1 RED: --latest flag spawns bare specifier (latest version from npm)
  it("--latest spawns bare specifier", async () => {
    const runner = createFakeRunner([{ status: 0 }]);
    const r = await runInstall({ version: "latest", spawn: runner });
    expect(r.status).toBe("wrote");
    expect(r.specifier).toBe(PLUGIN_NAME);
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      PLUGIN_NAME,
      "--global",
    ]);
  });

  // Task 2.1 RED: --dry-run prints planned command, returns status "skipped", zero spawn calls
  it("dry-run prints planned command and returns status skipped with zero spawn calls", async () => {
    const runner = createFakeRunner([]);
    const r = await runInstall({ dryRun: true, spawn: runner });
    expect(r.status).toBe("skipped");
    expect(r.specifier).toBe(PLUGIN_NAME);
    expect(runner.run).toHaveBeenCalledTimes(0);
  });

  // Task 2.1 RED: --dry-run with version prints the pinned specifier
  it("dry-run with version prints the pinned specifier", async () => {
    const runner = createFakeRunner([]);
    const logSpy = vi.spyOn(console, "log");
    const r = await runInstall({ version: "2.0.0", dryRun: true, spawn: runner });
    expect(r.status).toBe("skipped");
    expect(r.specifier).toBe(`${PLUGIN_NAME}@2.0.0`);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${PLUGIN_NAME}@2.0.0`),
    );
    expect(runner.run).toHaveBeenCalledTimes(0);
  });

  // Task 2.1 RED: Spawn failure — nonzero exit throws error, no config write
  it("throws when spawn returns nonzero exit", async () => {
    const runner = createFakeRunner([{ status: 1, stderr: "plugin registration failed" }]);
    await expect(runInstall({ spawn: runner })).rejects.toThrow(
      "plugin registration failed",
    );
    // Spawn was called once but the install did not succeed
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 2.1 RED: Spawn failure — missing executable throws clear error
  it("throws when opencode executable is missing", async () => {
    const runner = createFakeRunner([{ missing: true, stderr: "executable not found" }]);
    await expect(runInstall({ spawn: runner })).rejects.toThrow(
      "executable not found",
    );
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 2.1 RED: Spawn injection — assert exact argv
  it("passes exact argv to the injected runner", async () => {
    const runner = createFakeRunner([{ status: 0 }]);
    await runInstall({ version: "3.1.4", spawn: runner });
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      `${PLUGIN_NAME}@3.1.4`,
      "--global",
    ]);
  });
});
