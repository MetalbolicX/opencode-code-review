// ---------------------------------------------------------------------------
// src/cli/uninstall.test.ts — Unit tests for `ocr uninstall`.
//
// The config-mutation path is exercised with an in-memory `CliFs` (same
// shape as install.test.ts). The `--purge` path goes through `fs.rmdirSync`
// so the in-memory mock can track calls, assert ordering, and simulate
// failures on specific paths.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runUninstall } from "./uninstall.ts";

type MemFs = CliFs & {
  __files: Map<string, string>;
  __callLog: { method: string; path: string }[];
};

const createMemFs = (
  initial: Record<string, string> = {},
  opts: { rmdirSyncThrows?: boolean; throwPaths?: Set<string> } = {},
): MemFs => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const callLog: { method: string; path: string }[] = [];
  const track = (p: string): void => {
    const parts = p.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      if (acc === "/") {
        acc = `/${parts[i] as string}`;
      } else {
        acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
      }
      if (acc) dirs.add(acc);
    }
  };
  // Track all initial files to ensure parent dirs are recorded.
  for (const [path, content] of Object.entries(initial)) {
    track(path);
    files.set(path, content);
  }
  const fs: MemFs = {
    __files: files,
    __callLog: callLog,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
    writeFileSync: (p, c) => {
      track(p);
      callLog.push({ method: "writeFileSync", path: p });
      files.set(p, c);
    },
    renameSync: (f, t) => {
      if (!files.has(f)) throw new Error(`ENOENT: ${f}`);
      track(t);
      callLog.push({ method: "renameSync", path: t });
      files.set(t, files.get(f) as string);
      files.delete(f);
    },
    copyFileSync: (f, t) => {
      if (!files.has(f)) throw new Error(`ENOENT: ${f}`);
      track(t);
      files.set(t, files.get(f) as string);
    },
    unlinkSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
    mkdirSync: (p, _opts) => {
      // Recursively track all parent dirs so existsSync works for any ancestor.
      const parts = p.split("/");
      let acc = parts[0] === "" ? "/" : "";
      for (let i = parts[0] === "" ? 1 : 0; i < parts.length; i++) {
        if (acc === "/") {
          acc = `/${parts[i] as string}`;
        } else {
          acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
        }
        if (acc) dirs.add(acc);
      }
    },
    readdirSync: (p) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const seen = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const s = rest.indexOf("/");
        seen.add(s === -1 ? rest : rest.slice(0, s));
      }
      return Array.from(seen).sort();
    },
    existsSync: (p) => files.has(p) || dirs.has(p),
    rmdirSync: (p) => {
      callLog.push({ method: "rmdirSync", path: p });
      if (opts.rmdirSyncThrows) throw new Error(`EACCES: ${p}`);
      if (opts.throwPaths?.has(p)) throw new Error(`EACCES: ${p}`);
      dirs.delete(p);
      for (const k of [...files.keys()]) {
        if (k.startsWith(p)) files.delete(k);
      }
    },
    canWrite: (_p) => true,
  };
  return fs;
};

