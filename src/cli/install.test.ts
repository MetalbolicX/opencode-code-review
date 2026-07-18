// ---------------------------------------------------------------------------
// src/cli/install.test.ts — Unit tests for `ocr install` (direct config writer).
//
// `runInstall` directly edits the global OpenCode config file and purges
// stale cache entries. Tests inject an in-memory `CliFs` to exercise every
// branch deterministically without touching the real filesystem.
//
// Tests cover:
//   - In-memory config write with correct plugin entry
//   - Idempotent no-op when same version is already installed
//   - Dry-run reports planned write and purge targets without writing
//   - Malformed config throws without corrupting
//   - Backup before write ordering
//   - Stale cache purge during install
//   - Failure behavior (backup safety)
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInstall } from "./install.ts";
import type { CliFs } from "./config.ts";
import { PLUGIN_NAME } from "./config.ts";

// ---------------------------------------------------------------------------
// Constants (resolved at test time using the env set in beforeEach)
// ---------------------------------------------------------------------------

const TEST_HOME = "/home/test";
const CONFIG_PATH = join(TEST_HOME, ".config", "opencode", "opencode.json");
const PACKAGES_DIR = join(TEST_HOME, ".cache", "opencode", "packages");

// ---------------------------------------------------------------------------
// Fake filesystem
//
// Tracks writes via a shallow copy approach so that writeFileSync overrides
// (even on the same object reference) still write to our tracking map.
// ---------------------------------------------------------------------------

const createFakeFs = (
  initialConfig?: Record<string, unknown>,
  cacheEntries: string[] = [],
): CliFs & { writtenFiles: Map<string, string>; purgedDirs: string[] } => {
  const store = new Map<string, string>();
  const writtenFiles = new Map<string, string>();
  const purgedDirs: string[] = [];

  if (initialConfig !== undefined) {
    store.set(CONFIG_PATH, JSON.stringify(initialConfig));
  }
  if (cacheEntries.length > 0) {
    store.set(PACKAGES_DIR, JSON.stringify(cacheEntries));
  }

  const fs = {
    readFileSync: (path: string): string => {
      const val = store.get(path);
      if (val === undefined) throw new Error(`ENOENT: ${path}`);
      return val;
    },
    writeFileSync: (path: string, content: string): void => {
      store.set(path, content);
      writtenFiles.set(path, content);
    },
    renameSync: (from: string, to: string): void => {
      const content = store.get(from);
      if (content !== undefined) {
        store.delete(from);
        store.set(to, content);
        writtenFiles.set(to, content);
      }
    },
    copyFileSync: (): void => {},
    unlinkSync: (path: string): void => {
      store.delete(path);
    },
    mkdirSync: (): void => {},
    readdirSync: (path: string): string[] => {
      const val = store.get(path);
      if (val !== undefined) return JSON.parse(val) as string[];
      // For cache subdirectories that should exist (based on PACKAGES_DIR contents),
      // return empty array (empty directory).
      if (path.startsWith(PACKAGES_DIR + "/")) return [];
      throw new Error(`ENOENT: ${path}`);
    },
    existsSync: (path: string): boolean => {
      if (store.has(path)) return true;
      if (path === PACKAGES_DIR) return cacheEntries.length > 0;
      // Cache subdirectories exist if the parent dir has cache entries.
      if (path.startsWith(PACKAGES_DIR + "/")) {
        const parentVal = store.get(PACKAGES_DIR);
        if (parentVal !== undefined) {
          const entries: string[] = JSON.parse(parentVal);
          const subName = path.slice(PACKAGES_DIR.length + 1);
          return entries.includes(subName);
        }
        return false;
      }
      return false;
    },
    rmdirSync: (path: string): void => {
      purgedDirs.push(path);
      // Remove the directory itself and all entries under it from the store.
      for (const key of [...store.keys()]) {
        if (key === path || key.startsWith(path + "/")) store.delete(key);
      }
    },
    canWrite: (): boolean => true,
  };

  const tracked = fs as unknown as CliFs & {
    writtenFiles: Map<string, string>;
    purgedDirs: string[];
  };
  tracked.writtenFiles = writtenFiles;
  tracked.purgedDirs = purgedDirs;
  return tracked;
};

