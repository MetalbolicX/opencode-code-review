// ---------------------------------------------------------------------------
// src/cli/uninstall.test.ts — Unit tests for `ocr uninstall`.
//
// The config-mutation path is exercised with an in-memory `CliFs` (same
// shape as install.test.ts). The `--purge` path uses `node:fs.rmSync`
// directly, so we `vi.mock` that to capture the calls and stub failures.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runUninstall } from "./uninstall.ts";

vi.mock("node:fs", async (importOriginal) => {
  // biome-ignore lint/suspicious/noExplicitAny: forwarding node:fs surface
  const actual = await importOriginal<any>();
  return { ...actual, rmSync: vi.fn() };
});

const { rmSync } = await import("node:fs");

const createMemFs = (
  initial: Record<string, string> = {},
): CliFs & { __files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();
  const track = (p: string): void => {
    const parts = p.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
      if (acc) dirs.add(acc);
    }
  };
  const fs: CliFs & { __files: Map<string, string> } = {
    __files: files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
    writeFileSync: (p, c) => {
      track(p);
      files.set(p, c);
    },
    renameSync: (f, t) => {
      if (!files.has(f)) throw new Error(`ENOENT: ${f}`);
      track(t);
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
    mkdirSync: (p) => dirs.add(p),
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
  vi.mocked(rmSync).mockReset();
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

  it("purge calls rmSync on cache + plugin config dirs", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    vi.mocked(rmSync).mockReturnValue(undefined);
    const r = runUninstall({ purge: true }, fs);
    expect(rmSync).toHaveBeenCalledTimes(2);
    expect(rmSync).toHaveBeenCalledWith(
      expect.stringContaining(".cache"),
      expect.any(Object),
    );
    expect(rmSync).toHaveBeenCalledWith(
      expect.stringContaining(".config"),
      expect.any(Object),
    );
    expect(r.purged.length).toBe(2);
  });

  it("purge dry-run plans but does not invoke rmSync", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const r = runUninstall({ purge: true, dryRun: true }, fs);
    expect(r.status).toBe("planned");
    expect(rmSync).not.toHaveBeenCalled();
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
});
