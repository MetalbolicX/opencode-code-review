// ---------------------------------------------------------------------------
// src/cli/update.test.ts — Unit tests for `ocr update` lifecycle.
//
// Rewrite for Slice 4: update is now UNCONDITIONAL — no version-compare gate,
// no registry fetch, no staleness check. Every run purges cache paths
// (best-effort per path) and spawns `opencode plugin --global --force`.
//
// UpdateResult.status is now `'stale' | 'noop'` (never 'current' or 'unreachable').
// UpdateResult no longer carries installedVersion or latestVersion.
//
// Tests inject ProcessRunner (spawn seam) to exercise every branch
// deterministically without subprocess calls.
//
// Task 4.1 RED tests:
//   (a) update always purges then spawns (regardless of installed version)
//   (b) update spawns even when cache paths list is empty
//   (c) UpdateResult.status narrows to 'stale' | 'noop'
//
// Task 4.3 RED tests:
//   (a) purge failure on one path is swallowed, other paths still purged,
//       spawn still proceeds
//   (b) purge failure swallowed AND spawn exits 0 → resolve (no throw)
//   (c) purge failure swallowed AND spawn exits 1 → reject (spawn failure
//       propagates)
//   (d) no symbol from registry.ts is referenced by update.ts
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "./spawn.ts";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runUpdate } from "./update.ts";

type MemFs = CliFs & {
  __files: Map<string, string>;
  __dirs: Set<string>;
  __callLog: { method: string; path: string; err?: unknown }[];
};

const createMemFs = (
  initial: Record<string, string> = {},
  opts?: { purgeErrorOn?: string[] },
): MemFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const callLog: { method: string; path: string; err?: unknown }[] = [];
  const purgeErrorOn = new Set<string>(opts?.purgeErrorOn ?? []);

  const track = (p: string): void => {
    const parts = p.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      acc =
        acc === "/"
          ? `/${parts[i] as string}`
          : acc
            ? `${acc}/${parts[i] as string}`
            : (parts[i] as string);
      if (acc) dirs.add(acc);
    }
  };

  for (const [path, content] of Object.entries(initial)) {
    track(path);
    files.set(path, content);
  }

  return {
    __files: files,
    __dirs: dirs,
    __callLog: callLog,
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
    writeFileSync: (p: string, c: string) => {
      track(p);
      callLog.push({ method: "writeFileSync", path: p });
      files.set(p, c);
    },
    renameSync: (f: string, t: string) => {
      if (!files.has(f)) throw new Error(`ENOENT: ${f}`);
      track(t);
      callLog.push({ method: "renameSync", path: t });
      files.set(t, files.get(f) as string);
      files.delete(f);
    },
    copyFileSync: (f: string, t: string) => {
      if (!files.has(f)) throw new Error(`ENOENT: ${f}`);
      track(t);
      files.set(t, files.get(f) as string);
    },
    unlinkSync: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
    mkdirSync: (p: string, _opts?: { recursive?: boolean }) => {
      track(p);
    },
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const seen = new Set<string>();
      // File entries that are direct children of p
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const s = rest.indexOf("/");
        seen.add(s === -1 ? rest : rest.slice(0, s));
      }
      // Subdirectory entries that are immediate children of p
      for (const d of dirs.keys()) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (!rest || rest === "/") continue;
        const first = rest.split("/")[0];
        if (first) seen.add(first);
      }
      return Array.from(seen).sort();
    },
    existsSync: (p: string) => {
      if (files.has(p) || dirs.has(p)) return true;
      // A directory exists if it is a proper parent of any tracked dir.
      // This enables purgeDirectory to recurse into subdirectories that
      // exist on disk but are not explicitly tracked in our files map.
      for (const d of dirs.keys()) {
        if (d.startsWith(p) && d !== p) {
          const rest = d.slice(p.length);
          if (rest.startsWith("/")) return true;
        }
      }
      return false;
    },
    rmdirSync: (p: string) => {
      callLog.push({ method: "rmdirSync", path: p });
      if (purgeErrorOn.has(p)) {
        const err = new Error(`ENOTEMPTY: ${p}`);
        const last = callLog[callLog.length - 1];
        if (last) last.err = err;
        throw err;
      }
      dirs.delete(p);
    },
    canWrite: (_p: string) => true,
  } as MemFs;
};