// ---------------------------------------------------------------------------
// Helpers
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
// Tests
// ---------------------------------------------------------------------------

describe("runInstall", () => {
  // Default bare install — writes config with bare plugin specifier
  it("writes config with bare plugin specifier", () => {
    const fs = createFakeFs({});
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(PLUGIN_NAME);
    // backup is non-null when file already existed
    expect(result.backup).not.toBeNull();
    expect(result.purged).toEqual([]);
    // Config was written to the store
    const stored = fs.writtenFiles.get(CONFIG_PATH);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.plugin).toEqual([PLUGIN_NAME]);
  });

  // Version pin — writes with version suffix
  it("writes config with version suffix when --version is given", () => {
    const fs = createFakeFs({});
    const result = runInstall({ version: "2.0.0" }, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(`${PLUGIN_NAME}@2.0.0`);
    const stored = fs.writtenFiles.get(CONFIG_PATH);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.plugin).toEqual([`${PLUGIN_NAME}@2.0.0`]);
  });

  // --latest flag — writes bare specifier (latest from npm)
  it("--latest writes bare specifier", () => {
    const fs = createFakeFs({});
    const result = runInstall({ version: "latest" }, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(PLUGIN_NAME);
    const stored = fs.writtenFiles.get(CONFIG_PATH);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!);
    expect(parsed.plugin).toEqual([PLUGIN_NAME]);
  });

  // Idempotent no-op — same version reinstall
  it("returns noop when same version is already installed", () => {
    const fs = createFakeFs({ plugin: [PLUGIN_NAME] });
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("noop");
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(result.backup).toBeNull();
  });

  // Idempotent no-op with version
  it("returns noop when same versioned specifier is already installed", () => {
    const fs = createFakeFs({ plugin: [`${PLUGIN_NAME}@2.0.0`] });
    const result = runInstall({ version: "2.0.0" }, fs, process.env);
    expect(result.status).toBe("noop");
    expect(result.specifier).toBe(`${PLUGIN_NAME}@2.0.0`);
    expect(result.backup).toBeNull();
  });

  // No-op with stale cache — purge cache without rewriting config
  it("noop with stale cache purges cache but does not write config or create backup", () => {
    const fs = createFakeFs(
      { plugin: [PLUGIN_NAME] },
      [`${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0`],
    );
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("noop");
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(result.backup).toBeNull();
    expect(result.purged).toContain(`${PACKAGES_DIR}/${PLUGIN_NAME}@1.0.0`);
    expect(result.purged).toContain(`${PACKAGES_DIR}/${PLUGIN_NAME}@2.0.0`);
    // Config must NOT be rewritten — writtenFiles must not contain CONFIG_PATH
    expect(fs.writtenFiles.has(CONFIG_PATH)).toBe(false);
  });

  // Dry-run — reports planned write without writing
  it("dry-run reports planned write without writing", () => {
    const fs = createFakeFs({});
    const result = runInstall({ dryRun: true }, fs, process.env);
    expect(result.status).toBe("planned");
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(fs.writtenFiles.size).toBe(0);
  });

  // Dry-run with stale cache — reports planned purge targets
  it("dry-run reports planned cache purge targets", () => {
    const fs = createFakeFs(
      { plugin: [PLUGIN_NAME] },
      [`${PLUGIN_NAME}@1.0.0`],
    );
    const logSpy = vi.spyOn(console, "log");
    const result = runInstall({ dryRun: true }, fs, process.env);
    expect(result.status).toBe("planned");
    expect(result.purged).toContain(`${PACKAGES_DIR}/${PLUGIN_NAME}@1.0.0`);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Would purge stale cache"),
    );
  });

  // Stale cache purge — removes matching cache entries
  it("purges stale cache entries during install", () => {
    const fs = createFakeFs(
      { plugin: [`${PLUGIN_NAME}@1.0.0`] },
      [`${PLUGIN_NAME}@1.0.0`, `${PLUGIN_NAME}@2.0.0`, "other-plugin"],
    );
    const result = runInstall({ version: "3.0.0" }, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.purged).toContain(`${PACKAGES_DIR}/${PLUGIN_NAME}@1.0.0`);
    expect(result.purged).toContain(`${PACKAGES_DIR}/${PLUGIN_NAME}@2.0.0`);
    expect(result.purged).not.toContain(`${PACKAGES_DIR}/other-plugin`);
  });

  // Preserves unrelated plugins
  it("preserves unrelated plugin entries during install", () => {
    const fs = createFakeFs({ plugin: ["some-other-plugin", PLUGIN_NAME] });
    const result = runInstall({ version: "2.0.0" }, fs, process.env);
    expect(result.status).toBe("wrote");
    const stored = fs.writtenFiles.get(CONFIG_PATH)!;
    const parsed = JSON.parse(stored);
    expect(parsed.plugin).toContain("some-other-plugin");
    expect(parsed.plugin).toContain(`${PLUGIN_NAME}@2.0.0`);
  });

  // Backup before write ordering — backup happens before config write
  // NOTE: this test sets up stale cache entries so rmdir is called.
  it("creates backup before writing config", () => {
    const fs = createFakeFs(
      { plugin: [PLUGIN_NAME] },
      [`${PLUGIN_NAME}@1.0.0`],
    );
    const writeOrder: string[] = [];
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (path: string, content: string) => {
      writeOrder.push(`write:${path}`);
      origWriteFileSync(path, content);
    };
    const origRmdirSync = fs.rmdirSync.bind(fs);
    fs.rmdirSync = (path: string) => {
      writeOrder.push(`rmdir:${path}`);
      origRmdirSync(path);
    };
    runInstall({ version: "2.0.0" }, fs, process.env);
    const configWriteIndex = writeOrder.findIndex(
      (e) => e.startsWith("write:") && e.includes("opencode.json"),
    );
    const firstRmdirIndex = writeOrder.findIndex((e) => e.startsWith("rmdir:"));
    // Config write must come before any purge rmdir
    expect(configWriteIndex).toBeLessThan(firstRmdirIndex);
  });

  // Malformed config — throws without corrupting
  it("throws when config is malformed JSON", () => {
    const store = new Map<string, string>();
    store.set(CONFIG_PATH, "{ invalid json }");
    const fs = {
      readFileSync: (path: string): string => {
        const val = store.get(path);
        if (val === undefined) throw new Error(`ENOENT: ${path}`);
        return val;
      },
      writeFileSync: (): void => {},
      renameSync: (): void => {},
      copyFileSync: (): void => {},
      unlinkSync: (): void => {},
      mkdirSync: (): void => {},
      readdirSync: (): string[] => [],
      existsSync: (): boolean => true,
      rmdirSync: (): void => {},
      canWrite: (): boolean => true,
    } as unknown as CliFs;
    expect(() => runInstall({}, fs, process.env)).toThrow("malformed JSON");
  });

  // Result shape — all fields present
  it("returns correct result shape for bare install", () => {
    const fs = createFakeFs({});
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.path).toBe(CONFIG_PATH);
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(typeof result.backup).toBe("string");
    expect(result.purged).toEqual([]);
  });

  // Result shape — with version
  it("returns correct result shape for versioned install", () => {
    const fs = createFakeFs({});
    const result = runInstall({ version: "1.2.3" }, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(`${PLUGIN_NAME}@1.2.3`);
    expect(result.purged).toEqual([]);
  });

  // Writes to correct path — resolves from HOME
  it("writes to correct config path resolved from HOME", () => {
    const fs = createFakeFs({});
    const result = runInstall({}, fs, { HOME: "/custom/home" });
    expect(result.path).toBe("/custom/home/.config/opencode/opencode.json");
  });

  // No existing config — creates fresh config
  it("creates fresh config when none exists", () => {
    const fs = createFakeFs();
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(fs.writtenFiles.has(CONFIG_PATH)).toBe(true);
    const stored = fs.writtenFiles.get(CONFIG_PATH)!;
    const parsed = JSON.parse(stored);
    expect(parsed.plugin).toEqual([PLUGIN_NAME]);
  });
});
