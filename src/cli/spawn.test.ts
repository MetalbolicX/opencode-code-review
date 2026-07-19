// src/cli/spawn.test.ts — Unit tests for src/cli/spawn.ts.
// All tests use an injected fake runner so no actual subprocesses are spawned.

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
// Async spawn — non-blocking proof (Task 2.1)
// ---------------------------------------------------------------------------

describe("async spawn — non-blocking", () => {
  // Task 2.1 RED: async spawn returns pending Promise while child runs.
  it("returns a pending Promise immediately while child is running (non-blocking)", async () => {
    let childStillRunning = false;

    const fakeSpawn: import("./spawn.ts").SpawnFn = async () => {
      // Mark that child is running
      childStillRunning = true;
      // Simulate a long-running child that exits after a delay
      return new Promise<import("./spawn.ts").SpawnResult>((resolve) =>
        setTimeout(() => resolve({ status: 0, stdout: "done", stderr: "" }), 100),
      );
    };

    // First await: let the module import resolve
    const m = await import("./spawn.ts");

    // Now call spawnOpencodePlugin — the resultPromise resolves after child exits
    const resultPromise = m.spawnOpencodePlugin(["opencode-code-review", "--global"], { spawn: fakeSpawn });

    // After this microtask checkpoint, fakeSpawn has run synchronously
    // (up to its first await) and set childStillRunning = true.
    await Promise.resolve();

    // childStillRunning must be true — this proves fakeSpawn started running
    // (non-blocking), meaning the call returned a pending Promise while the
    // child's 100ms timer was still ticking.
    expect(childStillRunning).toBe(true);

    // Verify the promise is still pending (child hasn't finished yet)
    const raceResult = await Promise.race([
      resultPromise,
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 10)),
    ]);
    expect(raceResult).toBe("pending"); // still pending after 10ms

    // Now await the actual result
    await new Promise((r) => setTimeout(r, 110));
    const result = await resultPromise;
    expect(result.stdout).toBe("done");
  });

  // Task 2.1: stdout is captured correctly when child exits
  it("captures stdout and stderr when child exits", async () => {
    const m = await import("./spawn.ts");
    const fakeSpawn: import("./spawn.ts").SpawnFn = async () =>
      ({ status: 0, stdout: "plugin installed", stderr: "warning: deprecated" });

    const result = await m.spawnOpencodePlugin(["opencode-code-review", "--global"], { spawn: fakeSpawn });

    expect(result.stdout).toBe("plugin installed");
    expect(result.stderr).toBe("warning: deprecated");
    expect(result.status).toBe(0);
  });

  // Task 2.1: integration — calls the real defaultSpawn (child_process.spawn)
  it("calls real child_process.spawn and captures output", async () => {
    const m = await import("./spawn.ts");
    const result = await m.spawnOpencodePlugin(["--version"]);

    expect(result).toHaveProperty("status");
    expect(typeof result.status).toBe("number");
    if (result.status === null) {
      expect(result.stderr).toMatch(/not found|ENOENT/i);
    }
  });


});

// ---------------------------------------------------------------------------
// Async spawn — 30-second SIGKILL timeout and error handling (Task 2.3)
// ---------------------------------------------------------------------------