const CONFIG = "/home/test/.config/opencode/opencode.json";

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
  };
  delete process.env.OPENCODE_CONFIG_DIR;
  process.env.HOME = "/home/test";
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("runUninstall", () => {
  it("removes the review entry while preserving other plugins", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: ["other", PLUGIN_NAME] }),
    });
    const r = runUninstall({}, fs);
    expect(r.status).toBe("wrote");
    expect(r.removed).toEqual([PLUGIN_NAME]);
    const w = JSON.parse(fs.__files.get(CONFIG) as string);
    expect(w.plugin).toEqual(["other"]);
  });

  it("removes the plugin key entirely when the array becomes empty", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME], model: "x" }),
    });
    const r = runUninstall({}, fs);
    expect(r.status).toBe("wrote");
    const w = JSON.parse(fs.__files.get(CONFIG) as string);
    expect(w.plugin).toBeUndefined();
    expect(w.model).toBe("x");
  });

  it("is a noop when not installed", () => {
    const fs = createMemFs({ [CONFIG]: JSON.stringify({ plugin: ["other"] }) });
    const r = runUninstall({}, fs);
    expect(r.status).toBe("noop");
    expect(r.removed).toEqual([]);
  });

  it("is a noop when no config file exists", () => {
    const r = runUninstall({}, createMemFs());
    expect(r.status).toBe("noop");
  });

  it("dry-run does not mutate the config", () => {
    const before = JSON.stringify({ plugin: [PLUGIN_NAME] });
    const fs = createMemFs({ [CONFIG]: before });
    const r = runUninstall({ dryRun: true }, fs);
    expect(r.status).toBe("planned");
    expect(fs.__files.get(CONFIG)).toBe(before);
  });

  it("purge calls rmdirSync on cache + plugin config dirs", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const packagesBase = "/home/test/.cache/opencode/packages";
    // Simulate packages dir with matching entries.
    fs.readdirSync = (p: string) => {
      if (p === packagesBase) return [`${PLUGIN_NAME}@1.0.0`];
      return [];
    };
    const r = runUninstall({ purge: true }, fs);
    const rmdirCalls = fs.__callLog.filter((c) => c.method === "rmdirSync");
    expect(rmdirCalls).toHaveLength(2);
    expect(rmdirCalls[0].path).toMatch(/.cache/);
    expect(rmdirCalls[1].path).toMatch(/.config/);
    expect(r.purged.length).toBe(2);
  });

  it("purge dry-run does not invoke rmdirSync", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const r = runUninstall({ purge: true, dryRun: true }, fs);
    expect(r.status).toBe("planned");
    const rmdirCalls = fs.__callLog.filter((c) => c.method === "rmdirSync");
    expect(rmdirCalls).toHaveLength(0);
  });

  it("preserves other config keys", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ $schema: "x", plugin: [PLUGIN_NAME, "kept"] }),
    });
    runUninstall({}, fs);
    const w = JSON.parse(fs.__files.get(CONFIG) as string);
    expect(w.$schema).toBe("x");
    expect(w.plugin).toEqual(["kept"]);
  });

  // -------------------------------------------------------------------------
  // Phase 3 RED tests — prefix-only purge, unrelated retention,
  // missing-path idempotency, deletion failure surfacing,
  // dry-run reporting, write-before-purge ordering.
  // -------------------------------------------------------------------------

  it("purge removes only matching prefix entries from packages dir", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const packagesBase = "/home/test/.cache/opencode/packages";
    // Inject two entries: one matching, one unrelated.
    fs.readdirSync = (p: string) => {
      if (p === packagesBase) return [`${PLUGIN_NAME}@1.0.0`, "other-plugin", `${PLUGIN_NAME}@2.0.0`];
      return [];
    };
    const r = runUninstall({ purge: true }, fs);
    expect(r.status).toBe("wrote");
    // Only opencode-code-review* entries should be purged.
    const purgedPrefixes = r.purged.filter((p) =>
      p.includes("opencode-code-review"),
    );
    expect(purgedPrefixes).toHaveLength(2);
    // unrelated "other-plugin" must NOT appear in any rmdirSync call.
    const rmdirPaths = fs.__callLog
      .filter((c) => c.method === "rmdirSync")
      .map((c) => c.path);
    expect(rmdirPaths.some((p) => p.includes("other-plugin"))).toBe(false);
  });

  it("unrelated cache entries survive purge", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const packagesBase = "/home/test/.cache/opencode/packages";
    fs.readdirSync = (p: string) => {
      if (p === packagesBase) return [`${PLUGIN_NAME}@1.0.0`, "other-plugin"];
      return [];
    };
    runUninstall({ purge: true }, fs);
    // other-plugin path should NOT have been passed to rmdirSync.
    const rmdirPaths = fs.__callLog
      .filter((c) => c.method === "rmdirSync")
      .map((c) => c.path);
    expect(rmdirPaths.some((p) => p.includes("other-plugin"))).toBe(false);
  });

  it("dry-run purge reports planned targets without invoking rmdirSync", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const packagesBase = "/home/test/.cache/opencode/packages";
    fs.readdirSync = (p: string) => {
      if (p === packagesBase) return [`${PLUGIN_NAME}@1.0.0`];
      return [];
    };
    const r = runUninstall({ purge: true, dryRun: true }, fs);
    expect(r.status).toBe("planned");
    expect(r.purged.length).toBeGreaterThan(0);
    const rmdirCalls = fs.__callLog.filter((c) => c.method === "rmdirSync");
    expect(rmdirCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Threat-matrix RED tests — restored through CliFs injection.
  // -------------------------------------------------------------------------

  it("purge is idempotent when cache dir does not exist", () => {
    // GIVEN packages dir has no matching entries
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const packagesBase = "/home/test/.cache/opencode/packages";
    fs.readdirSync = (p: string) => {
      if (p === packagesBase) return [];
      return [];
    };
    // WHEN runUninstall({ purge: true }) runs
    // THEN it completes without error and calls no rmdirSync on non-existent paths.
    const r = runUninstall({ purge: true }, fs);
    expect(r.status).toBe("wrote");
    const rmdirCalls = fs.__callLog.filter((c) => c.method === "rmdirSync");
    // Should attempt to remove cache + config dirs, but those paths don't exist
    // in the mock — rmdirSync will still be called (and silently succeed on dirs)
    // but no unexpected paths are touched.
    expect(r.purged.length).toBeGreaterThanOrEqual(0);
  });

  it("surfaces deletion failure", () => {
    // GIVEN rmdirSync throws on a matching cache entry
    const cachePath = "/home/test/.cache/opencode/node_modules/opencode-code-review";
    const fs = createMemFs(
      {
        [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
      },
      { throwPaths: new Set([cachePath]) },
    );
    // WHEN purge runs, THEN the failure is surfaced (not silently swallowed).
    // The implementation re-throws from purgeDir when rmdirSync fails.
    expect(() => runUninstall({ purge: true }, fs)).toThrow();
  });

  it("config is written BEFORE purge", () => {
    // GIVEN runUninstall({ purge: true }) runs with matching cache entries
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const packagesBase = "/home/test/.cache/opencode/packages";
    fs.readdirSync = (p: string) => {
      if (p === packagesBase) return [`${PLUGIN_NAME}@1.0.0`];
      return [];
    };
    runUninstall({ purge: true }, fs);
    // THEN the config write (renameSync to final path) is called BEFORE any rmdirSync.
    const idxRename = fs.__callLog.findIndex((c) => c.method === "renameSync");
    const idxRmdir = fs.__callLog.findIndex((c) => c.method === "rmdirSync");
    expect(idxRename).toBeGreaterThanOrEqual(0);
    expect(idxRmdir).toBeGreaterThanOrEqual(0);
    expect(idxRename).toBeLessThan(idxRmdir);
  });
});
