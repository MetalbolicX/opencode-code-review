// ---------------------------------------------------------------------------
// src/cli/update.test.ts — Unit tests for `ocr update` lifecycle.
//
// runUpdate queries the npm registry for the latest version, compares it to
// the installed version from the global config, and when stale purges matching
// cache entries and force-reinstalls via opencode plugin.
//
// Tests inject both `latestVersion` (registry seam) and `ProcessRunner` (spawn
// seam) to exercise every branch deterministically without network or
// subprocess calls.
//
// Task 4.2 RED tests:
//   - Already current: installed === latest → { status: 'current' }, no purge, no spawn
//   - Stale triggers purge + force reinstall: newer version → purges cache, spawns --force
//   - Registry unreachable: latestVersion returns null → { status: 'unreachable' }, no purge, no spawn, exit 1
//   - Malformed latest version: invalid version string → { status: 'unreachable' }, no mutation
//   - Dry-run: reports comparison WITHOUT mutating state (no purge, no spawn)
//   - Threat-matrix RED: rejected/invalid latest leaves files and process calls unchanged
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessResult, ProcessRunner } from "./spawn.ts";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runUpdate, extractVersion } from "./update.ts";

type FakeLatest = () => Promise<string | null>;
type MemFs = CliFs & {
  __files: Map<string, string>;
  __dirs: Set<string>;
  __callLog: { method: string; path: string }[];
};

const createMemFs = (
  initial: Record<string, string> = {},
): MemFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const callLog: { method: string; path: string }[] = [];

  const track = (p: string): void => {
    const parts = p.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      acc = acc === "/" ? `/${parts[i] as string}` : acc ? `${acc}/${parts[i] as string}` : (parts[i] as string);
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
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const s = rest.indexOf("/");
        seen.add(s === -1 ? rest : rest.slice(0, s));
      }
      for (const d of dirs.keys()) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (!rest || rest === "/") continue;
        const first = rest.split("/")[0];
        if (first) seen.add(first);
      }
      return Array.from(seen).sort();
    },
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    rmdirSync: (p: string) => {
      callLog.push({ method: "rmdirSync", path: p });
      dirs.delete(p);
    },
    canWrite: (_p: string) => true,
  } as MemFs;
};

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
// extractVersion unit tests
// ---------------------------------------------------------------------------

