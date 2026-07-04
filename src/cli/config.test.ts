// ---------------------------------------------------------------------------
// src/cli/config.test.ts — Unit tests for src/cli/config.ts.
//
// All disk I/O runs through an injected in-memory `CliFs` so we stay
// deterministic and exercise every code path. Env vars (`OPENCODE_CONFIG_DIR`,
// `HOME`) are saved/restored around every test that touches path resolution.
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
} from "./config.ts";

// ---------------------------------------------------------------------------
// In-memory CliFs adapter
// ---------------------------------------------------------------------------

const createMemFs = (
  initial: Record<string, string> = {},
): CliFs & { __files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();

  const trackDir = (p: string): void => {
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
      trackDir(p);
      files.set(p, c);
    },
    renameSync: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      trackDir(to);
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    copyFileSync: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT: ${from}`);
      trackDir(to);
      files.set(to, files.get(from) as string);
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
        const slash = rest.indexOf("/");
        seen.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return Array.from(seen).sort();
    },
    existsSync: (p) => files.has(p) || dirs.has(p),
  };
  return fs;
};

// ---------------------------------------------------------------------------
// Env save/restore
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
const saveEnv = (): void => {
  savedEnv = {
    HOME: process.env["HOME"],
    OPENCODE_CONFIG_DIR: process.env["OPENCODE_CONFIG_DIR"],
  };
};
const restoreEnv = (): void => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

// ---------------------------------------------------------------------------
// parseJsonc
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

  it("throws on malformed JSON", () => {
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
    expect(normalizePlugin("str")).toEqual([]);
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
// resolveConfigPath
// ---------------------------------------------------------------------------

describe("resolveConfigPath", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("prefers .json over .jsonc when both exist", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
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
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.jsonc": "{}",
    });
    const r = resolveConfigPath(fs);
    expect(r.format).toBe("jsonc");
  });

  it("prefers $OPENCODE_CONFIG_DIR over $HOME", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "/etc/ocr";
    delete process.env["HOME"];
    const fs = createMemFs({ "/etc/ocr/opencode.json": "{}" });
    const r = resolveConfigPath(fs);
    expect(r.path).toBe("/etc/ocr/opencode.json");
  });

  it("returns default .json path with existed=false when nothing exists", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const r = resolveConfigPath(createMemFs());
    expect(r.existed).toBe(false);
    expect(r.path).toBe("/home/me/.config/opencode/opencode.json");
  });

  it("ignores empty $OPENCODE_CONFIG_DIR", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "   ";
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({ "/home/me/.config/opencode/opencode.json": "{}" });
    expect(resolveConfigPath(fs).path).toBe(
      "/home/me/.config/opencode/opencode.json",
    );
  });
});

describe("resolveConfigDir (env precedence)", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("uses $OPENCODE_CONFIG_DIR when set", () => {
    process.env["OPENCODE_CONFIG_DIR"] = "/etc/ocr";
    delete process.env["HOME"];
    expect(resolveConfigDir()).toBe("/etc/ocr");
  });

  it("falls back to $HOME/.config/opencode", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    expect(resolveConfigDir()).toBe("/home/me/.config/opencode");
  });
});

// ---------------------------------------------------------------------------
// loadGlobalConfig
// ---------------------------------------------------------------------------

describe("loadGlobalConfig", () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it("returns config={} and existed=false when file is missing", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const r = loadGlobalConfig(createMemFs());
    expect(r).toEqual({
      path: "/home/me/.config/opencode/opencode.json",
      config: {},
      existed: false,
    });
  });

  it("parses existing .json file", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.json": '{"plugin":["a"]}',
    });
    const r = loadGlobalConfig(fs);
    expect(r.existed).toBe(true);
    expect(r.config).toEqual({ plugin: ["a"] });
  });

  it("strips JSONC comments on read", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.jsonc": `{ // hi\n"plugin": ["a",],\n}`,
    });
    const r = loadGlobalConfig(fs);
    expect(r.config).toEqual({ plugin: ["a"] });
  });

  it("returns parseError when existing file is malformed", () => {
    delete process.env["OPENCODE_CONFIG_DIR"];
    process.env["HOME"] = "/home/me";
    const fs = createMemFs({
      "/home/me/.config/opencode/opencode.json": "{broken",
    });
    const r = loadGlobalConfig(fs);
    expect(r.parseError).toBeDefined();
    expect(r.config).toEqual({});
  });
});