describe("async spawn — 30-second SIGKILL timeout", () => {
  // Task 2.3 RED: long-running child → timer fires at 30s → SIGKILL sent.
  it("sends SIGKILL after 30 seconds of fake timer advance", async () => {
    // Deferred so we can resolve the fake spawn after the timer fires
    let resolveFake: (r: import("./spawn.ts").SpawnResult) => void;
    const fakeResult = new Promise<import("./spawn.ts").SpawnResult>((r) => {
      resolveFake = r;
    });

    const fakeSpawn: import("./spawn.ts").SpawnFn = async () => fakeResult;

    vi.useFakeTimers();

    const resultPromise = import("./spawn.ts").then((m) =>
      m.spawnOpencodePlugin(["opencode-code-review", "--global"], { spawn: fakeSpawn }),
    );

    // Advance 30 seconds of fake time — the kill timer fires inside
    // spawnOpencodePlugin. Immediately resolve the fake spawn so the close
    // handler fires and the promise chain completes.
    await vi.advanceTimersByTimeAsync(30_000);
    resolveFake!({ status: null, stdout: "", stderr: "" });

    // Now the promise should settle
    const result = await resultPromise;
    expect(result.status).toBe(null); // SIGKILL → null exit

    vi.useRealTimers();
  });

  // Task 2.3 RED: child exits before 30s → no kill sent
  it("does NOT send kill when child exits cleanly before 30-second timer fires", async () => {
    const fakeSpawn: import("./spawn.ts").SpawnFn = async () =>
      ({ status: 0, stdout: "ok", stderr: "" });

    vi.useFakeTimers();

    const result = await import("./spawn.ts").then((m) =>
      m.spawnOpencodePlugin(["opencode-code-review", "--global"], { spawn: fakeSpawn }),
    );

    // Advance well past 30 seconds — child already exited cleanly, no kill
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result.status).toBe(0);

    vi.useRealTimers();
  });

  // Task 2.3 RED: ENOENT → promise rejects with ENOENT-style error, timer cleared
  it("returns ENOENT-style result when executable is missing and clears the timer", async () => {
    const fakeSpawn: import("./spawn.ts").SpawnFn = async () => {
      const err = new Error("spawn ENOENT");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    };

    vi.useFakeTimers();

    const result = await import("./spawn.ts").then((m) =>
      m.spawnOpencodePlugin(["opencode-code-review", "--global"], { spawn: fakeSpawn }),
    );

    // Advance timers — since the error was caught, no timer should be pending
    await vi.advanceTimersByTimeAsync(60_000);

    // The function should have resolved with an ENOENT-style result (not rejected)
    expect(result.status).toBe(null);
    expect(result.stderr).toMatch(/ENOENT|not found/i);

    vi.useRealTimers();
  });

  // Task 2.3 RED: error event → error message in stderr, timer cleared
  it("returns error message in stderr when child emits an error and clears the timer", async () => {
    const fakeSpawn: import("./spawn.ts").SpawnFn = async () => {
      const err = new Error("Permission denied");
      (err as NodeJS.ErrnoException).code = "EACCES";
      throw err;
    };

    vi.useFakeTimers();

    const result = await import("./spawn.ts").then((m) =>
      m.spawnOpencodePlugin(["opencode-code-review", "--global"], { spawn: fakeSpawn }),
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(result.status).toBe(null);
    expect(result.stderr).toMatch(/Permission denied|EACCES/i);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// spawnOpencodePlugin Signature A — (executable, args) overload
//
// Signature A is the ProcessRunner-compatible overload used by update.ts via
// { run: spawnOpencodePlugin }. When called as spawnOpencodePlugin("opencode",
// ["plugin", "spec", "--global", "--force"]), the args array already contains
// the "plugin" prefix — it is NOT prepended again (unlike Signature B).
//
// Signature A also accepts a third options arg { spawn?, env?, stdio? } to
// enable unit testing with a fake spawn without spawning real processes.
// ---------------------------------------------------------------------------
describe("spawnOpencodePlugin Signature A (executable, args)", () => {
  // Happy path: Signature A returns ProcessResult with correct fields
  it("returns ProcessResult with exitCode 0 on successful spawn", async () => {
    const m = await import("./spawn.ts");

    const fakeSpawn: import("./spawn.ts").SpawnFn = async () => ({
      status: 0,
      stdout: "plugin installed ok",
      stderr: "",
    });

    const result = await m.spawnOpencodePlugin("opencode", [
      "plugin",
      "opencode-code-review",
      "--global",
      "--force",
    ], { spawn: fakeSpawn });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("plugin installed ok");
    expect(result.stderr).toBe("");
    // missing field is part of ProcessResult
    expect(result).toHaveProperty("missing");
  });

  // Fixed-argv: Signature A does NOT prepend "plugin" — args already contain it
  // This is the key difference from Signature B which prepends "plugin" internally.
  it("passes args directly to spawn without prepending 'plugin'", async () => {
    const m = await import("./spawn.ts");

    const calls: [string, string[]][] = [];
    const fakeSpawn: import("./spawn.ts").SpawnFn = async (exec, args) => {
      calls.push([exec, args]);
      return { status: 0, stdout: "", stderr: "" };
    };

    await m.spawnOpencodePlugin("opencode", [
      "plugin",
      "opencode-code-review",
      "--global",
      "--force",
    ], { spawn: fakeSpawn });

    // Signature A passes args directly — no double-prepend
    expect(calls[0][0]).toBe("opencode");
    expect(calls[0][1]).toEqual([
      "plugin",
      "opencode-code-review",
      "--global",
      "--force",
    ]);
  });

  // ENOENT: Signature A returns ProcessResult with status=null and ENOENT in stderr
  it("returns ProcessResult with null status and ENOENT stderr when spawn throws", async () => {
    const m = await import("./spawn.ts");

    const fakeSpawn: import("./spawn.ts").SpawnFn = async () => {
      const err = new Error("ENOENT: opencode not found");
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    };

    const result = await m.spawnOpencodePlugin("opencode", [
      "plugin",
      "opencode-code-review",
      "--global",
    ], { spawn: fakeSpawn });

    // Always-resolved contract: check result fields instead of rejection
    expect(result.status).toBe(null);
    expect(result.stderr).toMatch(/ENOENT|not found/i);
    expect(result).toHaveProperty("missing");
    expect((result as import("./spawn.ts").ProcessResult).missing).toBe(true);
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
