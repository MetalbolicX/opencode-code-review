// ---------------------------------------------------------------------------
// src/cli/install.test.ts — Unit tests for `ocr install`.
//
// `runInstall` is the heart of the installer: load → normalize → dedupe →
// backup → atomic write. We exercise every branch with an in-memory
// `CliFs` so nothing ever touches the real filesystem. `console.log` is
// silenced so the test output stays clean.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runInstall } from "./install.ts";

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
    HOME: process.env["HOME"],
    OPENCODE_CONFIG_DIR: process.env["OPENCODE_CONFIG_DIR"],
  };
  delete process.env["OPENCODE_CONFIG_DIR"];
  process.env["HOME"] = "/home/test";
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("runInstall", () => {
  it("creates a fresh config with one plugin entry", () => {
    const fs = createMemFs();
    const r = runInstall({}, fs);
    expect(r.status).toBe("wrote");
    expect(r.specifier).toBe(PLUGIN_NAME);
    const written = JSON.parse(fs.__files.get(CONFIG) as string);
    expect(written.plugin).toEqual([PLUGIN_NAME]);
  });

  it("is a noop when the same version is already installed", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const r = runInstall({}, fs);
    expect(r.status).toBe("noop");
  });

  it("updates the version when reinstalled with a different version", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [`${PLUGIN_NAME}@1.0.0`, "other"] }),
    });
    const r = runInstall({ version: "2.0.0" }, fs);
    expect(r.status).toBe("wrote");
    const written = JSON.parse(fs.__files.get(CONFIG) as string);
    expect(written.plugin).toEqual(["other", `${PLUGIN_NAME}@2.0.0`]);
  });

  it("preserves other config keys and other plugins", () => {
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({
        $schema: "https://x/y",
        model: "anthropic/claude",
        plugin: ["alpha", "beta"],
      }),
    });
    const r = runInstall({}, fs);
    expect(r.status).toBe("wrote");
    const w = JSON.parse(fs.__files.get(CONFIG) as string);
    expect(w.$schema).toBe("https://x/y");
    expect(w.model).toBe("anthropic/claude");
    expect(w.plugin).toEqual(["alpha", "beta", PLUGIN_NAME]);
  });

  it("dry-run does not write any file", () => {
    const fs = createMemFs();
    const r = runInstall({ dryRun: true }, fs);
    expect(r.status).toBe("planned");
    expect(fs.__files.has(CONFIG)).toBe(false);
  });

  it("dry-run with existing config does not mutate", () => {
    const before = JSON.stringify({ plugin: ["x"] });
    const fs = createMemFs({ [CONFIG]: before });
    const r = runInstall({ dryRun: true }, fs);
    expect(r.status).toBe("planned");
    expect(fs.__files.get(CONFIG)).toBe(before);
  });

  it("throws on a malformed existing config", () => {
    const fs = createMemFs({ [CONFIG]: "{broken" });
    expect(() => runInstall({}, fs)).toThrow("malformed JSON");
  });

  it("creates a backup before overwriting an existing file", () => {
    const fs = createMemFs({ [CONFIG]: JSON.stringify({ plugin: ["old"] }) });
    const r = runInstall({}, fs);
    expect(r.backup).toMatch(/\.bak\.\d{8}T\d{9}Z$/);
  });
});
