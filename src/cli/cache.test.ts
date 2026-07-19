// ---------------------------------------------------------------------------
// src/cli/cache.test.ts — Unit tests for `purgeDirectory`.
//
// Tests use an in-memory `CliFs` to exercise all branches: empty dir,
// nested dirs, missing root, missing children, file fallback to unlink,
// and best-effort error swallowing. No bytes touch the real filesystem.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  purgeDirectory,
  resolveCachePaths,
  resolveHome,
  resolvePackagesDir,
} from "./cache.ts";
import type { CliFs } from "./config.ts";

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

type DirEntry = { kind: "dir"; entries?: string[] } | { kind: "file" };

const dir = (entries: string[]): DirEntry => ({ kind: "dir", entries });
const file = (): DirEntry => ({ kind: "file" });

const makeFakeFs = (store: Map<string, DirEntry>): CliFs => {
  return {
    readFileSync: (): string => {
      throw new Error("not used");
    },
    writeFileSync: (): void => {},
    renameSync: (): void => {},
    copyFileSync: (): void => {},
    unlinkSync: (path: string): void => {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      store.delete(path);
    },
    mkdirSync: (): void => {},
    readdirSync: (path: string): string[] => {
      const entry = store.get(path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      if (entry.kind === "file") throw new Error(`ENOTDIR: ${path}`);
      return entry.entries ?? [];
    },
    existsSync: (path: string): boolean => store.has(path),
    rmdirSync: (path: string): void => {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      store.delete(path);
    },
    canWrite: (): boolean => true,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("purgeDirectory", () => {
  // Empty directory — readdir returns [], rmdirSync called on the root
  it("removes an empty directory", () => {
    const store = new Map<string, DirEntry>([["/cache/ocr", dir([])]]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    expect(store.has("/cache/ocr")).toBe(false);
  });

  // Nested directories — recursively removed
  it("recursively removes nested directories", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["subdir"])],
      [join("/cache/ocr", "subdir"), dir([])],
    ]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    expect(store.has("/cache/ocr")).toBe(false);
    expect(store.has(join("/cache/ocr", "subdir"))).toBe(false);
  });

  // Missing / unreadable root — best-effort (returns without throwing)
  it("returns without throwing when root cannot be read", () => {
    const fs = makeFakeFs(new Map());
    expect(() => purgeDirectory(fs, "/nonexistent")).not.toThrow();
  });

  // Missing child during iteration — existsSync false → continue
  it("skips children that no longer exist", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["gone"])],
      // "gone" is absent from store → existsSync returns false → skipped
    ]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    // root rmdirSync at end always succeeds; focus on "gone" never being touched
    expect(store.has(join("/cache/ocr", "gone"))).toBe(false);
  });

  // File child — readdirSync on file throws → unlinkSync used instead
  it("unlinks a file child when readdirSync fails on it", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["file.txt"])],
      [join("/cache/ocr", "file.txt"), file()],
    ]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    expect(store.has("/cache/ocr")).toBe(false);
    expect(store.has(join("/cache/ocr", "file.txt"))).toBe(false);
  });

  // unlinkSync failure — best-effort (swallowed); child entry stays in store
  it("swallows unlinkSync failures and continues", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["locked"])],
      [join("/cache/ocr", "locked"), file()],
    ]);
    const fs = makeFakeFs(store);
    const origUnlink = fs.unlinkSync.bind(fs);
    fs.unlinkSync = (path: string) => {
      if (path === join("/cache/ocr", "locked")) throw new Error("EPERM");
      origUnlink(path);
    };
    purgeDirectory(fs, "/cache/ocr");
    // locked file stays in store because unlinkSync failed (best-effort)
    expect(store.has(join("/cache/ocr", "locked"))).toBe(true);
    // best-effort — no error printed
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  // rmdirSync failure on root — best-effort (swallowed)
  it("swallows rmdirSync failures on the root directory", () => {
    const store = new Map<string, DirEntry>([["/cache/ocr", dir([])]]);
    const fs = makeFakeFs(store);
    const origRmdir = fs.rmdirSync.bind(fs);
    fs.rmdirSync = (path: string) => {
      if (path === "/cache/ocr") throw new Error("EBUSY");
      origRmdir(path);
    };
    purgeDirectory(fs, "/cache/ocr");
    // Root still in store because rmdirSync failed
    expect(store.has("/cache/ocr")).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Slice 1a — Minimal smoke tests (one happy-path per new export)
// ---------------------------------------------------------------------------

describe("resolveHome", () => {
  it("returns HOME when set", () => {
    expect(resolveHome({ HOME: "/custom" })).toBe("/custom");
  });
});

describe("resolvePackagesDir", () => {
  it("returns ~/.cache/opencode/packages for a given HOME", () => {
    expect(resolvePackagesDir({ HOME: "/home/user" })).toBe(
      "/home/user/.cache/opencode/packages",
    );
  });
});

describe("resolveCachePaths", () => {
  it("returns matching plugin cache dirs when fs is provided", () => {
    const home = "/home/user";
    const packagesDir = join(home, ".cache", "opencode", "packages");
    const store = new Map<string, DirEntry>([
      [packagesDir, dir(["opencode-code-review", "other-plugin"])],
    ]);
    const fs = makeFakeFs(store);
    const result = resolveCachePaths({ HOME: home }, fs);
    expect(result).toContain(join(packagesDir, "opencode-code-review"));
    expect(result).not.toContain(join(packagesDir, "other-plugin"));
  });
});

describe("purgeDirectory — smoke", () => {
  it("removes an empty directory", () => {
    const store = new Map<string, DirEntry>([["/cache/ocr", dir([])]]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    expect(store.has("/cache/ocr")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Slice 1b — Comprehensive spec scenarios
// ---------------------------------------------------------------------------

describe("resolveCachePaths — comprehensive", () => {
  // Spec: exact-match returns the path
  it("returns exact-match plugin cache dir", () => {
    const home = "/home/user";
    const packagesDir = join(home, ".cache", "opencode", "packages");
    const store = new Map<string, DirEntry>([
      [packagesDir, dir(["opencode-code-review"])],
    ]);
    const fs = makeFakeFs(store);
    const result = resolveCachePaths({ HOME: home }, fs);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(packagesDir, "opencode-code-review"));
  });

  // Spec: @version suffix returns the path
  it("returns plugin cache dir with @version suffix", () => {
    const home = "/home/user";
    const packagesDir = join(home, ".cache", "opencode", "packages");
    const store = new Map<string, DirEntry>([
      [packagesDir, dir(["opencode-code-review@1.0.0"])],
    ]);
    const fs = makeFakeFs(store);
    const result = resolveCachePaths({ HOME: home }, fs);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(join(packagesDir, "opencode-code-review@1.0.0"));
  });

  // Spec: empty when no matches
  it("returns empty array when no plugin dirs match", () => {
    const home = "/home/user";
    const packagesDir = join(home, ".cache", "opencode", "packages");
    const store = new Map<string, DirEntry>([
      [packagesDir, dir(["other-plugin", "yet-another"])],
    ]);
    const fs = makeFakeFs(store);
    const result = resolveCachePaths({ HOME: home }, fs);
    expect(result).toHaveLength(0);
  });

  // Spec: missing dir (no fs entry) returns empty
  it("returns empty when packages dir does not exist in fs", () => {
    const home = "/home/user";
    const store = new Map<string, DirEntry>([]); // packagesDir not present
    const fs = makeFakeFs(store);
    const result = resolveCachePaths({ HOME: home }, fs);
    expect(result).toHaveLength(0);
  });

  // No-injection path: returns two conventional candidates
  it("returns conventional candidates when no fs injected", () => {
    const result = resolveCachePaths({ HOME: "/home/user" });
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(
      join(
        "/home/user",
        ".cache",
        "opencode",
        "packages",
        "opencode-code-review",
      ),
    );
    expect(result[1]).toBe(
      join(
        "/home/user",
        ".cache",
        "opencode",
        "packages",
        "opencode-code-review@latest",
      ),
    );
  });

  // Multiple versions coexist
  it("returns both exact and versioned entries", () => {
    const home = "/home/user";
    const packagesDir = join(home, ".cache", "opencode", "packages");
    const store = new Map<string, DirEntry>([
      [
        packagesDir,
        dir([
          "opencode-code-review",
          "opencode-code-review@1.0.0",
          "opencode-code-review@2.0.0",
        ]),
      ],
    ]);
    const fs = makeFakeFs(store);
    const result = resolveCachePaths({ HOME: home }, fs);
    expect(result).toHaveLength(3);
    expect(result).toContain(join(packagesDir, "opencode-code-review"));
    expect(result).toContain(join(packagesDir, "opencode-code-review@1.0.0"));
    expect(result).toContain(join(packagesDir, "opencode-code-review@2.0.0"));
  });
});

describe("purgeDirectory — comprehensive", () => {
  // Spec: deeply nested directory deleted (leaf-first)
  it("deletes deeply nested directory leaf-first", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["level1"])],
      [join("/cache/ocr", "level1"), dir(["level2"])],
      [join("/cache/ocr", "level1", "level2"), dir(["level3"])],
      [join("/cache/ocr", "level1", "level2", "level3"), dir([])],
    ]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    expect(store.has("/cache/ocr")).toBe(false);
    expect(store.has(join("/cache/ocr", "level1"))).toBe(false);
    expect(store.has(join("/cache/ocr", "level1", "level2"))).toBe(false);
    expect(store.has(join("/cache/ocr", "level1", "level2", "level3"))).toBe(
      false,
    );
  });

  // Spec: missing path is skipped (no throw)
  it("skips missing path without throwing", () => {
    const store = new Map<string, DirEntry>([]);
    const fs = makeFakeFs(store);
    expect(() => purgeDirectory(fs, "/nonexistent")).not.toThrow();
  });

  // Spec: per-path failure continuation — one throws, others still purged
  it("continues purging other paths when one throws", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["good", "bad"])],
      [join("/cache/ocr", "good"), dir([])],
      [join("/cache/ocr", "bad"), file()],
    ]);
    const fs = makeFakeFs(store);
    // Make "bad" unlink throw but "good" succeed
    const origUnlink = fs.unlinkSync.bind(fs);
    fs.unlinkSync = (path: string) => {
      if (path === join("/cache/ocr", "bad")) throw new Error("EPERM");
      origUnlink(path);
    };
    purgeDirectory(fs, "/cache/ocr");
    // "good" was removed despite "bad" failing
    expect(store.has(join("/cache/ocr", "good"))).toBe(false);
    // "bad" remains because it threw
    expect(store.has(join("/cache/ocr", "bad"))).toBe(true);
  });

  // Mixed files and directories
  it("handles mixed files and subdirectories", () => {
    const store = new Map<string, DirEntry>([
      ["/cache/ocr", dir(["subdir", "file.txt"])],
      [join("/cache/ocr", "subdir"), dir(["nested-file.txt"])],
      [join("/cache/ocr", "file.txt"), file()],
      [join("/cache/ocr", "subdir", "nested-file.txt"), file()],
    ]);
    const fs = makeFakeFs(store);
    purgeDirectory(fs, "/cache/ocr");
    expect(store.has("/cache/ocr")).toBe(false);
  });
});