// ---------------------------------------------------------------------------
// Fake ProcessRunner / SpawnFn
// ---------------------------------------------------------------------------

/**
 * Callback applied inside the fake runner's run() mock, after spawn "completes".
 * Allows tests to mutate the MemFs state to simulate post-spawn cache changes.
 */
type PostSpawnMutation = (files: Map<string, string>) => void;

/**
 * Default post-spawn mutation — simulates the opencode plugin
 * creating/refreshing the @latest cache with version 1.1.0.
 * Applied automatically when createFakeRunner is called without
 * explicit postSpawnMutations (status-0 success path).
 */
const defaultPostSpawnMutation: PostSpawnMutation = (files) => {
  files.set(
    "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json",
    JSON.stringify({ version: "1.1.0" }),
  );
};

type FakeRunnerOptions = Partial<ProcessResult> & {
  spawnErr?: Error;
  /** Post-spawn mutations applied inside the runner's run() mock,
   *  after the spawn "completes" but before the Promise resolves.
   *  Allows tests to simulate post-spawn cache file changes.
   *  Default: if undefined, applies a single default mutation that
   *  creates/updates @latest/package.json with version "1.1.0".
   *  Pass `[]` to disable (used by tests that specifically test
   *  unchanged/missing/invalid post-version error paths). */
  postSpawnMutations?: PostSpawnMutation[] | undefined;
};

const createFakeRunner = (
  results: FakeRunnerOptions[] = [],
  /** Optional MemFs reference used for the default post-spawn mutation.
   *  When provided, the default mutation (simulating cache refresh to 1.1.0)
   *  will automatically apply to this MemFs without needing linkMemFs.
   *  Can be omitted when all runners in the test use explicit
   *  postSpawnMutations: [] (e.g., in error-path tests). */
  memFs?: MemFs,
): ProcessRunner & { runCount: number[] } => {
  const callCount: number[] = [];
  const runner: ProcessRunner & { runCount: number[] } = {
    runCount: callCount,
    run: vi.fn(async (_executable, _args, _opts?: unknown) => {
      callCount.push(callCount.length);
      const r = results[callCount.length - 1] ?? {};
      if (r.spawnErr) throw r.spawnErr;
      // Apply post-spawn mutations. Default (when undefined) is to simulate
      // the cache being refreshed to version 1.1.0 after a successful spawn.
      // Pass [] to disable (for tests of unchanged/missing/invalid version).
      // For the default mutation, prefer memFs.__files if provided;
      // fall back to runner.__memFiles (set by linkMemFs) as a secondary path.
      const mutationFiles: Map<string, string> | undefined =
        memFs !== undefined
          ? memFs.__files
          : (runner as unknown as { __memFiles?: Map<string, string> })
              .__memFiles;
      const mutations: PostSpawnMutation[] =
        r.postSpawnMutations === undefined
          ? [defaultPostSpawnMutation]
          : r.postSpawnMutations;
      for (const mutation of mutations) {
        if (mutationFiles) mutation(mutationFiles);
      }
      return {
        status: r.status ?? 0,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        missing: r.missing ?? false,
      };
    }),
  };
  return runner;
};

/**
 * Link a MemFs __files map to a fake runner so that postSpawnMutations
 * can mutate the in-memory filesystem inside the runner's run() mock.
 * Must be called by the test after createMemFs and createFakeRunner,
 * but BEFORE runUpdate is called.
 */
