// ---------------------------------------------------------------------------
// src/cli/status.test.ts — Unit tests for `ocr status`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runStatus } from "./status.ts";

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

describe("runStatus", () => {
  it("reports installed=true and the active specifier when present", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: ["other", PLUGIN_NAME] }),
    });
    const r = runStatus(fs);
    expect(r.installed).toBe(true);
    expect(r.specifier).toBe(PLUGIN_NAME);
    expect(r.extras).toEqual(["other"]);
    expect(r.format).toBe("json");
  });

  it("reports installed=false when no review entry exists", () => {
    const fs = createMemFs({ [CONFIG]: JSON.stringify({ plugin: ["other"] }) });
    const r = runStatus(fs);
    expect(r.installed).toBe(false);
    expect(r.specifier).toBeNull();
    expect(r.extras).toEqual(["other"]);
  });

  it("reports installed=false when the config file is missing", () => {
    const r = runStatus(createMemFs());
    expect(r.installed).toBe(false);
    expect(r.specifier).toBeNull();
  });

  it("throws a descriptive error when the config file is malformed JSON", () => {
    const fs = createMemFs({ [CONFIG]: "{broken" });
    expect(() => runStatus(fs)).toThrow(/malformed JSON/);
    expect(() => runStatus(fs)).toThrow(CONFIG);
  });
});
