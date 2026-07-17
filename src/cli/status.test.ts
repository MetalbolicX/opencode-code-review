// ---------------------------------------------------------------------------
// src/cli/status.test.ts — Unit tests for `ocr status`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliFs, PLUGIN_NAME } from "./config.ts";
import { runDoctor, runStatus, type SpawnFn } from "./status.ts";

// ---------------------------------------------------------------------------
// Mock spawn for doctor tests
// ---------------------------------------------------------------------------

/** Successful spawn result (opencode found, version 1.2.3). */
const mockSpawnFound = (): SpawnFn => {
  const fn = vi.fn((...args: unknown[]) => {
    console.error("MOCK SPAWN CALLED:", args);
    return {
      status: 0,
      stdout: "1.2.3\n",
      stderr: "",
      error: undefined,
    };
  });
  return fn as unknown as SpawnFn;
};

/** Failing spawn result (opencode not on PATH). */
const mockSpawnMissing = (): SpawnFn =>
  vi.fn(() => ({
    status: null,
    stdout: "",
    stderr: "",
    error: { code: "ENOENT" },
  })) as unknown as SpawnFn;

const createMemFs = (
  initial: Record<string, string> = {},
): CliFs & { __files: Map<string, string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
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

// ---------------------------------------------------------------------------
// Doctor diagnostics tests
// ---------------------------------------------------------------------------

/** Build a CliFs for a healthy doctor environment. */
const doctorHealthyFs = (): CliFs & { __files: Map<string, string> } => {
  const fs = createMemFs({});
  // Explicitly write to ensure parent dirs are tracked in the mock.
  fs.writeFileSync(CONFIG, JSON.stringify({ plugin: [PLUGIN_NAME] }));
  return fs;
};

describe("runDoctor", () => {
  // Set HOME for the doctor tests so resolveConfigPath uses the test value.
  beforeEach(() => {
    savedEnv = {
      HOME: process.env.HOME,
      OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    };
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.HOME = "/home/test";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reports healthy environment when all checks pass", () => {
    // Ensure HOME is definitely set
    const oldHome = process.env.HOME;
    process.env.HOME = "/home/test";
    try {
      let spawnCalled = false;
      const testSpawnFn: SpawnFn = (..._args: unknown[]) => {
        spawnCalled = true;
        return { status: 0, stdout: "1.2.3\n", stderr: "", error: undefined };
      };
      const fs = doctorHealthyFs();
      const result = runDoctor(fs, process.env, testSpawnFn);
      expect(spawnCalled).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it("returns read-only status that writes no files", () => {
    const spawnFn = mockSpawnFound();
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const writeCalls: [string, string][] = [];
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (p: string, c: string) => {
      writeCalls.push([p, c]);
      return origWriteFileSync(p, c);
    };
    runDoctor(fs, process.env, spawnFn);
    expect(writeCalls).toHaveLength(0);
  });

  it("warns when config has legacy plugins (plural) field", () => {
    const spawnFn = mockSpawnFound();
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugins: [PLUGIN_NAME] }),
    });
    const result = runDoctor(fs, process.env, spawnFn);
    expect(result.warnings.length).toBeGreaterThan(0);
    const pluginsWarning = result.warnings.find((w) => w.includes("plugins"));
    expect(pluginsWarning).toBeDefined();
  });

  it("reports Node < 20 as a failing issue", () => {
    const origVersion = process.version;
    Object.defineProperty(process, "version", { value: "v18.0.0", configurable: true });
    const spawnFn = mockSpawnFound();
    const fs = createMemFs({});
    const result = runDoctor(fs, process.env, spawnFn);
    expect(result.issues.some((issue) => issue.includes("Node"))).toBe(true);
    Object.defineProperty(process, "version", { value: origVersion, configurable: true });
  });

  it("reports missing opencode as a failing issue", () => {
    const spawnFn = mockSpawnMissing();
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const result = runDoctor(fs, process.env, spawnFn);
    expect(result.issues.some((issue) => issue.includes("opencode"))).toBe(true);
  });

  it("reports malformed JSON config as an issue", () => {
    const spawnFn = mockSpawnFound();
    const fs = createMemFs({ [CONFIG]: "{broken" });
    const result = runDoctor(fs, process.env, spawnFn);
    expect(result.issues.some((issue) => issue.includes("malformed"))).toBe(true);
  });

  it("reports non-writable config dir as a failing issue", () => {
    const spawnFn = mockSpawnFound();
    const fs = createMemFs({});
    // Write the config file to ensure parent dirs are tracked in the mock.
    fs.writeFileSync(CONFIG, JSON.stringify({ plugin: [PLUGIN_NAME] }));
    // Override canWrite to return false for the config parent.
    fs.canWrite = () => false;
    const result = runDoctor(fs, process.env, spawnFn);
    expect(result.issues.some((issue) => issue.includes("writable") || issue.includes("write"))).toBe(true);
  });

  it("reports cache presence as an info line", () => {
    const spawnFn = mockSpawnFound();
    const cacheBase = "/home/test/.cache/opencode/packages";
    const fs: CliFs = {
      ...createMemFs({ [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }) }),
      readdirSync: (p: string) => {
        if (p === cacheBase) return [`${PLUGIN_NAME}@1.0.0`];
        return [];
      },
      existsSync: (p: string) => {
        if (p === cacheBase || p.startsWith(cacheBase)) return true;
        return false;
      },
    };
    const result = runDoctor(fs, process.env, spawnFn);
    expect(result.info.some((i) => i.includes("cache") || i.includes("packages"))).toBe(true);
  });

  it("doctor does NOT read source checkout package.json", () => {
    // This is a build-time contract: doctor reports installed/config/process
    // facts only — never inspects the source repository checkout.
    const spawnFn = mockSpawnFound();
    const fs = createMemFs({
      [CONFIG]: JSON.stringify({ plugin: [PLUGIN_NAME] }),
    });
    const readFileSpy = vi.spyOn(fs, "readFileSync");
    runDoctor(fs, process.env, spawnFn);
    // All readFileSync calls must be for the config path, never for
    // package.json in the source checkout.
    for (const [path] of readFileSpy.mock.calls) {
      expect(path).not.toMatch(/package\.json$/);
      expect(path).not.toMatch(/src[\\/]cli[\\/]/);
    }
  });
});
