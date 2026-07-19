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
// Slice 3 — Config-only RED tests
// ---------------------------------------------------------------------------

describe("runInstall — config-only (no cache mutations)", () => {
  // 3.1a: install() makes zero rm/rmdir/unlink calls
  it("makes zero rm/rmdir/unlink calls during a plain install", () => {
    const fs = createFakeFs({});
    const rmdirCalls: string[] = [];
    const unlinkCalls: string[] = [];
    const origRmdirSync = fs.rmdirSync.bind(fs);
    const origUnlinkSync = fs.unlinkSync.bind(fs);
    fs.rmdirSync = (path: string) => {
      rmdirCalls.push(path);
      origRmdirSync(path);
    };
    fs.unlinkSync = (path: string) => {
      unlinkCalls.push(path);
      origUnlinkSync(path);
    };
    runInstall({ version: "2.0.0" }, fs, process.env);
    expect(rmdirCalls).toEqual([]);
    expect(unlinkCalls).toEqual([]);
  });

  // 3.1b: InstallResult has no purged field (runtime check)
  it("InstallResult has no purged field", () => {
    const fs = createFakeFs({});
    const result = runInstall({}, fs, process.env);
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(
      (result as unknown as Record<string, unknown>).purged,
    ).toBeUndefined();
  });

  // 3.3a: noop when specifier already present
  it("noop when specifier is already present — does not write", () => {
    const fs = createFakeFs({ plugin: [PLUGIN_NAME] });
    const before = fs.readFileSync(CONFIG_PATH);
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("noop");
    expect(fs.writtenFiles.size).toBe(0);
    expect(fs.readFileSync(CONFIG_PATH)).toBe(before);
  });

  // 3.3b: dedupe — multiple entries collapse to one
  it("dedupes multiple review-plugin entries down to one on write", () => {
    const fs = createFakeFs({
      plugin: [PLUGIN_NAME, `${PLUGIN_NAME}@1.0.0`, "other-plugin"],
    });
    const result = runInstall({ version: "2.0.0" }, fs, process.env);
    expect(result.status).toBe("wrote");
    const stored = fs.writtenFiles.get(CONFIG_PATH)!;
    const parsed = JSON.parse(stored);
    const reviewEntries = parsed.plugin.filter((e: string) =>
      e.startsWith(PLUGIN_NAME),
    );
    expect(reviewEntries).toHaveLength(1);
    expect(reviewEntries[0]).toBe(`${PLUGIN_NAME}@2.0.0`);
  });

  // 3.3c: atomic rename with backup created
  it("atomic write creates backup then renames temp file into place", () => {
    const existingContent = JSON.stringify({ plugin: [PLUGIN_NAME] });
    const store = new Map<string, string>();
    store.set(CONFIG_PATH, existingContent);
    const writtenFiles = new Map<string, string>();
    const copyOps: string[] = [];
    const renameOps: Array<{ from: string; to: string }> = [];

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
        renameOps.push({ from, to });
        const content = store.get(from);
        if (content !== undefined) {
          store.delete(from);
          store.set(to, content);
        }
        writtenFiles.set(to, store.get(to)!);
      },
      copyFileSync: (_from: string, to: string): void => {
        copyOps.push(to);
        store.set(to, existingContent);
      },
      unlinkSync: (): void => {
        throw new Error("unexpected unlinkSync");
      },
      mkdirSync: (): void => {},
      readdirSync: (): string[] => [],
      existsSync: (path: string): boolean => store.has(path),
      rmdirSync: (): void => {
        throw new Error("unexpected rmdirSync");
      },
      canWrite: (): boolean => true,
    } as unknown as CliFs & { writtenFiles: Map<string, string> };
    (fs as unknown as Record<string, unknown>).writtenFiles = writtenFiles;

    const result = runInstall({ version: "3.0.0" }, fs, process.env);
    expect(result.status).toBe("wrote");
    // A backup must have been created via copyFileSync with .bak suffix
    const bakPath = copyOps.find((k) => k.includes(".bak"));
    expect(bakPath).toBeDefined();
    // The backup must contain the original content
    expect(store.get(bakPath!)).toBe(existingContent);
    // A rename must have moved a temp file to the final path
    expect(renameOps.some((op) => op.to === CONFIG_PATH)).toBe(true);
  });

  // 3.3d: dry-run returns planned without writing
  it("dry-run returns planned without writing any file", () => {
    const fs = createFakeFs({});
    const result = runInstall({ dryRun: true }, fs, process.env);
    expect(result.status).toBe("planned");
    expect(fs.writtenFiles.size).toBe(0);
  });

  // 3.3e: dry-run with specifier present returns noop without writing
  it("dry-run with specifier already present returns noop without writing", () => {
    const fs = createFakeFs({ plugin: [PLUGIN_NAME] });
    const before = fs.readFileSync(CONFIG_PATH);
    const result = runInstall({ dryRun: true }, fs, process.env);
    expect(result.status).toBe("noop");
    expect(fs.writtenFiles.size).toBe(0);
    expect(fs.readFileSync(CONFIG_PATH)).toBe(before);
  });

  // 3.3f: malformed JSON aborts without mutation
  it("malformed JSON throws without writing or renaming any file", () => {
    const store = new Map<string, string>();
    store.set(CONFIG_PATH, "{ invalid json");
    const writtenFiles = new Map<string, string>();
    const renameOps: Array<{ from: string; to: string }> = [];

    const fs = {
      readFileSync: (path: string): string => {
        const val = store.get(path);
        if (val === undefined) throw new Error(`ENOENT: ${path}`);
        return val;
      },
      writeFileSync: (_path: string, _content: string): void => {
        throw new Error("writeFileSync must not be called");
      },
      renameSync: (from: string, to: string): void => {
        renameOps.push({ from, to });
      },
      copyFileSync: (): void => {},
      unlinkSync: (): void => {},
      mkdirSync: (): void => {},
      readdirSync: (): string[] => [],
      existsSync: (): boolean => true,
      rmdirSync: (): void => {},
      canWrite: (): boolean => true,
    } as unknown as CliFs;

    expect(() => runInstall({}, fs, process.env)).toThrow("malformed JSON");
    expect(writtenFiles.size).toBe(0);
    expect(renameOps).toEqual([]);
  });
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

  // No-op with stale cache — returns noop without rewriting config
  it("noop with stale cache does not write config or create backup", () => {
    const fs = createFakeFs({ plugin: [PLUGIN_NAME] }, [
      `${PLUGIN_NAME}@1.0.0`,
      `${PLUGIN_NAME}@2.0.0`,
    ]);
    const result = runInstall({}, fs, process.env);
    expect(result.status).toBe("noop");
    expect(result.specifier).toBe(PLUGIN_NAME);
    expect(result.backup).toBeNull();
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
  });

  // Result shape — with version
  it("returns correct result shape for versioned install", () => {
    const fs = createFakeFs({});
    const result = runInstall({ version: "1.2.3" }, fs, process.env);
    expect(result.status).toBe("wrote");
    expect(result.specifier).toBe(`${PLUGIN_NAME}@1.2.3`);
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
