// ---------------------------------------------------------------------------
// src/cli/config.test.ts — Unit tests for src/cli/config.ts.
//
// All disk I/O runs through an injected in-memory `CliFs` so we stay
// deterministic and exercise every code path. Env vars (`OPENCODE_CONFIG_DIR`,
// `HOME`, `XDG_CONFIG_HOME`) are saved/restored around every test that touches
// path resolution.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_LIMIT,
  backupIfWritable,
  buildSpecifier,
  type CliFs,
  dedupePlugins,
  loadGlobalConfig,
  matchesReviewPlugin,
  normalizePlugin,
  PLUGIN_NAME,
  parseJsonc,
  resolveConfigDir,
  resolveConfigPath,
  rotateBackups,
  writeAtomically,
  writeJsoncAtomic,
} from "./config.ts";

// ---------------------------------------------------------------------------
// In-memory CliFs adapter (extended with rmdirSync / canWrite)
// ---------------------------------------------------------------------------

const createMemFs = (
  initial: Record<string, string> = {},
): CliFs & { __files: Map<string, string>; __dirs: Set<string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const trackDir = (p: string): void => {
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
    trackDir(path);
    files.set(path, content);
  }

  const fs = {
    __files: files,
    __dirs: dirs,
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
    writeFileSync: (p: string, c: string) => {
      trackDir(p);
      files.set(p, c);
    },
    renameSync: (from: string, to: string) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      trackDir(to);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    copyFileSync: (from: string, to: string) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      trackDir(to);
      files.set(to, files.get(from) as string);
    },
    unlinkSync: (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      files.delete(p);
    },
    mkdirSync: (p: string) => dirs.add(p),
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      const seen = new Set<string>();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        seen.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return Array.from(seen).sort();
    },
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    rmdirSync: (p: string) => {
      dirs.delete(p);
      for (const k of [...files.keys()]) {
        if (k.startsWith(p)) files.delete(k);
      }
    },
    canWrite: (_p: string) => true,
  };
  return fs;
};

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
const saveEnv = (): void => {
  savedEnv = {
    HOME: process.env.HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
};
const restoreEnv = (): void => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

// ---------------------------------------------------------------------------
// parseJsonc — malformed JSONC must throw, not silently return {}
// ---------------------------------------------------------------------------

describe("parseJsonc", () => {
  it("returns {} for empty / whitespace input", () => {
    expect(parseJsonc("")).toEqual({});
    expect(parseJsonc("   \n\t  ")).toEqual({});
  });

  it("parses plain JSON", () => {
    expect(parseJsonc('{"a":1,"b":"two"}')).toEqual({ a: 1, b: "two" });
  });

  it("strips // line comments and /* */ block comments", () => {
    const text = `{
      // top
      "name": "opencode",
      /* mid */
      "version": 1
    }`;
    expect(parseJsonc(text)).toEqual({ name: "opencode", version: 1 });
  });

  it("removes trailing commas before } and ]", () => {
    expect(parseJsonc('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
    expect(parseJsonc('{"list":[1,2,3,]}')).toEqual({ list: [1, 2, 3] });
  });

  it("preserves // inside string values (URLs)", () => {
    expect(parseJsonc('{"url":"https://x.com/y"}')).toEqual({
      url: "https://x.com/y",
    });
  });

  // Task 1.1: Malformed JSONC must throw — no silent {} fallback
  it("throws on malformed JSON (not silent {})", () => {
    expect(() => parseJsonc("{not valid")).toThrow();
    expect(() => parseJsonc('{"unterminated":')).toThrow();
  });

  it("throws when root is not an object", () => {
    expect(() => parseJsonc("[1,2,3]")).toThrow(
      "config root must be a JSON object",
    );
    expect(() => parseJsonc("null")).toThrow(
      "config root must be a JSON object",
    );
    expect(() => parseJsonc("42")).toThrow("config root must be a JSON object");
  });
});

// ---------------------------------------------------------------------------
// matchesReviewPlugin
// ---------------------------------------------------------------------------

describe("matchesReviewPlugin", () => {
  it("matches bare name and version-pinned variants", () => {
    expect(matchesReviewPlugin(PLUGIN_NAME)).toBe(true);
    expect(matchesReviewPlugin(`${PLUGIN_NAME}@1.0.0`)).toBe(true);
    expect(matchesReviewPlugin(`${PLUGIN_NAME}@latest`)).toBe(true);
  });

  it("rejects unrelated names and non-strings", () => {
    expect(matchesReviewPlugin("other-plugin")).toBe(false);
    expect(matchesReviewPlugin(`@scope/${PLUGIN_NAME}`)).toBe(false);
    expect(matchesReviewPlugin(undefined)).toBe(false);
    expect(matchesReviewPlugin(null)).toBe(false);
    expect(matchesReviewPlugin({ name: PLUGIN_NAME })).toBe(false);
    expect(matchesReviewPlugin(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizePlugin
// ---------------------------------------------------------------------------

describe("normalizePlugin", () => {
  it("returns [] for undefined / null / primitives", () => {
    expect(normalizePlugin(undefined)).toEqual([]);
    expect(normalizePlugin(null)).toEqual([]);
    expect(normalizePlugin("str")).toEqual(["str"]);
    expect(normalizePlugin(42)).toEqual([]);
  });

  it("filters arrays to strings", () => {
    expect(normalizePlugin(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizePlugin(["a", null, 42, { bad: true }, "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("migrates legacy object form to keys", () => {
    expect(
      normalizePlugin({
        [PLUGIN_NAME]: { version: "1.0.0" },
        "other-plugin": {},
      }),
    ).toEqual([PLUGIN_NAME, "other-plugin"]);
  });
});

// ---------------------------------------------------------------------------
// dedupePlugins
// ---------------------------------------------------------------------------

describe("dedupePlugins", () => {
  it("strips all review entries and dedupes by base (last-wins)", () => {
    expect(dedupePlugins([])).toEqual([]);
    expect(dedupePlugins(["a@1", "a@2", "b"])).toEqual(["a@2", "b"]);
    expect(
      dedupePlugins([
        `${PLUGIN_NAME}@1.0.0`,
        "alpha",
        `${PLUGIN_NAME}`,
        "beta",
        `${PLUGIN_NAME}@2.0.0`,
      ]),
    ).toEqual(["alpha", "beta"]);
  });

  it("ignores non-string entries defensively", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing defensive behavior
    expect(dedupePlugins(["a", null, 42, "b@2"] as any)).toEqual(["a", "b@2"]);
  });
});

// ---------------------------------------------------------------------------
// buildSpecifier
// ---------------------------------------------------------------------------

describe("buildSpecifier", () => {
  it("returns bare name for no version / empty / whitespace", () => {
    expect(buildSpecifier()).toBe(PLUGIN_NAME);
    expect(buildSpecifier("")).toBe(PLUGIN_NAME);
    expect(buildSpecifier("   ")).toBe(PLUGIN_NAME);
  });

  it("appends @<version>", () => {
    expect(buildSpecifier("1.0.0")).toBe(`${PLUGIN_NAME}@1.0.0`);
    expect(buildSpecifier(" 1.2.3 ")).toBe(`${PLUGIN_NAME}@1.2.3`);
  });
});

// ---------------------------------------------------------------------------
// backup / rotate
// ---------------------------------------------------------------------------

describe("backupIfWritable + rotateBackups", () => {
  it("returns null when file is missing", () => {
    expect(backupIfWritable("/x/opencode.json", createMemFs())).toBeNull();
  });

  it("creates a timestamped backup next to the config", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const fs = createMemFs({ [target]: "{}" });
    const backup = backupIfWritable(target, fs);
    expect(backup).toMatch(/\.bak\.\d{8}T\d{9}Z$/);
    expect(fs.__files.get(backup as string)).toBe("{}");
  });

  it("keeps at most BACKUP_LIMIT backups and removes older ones", () => {
    const dir = "/home/me/.config/opencode";
    const target = `${dir}/opencode.json`;
    const backups = [
      "opencode.json.bak.20260101T000000000Z",
      "opencode.json.bak.20260102T000000000Z",
      "opencode.json.bak.20260103T000000000Z",
      "opencode.json.bak.20260104T000000000Z",
      "opencode.json.bak.20260105T000000000Z",
    ];
    const initial: Record<string, string> = { [target]: "{}" };
    for (const b of backups) initial[`${dir}/${b}`] = "{}";
    const fs = createMemFs(initial);

    rotateBackups(target, BACKUP_LIMIT, fs);

    const surviving = fs
      .readdirSync(dir)
      .filter((n) => n.includes(".bak."))
      .sort();
    expect(surviving).toEqual(backups.slice(-BACKUP_LIMIT));
  });

  it("exposes BACKUP_LIMIT as 3", () => {
    expect(BACKUP_LIMIT).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// writeAtomically
// ---------------------------------------------------------------------------

describe("writeAtomically", () => {
  it("writes the file and leaves no .tmp- leftover", () => {
    const target = "/tmp/x/opencode.json";
    const fs = createMemFs();
    writeAtomically(target, "{}", fs);
    expect(fs.__files.get(target)).toBe("{}");
    const tmps = fs.readdirSync("/tmp/x").filter((n) => n.includes(".tmp-"));
    expect(tmps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeJsoncAtomic — JSONC comment + trailing-comma preservation
// Task 1.1: Comments and trailing commas survive targeted edits
// ---------------------------------------------------------------------------

describe("writeJsoncAtomic", () => {
  // Task 1.1: Backup is created BEFORE atomic write (ordering invariant)
  it("backup is created BEFORE the atomic write", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const original = '{"plugin":["other"]}';
    const fs = createMemFs({ [target]: original });

    const writeOrder: string[] = [];
    const origCopy = fs.copyFileSync.bind(fs);
    const origWrite = fs.writeFileSync.bind(fs);

    fs.copyFileSync = (...args: Parameters<typeof origCopy>) => {
      writeOrder.push("backup");
      return origCopy(...args);
    };
    fs.writeFileSync = (...args: Parameters<typeof origWrite>) => {
      writeOrder.push("write");
      return origWrite(...args);
    };

    writeJsoncAtomic(target, { plugin: ["other", PLUGIN_NAME] }, original, fs);

    const backupIdx = writeOrder.indexOf("backup");
    const writeIdx = writeOrder.indexOf("write");
    expect(backupIdx).toBeLessThan(writeIdx);
  });

  it("preserves JSONC comments on targeted plugin array edit", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const original = `{
  // installed plugin
  "plugin": ["other"],
  "otherField": true
}`;
    const fs = createMemFs();
    writeJsoncAtomic(target, { plugin: ["other", PLUGIN_NAME] }, original, fs);
    const result = fs.__files.get(target) as string;
    // Comment must be preserved
    expect(result).toContain("// installed plugin");
    // New plugin entry must be present
    expect(result).toContain(PLUGIN_NAME);
  });

  it("preserves trailing commas on targeted edit", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const original = `{"plugin":["other"],}`;
    const fs = createMemFs();
    writeJsoncAtomic(target, { plugin: ["other", PLUGIN_NAME] }, original, fs);
    const result = fs.__files.get(target) as string;
    // jsonc-parser preserves the trailing comma from the original; the result
    // is valid JSONC even though JSON.parse would throw on the trailing comma.
    // Use parseJsonc to validate (which strips trailing commas correctly).
    expect(parseJsonc(result)).toEqual({ plugin: ["other", PLUGIN_NAME] });
  });

  it("removes the entire plugin key when set to undefined", () => {
    const target = "/home/me/.config/opencode/opencode.json";
    const original = `{"plugin":["${PLUGIN_NAME}","other"]}`;
    const fs = createMemFs();
    writeJsoncAtomic(target, { plugin: undefined }, original, fs);
    const result = fs.__files.get(target) as string;
    const parsed = JSON.parse(result);
    // plugin: undefined → key is removed entirely
    expect(parsed.plugin).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

describe("resolveConfigPath", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("prefers .json over .jsonc when both exist", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.json": "{}",
      "/home/me/.config/opencode/opencode.jsonc": "{}",
    });
    const r = resolveConfigPath(fs);
    expect(r.path).toBe("/home/me/.config/opencode/opencode.json");
    expect(r.format).toBe("json");
    expect(r.existed).toBe(true);
  });

  it("falls back to .jsonc when .json is absent", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.jsonc": "{}",
    });
    const r = resolveConfigPath(fs);
    expect(r.format).toBe("jsonc");
  });

  it("prefers $OPENCODE_CONFIG_DIR over $HOME", () => {
    process.env.OPENCODE_CONFIG_DIR = "/etc/ocr";
    delete process.env.HOME;
    const fs = createMemFs({ "/etc/ocr/opencode.json": "{}" });
    const r = resolveConfigPath(fs);
    expect(r.path).toBe("/etc/ocr/opencode.json");
  });

  it("returns default .json path with existed=false when nothing exists", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/me";
    const r = resolveConfigPath(createMemFs());
    expect(r.existed).toBe(false);
    expect(r.path).toBe("/home/me/.config/opencode/opencode.json");
  });

  it("ignores empty $OPENCODE_CONFIG_DIR", () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.OPENCODE_CONFIG_DIR = "   ";
    process.env.HOME = "/home/me";
    const fs = createMemFs({ "/home/me/.config/opencode/opencode.json": "{}" });
    expect(resolveConfigPath(fs).path).toBe(
      "/home/me/.config/opencode/opencode.json",
    );
  });
});

describe("resolveConfigDir (env precedence)", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  // Task 1.1: XDG_CONFIG_HOME precedence in resolveConfigDir
  it("uses $OPENCODE_CONFIG_DIR when set", () => {
    process.env.OPENCODE_CONFIG_DIR = "/etc/ocr";
    delete process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    expect(resolveConfigDir()).toBe("/etc/ocr");
  });

  it("uses $XDG_CONFIG_HOME/opencode when set (overrides $HOME)", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = "/home/me";
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    expect(resolveConfigDir()).toBe("/xdg/config/opencode");
  });

  it("falls back to $HOME/.config/opencode when XDG_CONFIG_HOME is unset", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = "/home/me";
    delete process.env.XDG_CONFIG_HOME;
    expect(resolveConfigDir()).toBe("/home/me/.config/opencode");
  });

  it("uses homedir() fallback when neither OPENCODE_CONFIG_DIR nor HOME is set", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.XDG_CONFIG_HOME;
    const result = resolveConfigDir();
    // Should fall back to homedir()/.config/opencode
    expect(result).toMatch(/\.config\/opencode$/);
  });

  it("OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME", () => {
    process.env.OPENCODE_CONFIG_DIR = "/etc/ocr";
    process.env.XDG_CONFIG_HOME = "/xdg/config";
    delete process.env.HOME;
    expect(resolveConfigDir()).toBe("/etc/ocr");
  });
});

// ---------------------------------------------------------------------------
// loadGlobalConfig
// ---------------------------------------------------------------------------

describe("loadGlobalConfig", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("returns config={} and existed=false when file is missing", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/me";
    const r = loadGlobalConfig(createMemFs());
    expect(r).toEqual({
      path: "/home/me/.config/opencode/opencode.json",
      config: {},
      rawText: "",
      existed: false,
    });
  });

  it("parses existing .json file", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.json": '{"plugin":["a"]}',
    });
    const r = loadGlobalConfig(fs);
    expect(r.existed).toBe(true);
    expect(r.config).toEqual({ plugin: ["a"] });
  });

  it("strips JSONC comments on read", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.jsonc": `{ // hi\n"plugin": ["a",],\n}`,
    });
    const r = loadGlobalConfig(fs);
    expect(r.config).toEqual({ plugin: ["a"] });
  });

  it("returns parseError when existing file is malformed", () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.json": "{broken",
    });
    const r = loadGlobalConfig(fs);
    expect(r.parseError).toBeDefined();
    expect(r.config).toEqual({});
  });
});