describe("extractVersion", () => {
  it("extracts version from pinned specifier", () => {
    expect(extractVersion("opencode-code-review@1.2.3")).toBe("1.2.3");
  });

  it("extracts full semver with pre-release", () => {
    expect(extractVersion("opencode-code-review@2.0.0-beta.1")).toBe("2.0.0-beta.1");
  });

  it("extracts 'latest' as a valid version string", () => {
    expect(extractVersion("opencode-code-review@latest")).toBe("latest");
  });

  it("returns null for bare specifier (no version)", () => {
    expect(extractVersion("opencode-code-review")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractVersion("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(extractVersion(null as unknown as string)).toBeNull();
    expect(extractVersion(undefined as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runUpdate RED tests
// ---------------------------------------------------------------------------

describe("runUpdate", () => {
  // Task 4.2 RED: Already current → reports { status: 'current' }, no purge, no spawn
  it("returns status 'current' when installed version equals latest", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.2.3`],
      }),
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([]);

    const result = await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("current");
    expect(result.installedVersion).toBe("1.2.3");
    expect(result.latestVersion).toBe("1.2.3");
    expect(result.cachePaths).toEqual([]);
    // No spawn calls (not stale)
    expect(runner.run).not.toHaveBeenCalled();
  });

  // Task 4.2 RED: Stale triggers purge + force reinstall
  it("purges cache and spawns force-reinstall when newer version available", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      // Add a cache entry to purge
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
      "/home/test/.cache/opencode/packages/opencode-code-review@1.0.0": "",
      "/home/test/.cache/opencode/packages/other-plugin": "",
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([{ status: 0 }]);

    const result = await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(result.installedVersion).toBe("1.0.0");
    expect(result.latestVersion).toBe("1.2.3");
    expect(result.cachePaths).toContain("/home/test/.cache/opencode/packages/opencode-code-review");
    expect(result.cachePaths).toContain("/home/test/.cache/opencode/packages/opencode-code-review@1.0.0");
    // unrelated entry NOT purged
    expect(result.cachePaths).not.toContain("/home/test/.cache/opencode/packages/other-plugin");
    // Spawn called with --force
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith("opencode", [
      "plugin",
      PLUGIN_NAME,
      "--global",
      "--force",
    ]);
  });

  // Task 4.2 RED: Registry unreachable → { status: 'unreachable' }, no purge, no spawn, exit 1
  it("returns status 'unreachable' and skips all mutation when latestVersion returns null", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const latestVersion = vi.fn(async () => null);
    const runner = createFakeRunner([]);

    const result = await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("unreachable");
    expect(result.installedVersion).toBeNull();
    expect(result.latestVersion).toBeNull();
    expect(result.cachePaths).toEqual([]);
    // No purge (unreachable exits before mutation per threat-matrix)
    expect(runner.run).not.toHaveBeenCalled();
  });

  // Task 4.2 RED: Malformed latest version (invalid version string) → unreachable
  it("returns 'unreachable' when latestVersion returns an empty string", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
    });
    const latestVersion = vi.fn(async () => "");
    const runner = createFakeRunner([]);

    const result = await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    // Empty string is not a valid version — treated as unreachable
    expect(result.status).toBe("unreachable");
    expect(runner.run).not.toHaveBeenCalled();
  });

  // Task 4.2 RED: Dry-run reports without mutating
  it("dry-run prints comparison without purge or spawn", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([]);
    const logSpy = vi.spyOn(console, "log");

    const result = await runUpdate(
      { dryRun: true, latestVersion, spawn: runner },
      fs,
      { HOME: "/home/test" },
    );

    expect(result.status).toBe("stale");
    expect(result.cachePaths).toEqual([]); // dry-run: no actual purge
    expect(runner.run).not.toHaveBeenCalled(); // dry-run: no spawn
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("installed"),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("latest"),
    );
  });

  // Task 4.2 RED: Threat-matrix — rejected/invalid latest leaves files and process calls unchanged
  it("threat-matrix: invalid latest causes zero rmdirSync calls", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const latestVersion = vi.fn(async () => null);
    const runner = createFakeRunner([]);

    await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    // Zero rmdirSync calls — unreachable exits before purge
    expect(fs.__callLog.filter((c) => c.method === "rmdirSync")).toHaveLength(0);
    expect(runner.run).not.toHaveBeenCalled();
  });

  // Task 4.2 RED: Bare specifier (no version) is always stale
  it("bare specifier triggers stale update even when latest is available", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [PLUGIN_NAME], // bare — no version pin
      }),
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([{ status: 0 }]);

    const result = await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(result.installedVersion).toBeNull(); // bare = no version extracted
    expect(result.latestVersion).toBe("1.2.3");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 4.2 RED: Not installed at all → stale (bare install)
  it("not-installed triggers stale when latest is available", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({ plugin: [] }),
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([{ status: 0 }]);

    const result = await runUpdate({ latestVersion, spawn: runner }, fs, {
      HOME: "/home/test",
    });

    expect(result.status).toBe("stale");
    expect(result.installedVersion).toBeNull();
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  // Task 4.2 RED: Spawn failure surfaces as error
  it("throws when spawn returns nonzero exit after stale update", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([{ status: 1, stderr: "plugin update failed" }]);

    await expect(
      runUpdate({ latestVersion, spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("plugin update failed");
  });

  // Task 4.2 RED: Missing opencode executable throws clear error
  it("throws when opencode executable is missing during stale update", async () => {
    const fs = createMemFs({
      "/home/test/.config/opencode/opencode.json": JSON.stringify({
        plugin: [`${PLUGIN_NAME}@1.0.0`],
      }),
      "/home/test/.cache/opencode/packages/opencode-code-review": "",
    });
    const latestVersion = vi.fn(async () => "1.2.3");
    const runner = createFakeRunner([{ missing: true }]);

    await expect(
      runUpdate({ latestVersion, spawn: runner }, fs, { HOME: "/home/test" }),
    ).rejects.toThrow("executable not found");
  });
});