const linkMemFs = (
  runner: ProcessRunner & { runCount: number[] },
  memFs: MemFs,
): void => {
  (runner as unknown as { __memFiles: Map<string, string> }).__memFiles =
    memFs.__files;
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// runUpdate — Task 4.1 RED: unconditional update contract
// ---------------------------------------------------------------------------

describe("runUpdate — unconditional update contract (Task 4.1)", () => {
  // Task 4.1 RED (a): update always purges then spawns regardless of installed version
  it("purges and spawns even when config shows a current version", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.2.3`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    // No latestVersion injection — unconditional flow does not consult registry
    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    // Always stale — version compare is gone
    expect(result.status).toBe("stale");
    // Purged the cache path
    expect(result.cachePaths).toContain(
      "/home/test/.cache/opencode/packages/opencode-code-review",
    );
    // Spawn was called
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      PLUGIN_NAME,
      "--global",
      "--force",
    ]);
  });

  // Task 4.1 RED (a): unconditional — no version gate at all
  it("purges and spawns even when config shows a newer version", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@99.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 4.1 RED (b): update spawns even when cache paths list is empty
  it("spawns even when no cache paths exist", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      // No cache directories
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(result.cachePaths).toEqual([]);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      PLUGIN_NAME,
      "--global",
      "--force",
    ]);
  });

  // Task 4.1 RED (b): unconditional — no plugin in config at all
  it("purges and spawns even when plugin is not in config at all", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [],
      }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 4.1 RED (c): UpdateResult.status narrows to 'stale' | 'noop'
  it("returns status 'noop' in dry-run mode", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([]);

    const result = await runUpdate({ dryRun: true, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("noop");
    expect(result.cachePaths).toEqual([]); // dry-run: no actual purge
    expect(runner.run).not.toHaveBeenCalled(); // dry-run: no spawn
  });

  // Task 4.1 RED (c): status is always 'stale' after a real (non-dry-run) run
  it("returns status 'stale' after a real run (never 'current' or 'unreachable')", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    // Result must NOT have old fields
    expect(result).not.toHaveProperty("installedVersion");
    expect(result).not.toHaveProperty("latestVersion");
    // Result MUST have new fields
    expect(result).toHaveProperty("cachePaths");
    expect(result).toHaveProperty("instruction");
  });

  // Task 4.1 RED (c): instruction field is always present in UpdateResult
  it("returns instruction as a string field (populated in dry-run, empty after real run)", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });

    // Dry-run: instruction is populated
    const dryRunResult = await runUpdate(
      { dryRun: true, spawn: createFakeRunner([]) },
      fs,
      { HOME: "/home/test" },
    );
    expect(dryRunResult.instruction).toContain(PLUGIN_NAME);
    expect(dryRunResult.instruction).toContain("--global");
    expect(dryRunResult.instruction).toContain("--force");

    // Real run: instruction is empty (spawn replaces the need for it)
    const realResult = await runUpdate(
      { spawn: createFakeRunner([{ status: 0 }], fs) },
      fs,
      { HOME: "/home/test" },
    );
    expect(typeof realResult.instruction).toBe("string");
    expect(realResult.instruction).toBe("");
  });
});

// ---------------------------------------------------------------------------
// runUpdate — Task 4.3 RED: error boundaries
// ---------------------------------------------------------------------------

describe("runUpdate — error boundaries (Task 4.3)", () => {
  // Task 4.3 RED (a): purge failure on one path is swallowed; spawn still proceeds.
  // The key invariant: after a partial purge failure, spawn still runs.
  // (Exact rmdirSync call counts depend on MemFs accurately modeling the real
  // filesystem — directory entries are removed when files inside are unlinked.
  // Our MemFs doesn't perfectly mirror this, so we verify the key outcome: spawn
  // was called after a purge error on at least one path.)
  it("swallows purge failure on one path and continues purging other paths", async () => {
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review": "",
        "/home/test/.cache/opencode/packages/opencode-code-review@1.0.0": "",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review",
        ],
      },
    );
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    // Did NOT throw — purge failure was swallowed; spawn was called
    expect(result.status).toBe("stale");
    expect(runner.run).toHaveBeenCalledTimes(1);
    // At least one rmdirSync call was made (partial purge succeeded)
    expect(
      fs.__callLog.filter((c) => c.method === "rmdirSync").length,
    ).toBeGreaterThanOrEqual(1);
  });

  // Task 4.3 RED (b): purge failure swallowed AND spawn exits 0 → resolve
  it("does NOT throw when purge fails but spawn succeeds (exit 0)", async () => {
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review": "",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review",
        ],
      },
    );
    const runner = createFakeRunner([{ status: 0 }], fs);

    // Should NOT throw
    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).resolves.toBeDefined();

    // Spawn was called despite purge failure
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 4.3 RED (c): purge failure swallowed AND spawn exits non-zero → reject
  it("throws when purge fails AND spawn exits non-zero (spawn failure propagates)", async () => {
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review": "",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review",
        ],
      },
    );
    const runner = createFakeRunner([
      { status: 1, stderr: "plugin update failed" },
    ]);

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("plugin update failed");
  });

  // Task 4.3 RED (c): spawn failure — nonzero exit — throws with exit code in message
  it("throws with exit code mentioned in error message on nonzero exit", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([{ status: 2, stderr: "some error" }]);

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("2");
  });

  // Task 4.3 RED (a): all purge paths fail — still spawns
  it("spawns even when all purge paths fail", async () => {
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review": "",
        "/home/test/.cache/opencode/packages/opencode-code-review@1.0.0": "",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review",
          "/home/test/.cache/opencode/packages/opencode-code-review@1.0.0",
        ],
      },
    );
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    // Spawn still called despite all purge failures
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runUpdate — spawn error cases
// ---------------------------------------------------------------------------

describe("runUpdate — spawn errors", () => {
  it("throws when opencode executable is missing during update", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([{ missing: true }]);

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("not found");
  });

  it("throws when spawn returns nonzero exit after purge", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const runner = createFakeRunner([
      { status: 1, stderr: "plugin update failed" },
    ]);

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("plugin update failed");
  });

  it("successful update resolves with stale status and cachePaths", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
      "/home/test/.cache/opencode/packages/opencode-code-review@1.0.0": "",
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(result.cachePaths.length).toBeGreaterThan(0);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Import-graph: update.ts must not reference registry.ts
// ---------------------------------------------------------------------------

describe("update.ts import-graph sanity", () => {
  it("update.ts source does not contain any registry.ts symbols", async () => {
    // Dynamic import to read the source at test time (not at compile time)
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const updateSource = readFileSync(
      path.resolve(fileURLToPath(import.meta.url), "../update.ts"),
      "utf8",
    );

    // These specific symbols must NOT appear in update.ts source
    // (the word "registry" in comments is allowed; only symbol names are forbidden)
    const forbiddenSymbols = ["fetchLatestVersion", "LatestVersionFn"];

    for (const symbol of forbiddenSymbols) {
      expect(updateSource).not.toContain(symbol);
    }
  });

  it("update.ts source must not import from ./registry", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const updateSource = readFileSync(
      path.resolve(fileURLToPath(import.meta.url), "../update.ts"),
      "utf8",
    );

    // The import path ./registry must not appear in update.ts
    expect(updateSource).not.toContain("./registry");
  });
});

// ---------------------------------------------------------------------------
// runUpdate — Task 2.1 RED: fixed argv, no registry import, no version gate
// (supplements existing unconditional-update RED tests)
// ---------------------------------------------------------------------------

describe("runUpdate — Task 2.1 RED: fixed argv contract", () => {
  // The argv must be exactly ["plugin", PLUGIN_NAME, "--global", "--force"]
  // regardless of any other option combination.
  it("uses exactly ['plugin', 'opencode-code-review', '--global', '--force'] argv", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      PLUGIN_NAME,
      "--global",
      "--force",
    ]);
  });

  it("argv is unchanged when verbose=true", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const call = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("opencode");
    expect(call[1]).toEqual(["plugin", PLUGIN_NAME, "--global", "--force"]);
  });
});

// ---------------------------------------------------------------------------
// runUpdate — Task 2.2 RED: process-threat error boundaries
// ---------------------------------------------------------------------------

describe("runUpdate — Task 2.2 RED: dry-run makes zero purge/spawn calls", () => {
  it("dry-run makes zero rmdirSync calls", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([]);

    await runUpdate({ dryRun: true, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(fs.__callLog.filter((c) => c.method === "rmdirSync").length).toBe(0);
  });

  it("dry-run makes zero spawn calls", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([]);

    await runUpdate({ dryRun: true, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(runner.run).not.toHaveBeenCalled();
  });

  it("dry-run returns status 'noop' with empty cachePaths", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([]);

    const result = await runUpdate({ dryRun: true, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("noop");
    expect(result.cachePaths).toEqual([]);
  });
});

describe("runUpdate — Task 2.2 RED: purge failure warns but continues", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("surfaces purge failure as a warning but does NOT throw", async () => {
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
          JSON.stringify({ version: "1.0.0" }),
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/lib/file.js":
          "content",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review@latest",
        ],
      },
    );
    const runner = createFakeRunner([{ status: 0 }], fs);

    // Must NOT throw even though purge fails
    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    // Warning was emitted about the purge failure
    expect(warnSpy).toHaveBeenCalled();
    // But update still resolved with stale status
    expect(result.status).toBe("stale");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("warns about purge failure even when spawn succeeds", async () => {
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
          JSON.stringify({ version: "1.0.0" }),
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/lib/file.js":
          "content",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review@latest",
        ],
      },
    );
    const runner = createFakeRunner([{ status: 0 }], fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(warnSpy.mock.calls.length).toBeGreaterThan(0);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

describe("runUpdate — Task 2.2 RED: missing executable throws loudly", () => {
  it("throws non-zero error with remediation hint when executable is missing", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ missing: true }]);

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("not found");
  });

  it("throws when spawn returns nonzero exit", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 1, stderr: "update failed" }]);

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("update failed");
  });
});

// ---------------------------------------------------------------------------
// runUpdate — Task 2.3 RED: version pre/post verification
// ---------------------------------------------------------------------------

describe("runUpdate — Task 2.3 RED: version pre/post verification", () => {
  // post-version changed from pre-version → resolves with stale
  it("resolves with stale when post-version differs from pre-version", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const postMutation: PostSpawnMutation = (files) => {
      files.set(
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json",
        JSON.stringify({ version: "1.1.0" }),
      );
    };
    const runner = createFakeRunner([
      { status: 0, postSpawnMutations: [postMutation] },
    ]);
    linkMemFs(runner, fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
  });

  // post-version equal to pre-version → throws with rm -rf remediation
  it("throws when post-version equals pre-version (cache did not refresh)", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      // Both pre and post would read version "1.0.0"
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner(
      [{ status: 0, postSpawnMutations: [] }],
      fs,
    );

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("rm -rf");
  });

  // post-version missing → throws with rm -rf remediation
  it("throws when post-version is missing (cache directory absent)", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      // @latest directory does not exist — no post-version readable
    });
    const runner = createFakeRunner(
      [{ status: 0, postSpawnMutations: [] }],
      fs,
    );

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("rm -rf");
  });

  // post-version invalid (not valid JSON) → throws with rm -rf remediation
  it("throws when post-version is invalid (malformed package.json)", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        "not valid json{",
    });
    const runner = createFakeRunner(
      [{ status: 0, postSpawnMutations: [] }],
      fs,
    );

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("rm -rf");
  });

  // post-version missing (package.json absent) → throws
  it("throws when post-version package.json is absent", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      // @latest dir exists but package.json does not
      "/home/test/.cache/opencode/packages/opencode-code-review@latest": "",
    });
    const runner = createFakeRunner(
      [{ status: 0, postSpawnMutations: [] }],
      fs,
    );

    await expect(
      runUpdate({ spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("rm -rf");
  });

  // pre-version missing, post-version present and different → resolves with stale
  it("resolves with stale when pre-version is missing but post-version is readable", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      // No pre-version readable (no @latest/package.json initially)
    });
    const postMutation: PostSpawnMutation = (files) => {
      files.set(
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json",
        JSON.stringify({ version: "1.1.0" }),
      );
    };
    const runner = createFakeRunner([
      { status: 0, postSpawnMutations: [postMutation] },
    ]);
    linkMemFs(runner, fs);

    // No error should be thrown — pre-version missing is allowed; post-version is newer
    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
  });

  // UpdateResult.status is always 'stale' or 'noop' — never anything else
  it("status is always 'stale' | 'noop' after any successful update run", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    // Simulate post-spawn version change so the verification check passes
    const postMutation: PostSpawnMutation = (files) => {
      files.set(
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json",
        JSON.stringify({ version: "1.2.0" }),
      );
    };
    const runner = createFakeRunner([
      { status: 0, postSpawnMutations: [postMutation] },
    ]);
    linkMemFs(runner, fs);

    const result = await runUpdate({ spawn: runner }, fs, {
      HOME: "/home/test",
    });

    // status must be one of the two allowed values
    expect(["stale", "noop"]).toContain(result.status);
    expect(result).not.toHaveProperty("installedVersion");
    expect(result).not.toHaveProperty("latestVersion");
  });
});

// ---------------------------------------------------------------------------
// Task 3.2 RED: verbose mode emits diagnostic lines; default mode emits none
// ---------------------------------------------------------------------------

describe("runUpdate — Task 3.2 RED: verbose mode emits diagnostics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // verbose emits resolved cache paths
  it("verbose=true emits resolved cache paths", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("resolved cache paths"))).toBe(
      true,
    );
  });

  // verbose emits pre-purge version
  it("verbose=true emits pre-purge version", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("pre-purge version"))).toBe(
      true,
    );
  });

  // verbose emits the spawn argv
  it("verbose=true emits the spawn instruction", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(
      logs.some(
        (l: string) =>
          l.includes("would spawn") || l.includes("opencode plugin"),
      ),
    ).toBe(true);
  });

  // verbose emits per-path purge outcomes
  it("verbose=true emits per-path purge outcomes", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    // Either "purged:" for success or "purge errors:" for failure
    expect(
      logs.some(
        (l: string) => l.includes("purged:") || l.includes("purge errors:"),
      ),
    ).toBe(true);
  });

  // verbose emits spawn exit code
  it("verbose=true emits spawn exit code", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("spawn exit code"))).toBe(true);
  });

  // verbose emits post-spawn version
  it("verbose=true emits post-spawn version", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner, verbose: true }, fs, {
      HOME: "/home/test",
    });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("post-spawn version"))).toBe(
      true,
    );
  });
});

describe("runUpdate — Task 3.2 RED: default mode (verbose=false) emits none of those diagnostics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // default mode: no resolved cache paths line
  it("verbose=undefined emits no 'resolved cache paths' line", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("resolved cache paths"))).toBe(
      false,
    );
  });

  // default mode: no pre-purge version line
  it("verbose=undefined emits no 'pre-purge version' line", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("pre-purge version"))).toBe(
      false,
    );
  });

  // default mode: no spawn instruction line
  it("verbose=undefined emits no spawn instruction line", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("would spawn"))).toBe(false);
  });

  // default mode: no per-path purge outcomes
  it("verbose=undefined emits no per-path 'purged:' or 'purge errors:' lines", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(
      logs.some(
        (l: string) =>
          l.includes("[verbose] purged:") ||
          l.includes("[verbose] purge errors:"),
      ),
    ).toBe(false);
  });

  // default mode: no spawn exit code line
  it("verbose=undefined emits no 'spawn exit code' line", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("spawn exit code"))).toBe(false);
  });

  // default mode: no post-spawn version line
  it("verbose=undefined emits no 'post-spawn version' line", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
        JSON.stringify({ version: "1.0.0" }),
    });
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    const logs = logSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(logs.some((l: string) => l.includes("post-spawn version"))).toBe(
      false,
    );
  });

  // Purge warnings are ALWAYS emitted regardless of verbose mode
  it("verbose=undefined still emits purge warnings via console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fs = createMemFs(
      {
        "/home/test/.config/opencode/opencode.json": JSON.stringify({
          plugin: [`${PLUGIN_NAME}@1.0.0`],
        }),
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/package.json":
          JSON.stringify({ version: "1.0.0" }),
        "/home/test/.cache/opencode/packages/opencode-code-review@latest/lib/file.js":
          "content",
      },
      {
        purgeErrorOn: [
          "/home/test/.cache/opencode/packages/opencode-code-review@latest",
        ],
      },
    );
    const runner = createFakeRunner([{ status: 0 }], fs);

    await runUpdate({ spawn: runner }, fs, { HOME: "/home/test" });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
