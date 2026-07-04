// ---------------------------------------------------------------------------
// src/rule-files.test.ts — Unit tests for src/rule-files.ts.
//
// All disk I/O runs through an injected in-memory `RuleFilesFs` so we stay
// deterministic and exercise every code path without touching the real
// filesystem. The adapter mirrors the relevant subset of `node:fs`:
// immediate-child `readdirSync`, `readFileSync`, `existsSync`.
//
// Tests cover:
//   - frontmatter parsing (inline, bracket, YAML list)
//   - dimension validation (known / unknown / empty)
//   - malformed / missing frontmatter handling
//   - global / project merge order
//   - numeric-prefix ordering and alphabetical fallback
//   - recursive discovery
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import {
  KNOWN_DIMENSIONS,
  type RuleFile,
  type RuleFilesFs,
  loadRuleFiles,
  parseFrontmatter,
} from "./rule-files.ts";

// ---------------------------------------------------------------------------
// In-memory RuleFilesFs adapter
// ---------------------------------------------------------------------------

interface MemFs extends RuleFilesFs {
  __files: Map<string, string>;
}

const createMemFs = (initial: Record<string, string> = {}): MemFs => {
  const files = new Map<string, string>(Object.entries(initial));
  const dirs = new Set<string>();

  const trackDir = (filePath: string): void => {
    const parts = filePath.split("/");
    let acc = parts[0] === "" ? "/" : "";
    for (let i = parts[0] === "" ? 1 : 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
      if (acc) dirs.add(acc);
    }
  };

  // Pre-track any directory entries so existsSync() can resolve them.
  const trackDirExplicit = (dir: string): void => {
    if (dir.length > 0) dirs.add(dir);
  };

  for (const k of Object.keys(initial)) trackDir(k);

  return {
    __files: files,
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p) as string;
    },
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
      // Also surface tracked subdirectories that contain no files yet so
      // recursion can still walk into nested folders.
      for (const d of dirs) {
        if (!d.startsWith(prefix)) continue;
        const rest = d.slice(prefix.length);
        if (!rest || rest.includes("/")) continue;
        seen.add(rest);
      }
      return Array.from(seen).sort();
    },
    existsSync: (p) => {
      if (files.has(p)) return true;
      if (dirs.has(p)) return true;
      trackDirExplicit(p);
      return dirs.has(p);
    },
  };
};

// ---------------------------------------------------------------------------
// Convenience: make a rule file with standard frontmatter
// ---------------------------------------------------------------------------

/**
 * Build a markdown string with an inline-array frontmatter block.
 * Pass an empty array for `dimensions: []` (general rules).
 * For YAML-list frontmatter use `yamlRuleFile` below.
 */
const ruleFile = (body: string, dimensions: string[]): string =>
  `---\ndimensions: [${dimensions.join(", ")}]\n---\n\n${body}`;

/** Build a markdown string with a YAML-list frontmatter block. */
const yamlRuleFile = (body: string, dimensions: string[]): string => {
  const lines = ["---", "dimensions:"];
  for (const d of dimensions) lines.push(`  - ${d}`);
  lines.push("---", "");
  return `${lines.join("\n")}${body}`;
};

/** Build a markdown string with frontmatter but NO `dimensions` key. */
const noDimensionsFile = (body: string): string =>
  ["---", "title: example", "---", "", body].join("\n");

/** Build a markdown string with an inline-array frontmatter block using CRLF endings. */
const crlfRuleFile = (body: string, dimensions: string[]): string =>
  `---\r\ndimensions: [${dimensions.join(", ")}]\r\n---\r\n\r\n${body}`;

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("returns null when frontmatter is missing", () => {
    expect(parseFrontmatter("Just a body\n\nMore text")).toBeNull();
  });

  it("returns null when opening fence is missing", () => {
    expect(parseFrontmatter("dimensions: []\n---\n\nbody")).toBeNull();
  });

  it("parses inline empty list `dimensions: []`", () => {
    const r = parseFrontmatter("---\ndimensions: []\n---\n\nbody");
    expect(r).toEqual({ dimensions: [], body: "body" });
  });

  it("parses inline bracket list `dimensions: [security, testing]`", () => {
    const r = parseFrontmatter(
      "---\ndimensions: [security, testing]\n---\n\nbody text",
    );
    expect(r).toEqual({
      dimensions: ["security", "testing"],
      body: "body text",
    });
  });

  it("parses YAML list format", () => {
    const text = [
      "---",
      "dimensions:",
      "  - security",
      "  - testing",
      "---",
      "",
      "body content",
    ].join("\n");
    expect(parseFrontmatter(text)).toEqual({
      dimensions: ["security", "testing"],
      body: "body content",
    });
  });

  it("returns null when `dimensions` key is missing", () => {
    expect(parseFrontmatter("---\ntitle: foo\n---\n\nbody")).toBeNull();
  });

  it("trims whitespace around dimension entries", () => {
    const text = [
      "---",
      "dimensions: [ security ,  testing ]",
      "---",
      "",
      "body",
    ].join("\n");
    expect(parseFrontmatter(text)).toEqual({
      dimensions: ["security", "testing"],
      body: "body",
    });
  });

  it("parses a CRLF document the same as its LF equivalent", () => {
    const crlf = crlfRuleFile("body text", ["security", "testing"]);
    const lf = ruleFile("body text", ["security", "testing"]);
    expect(parseFrontmatter(crlf)).toEqual(parseFrontmatter(lf));
  });

  it("preserves body newlines and blank lines", () => {
    const text =
      "---\ndimensions: []\n---\n\n# Heading\n\nline one\nline two\n";
    expect(parseFrontmatter(text)?.body).toBe(
      "# Heading\n\nline one\nline two\n",
    );
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — empty / missing dirs
// ---------------------------------------------------------------------------

describe("loadRuleFiles — empty / missing directories", () => {
  it("returns [] when neither directory exists", () => {
    const fs = createMemFs();
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toEqual([]);
  });

  it("returns [] when both directories exist but contain no .md files", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/README.txt": "hello",
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — basic loading
// ---------------------------------------------------------------------------

describe("loadRuleFiles — basic loading", () => {
  it("loads a single general rule from global dir", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/general.md": ruleFile(
        "General rule body",
        [],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: "/home/user/.config/opencode/review-rules/general.md",
      scope: "global",
      dimensions: [],
      body: "General rule body",
    });
  });

  it("strips frontmatter from the returned body", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/security.md": ruleFile(
        "# Security rules\n- thing 1\n- thing 2",
        ["security"],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe("# Security rules\n- thing 1\n- thing 2");
    expect(result[0]?.body).not.toContain("dimensions:");
  });

  it("loads from project dir with scope=project", () => {
    const fs = createMemFs({
      "/proj/.opencode/review-rules/local.md": ruleFile("project rule", []),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.scope).toBe("project");
    expect(result[0]?.path).toBe("/proj/.opencode/review-rules/local.md");
  });

  it("loads a CRLF rule file the same as its LF equivalent", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/crlf.md": crlfRuleFile(
        "CRLF body",
        ["security"],
      ),
      "/home/user/.config/opencode/review-rules/lf.md": ruleFile(
        "CRLF body",
        ["security"],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ body: "CRLF body", dimensions: ["security"] });
    expect(result[1]).toMatchObject({ body: "CRLF body", dimensions: ["security"] });
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — merge order
// ---------------------------------------------------------------------------

describe("loadRuleFiles — merge order", () => {
  it("puts global files before project files when sorted equally", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/a.md": ruleFile("g-a", []),
      "/proj/.opencode/review-rules/b.md": ruleFile("p-b", []),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => r.body)).toEqual(["g-a", "p-b"]);
  });

  it("sorts numbered filenames numerically", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/10-late.md": ruleFile(
        "ten",
        [],
      ),
      "/home/user/.config/opencode/review-rules/02-second.md": ruleFile(
        "two",
        [],
      ),
      "/home/user/.config/opencode/review-rules/01-first.md": ruleFile(
        "one",
        [],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => r.body)).toEqual(["one", "two", "ten"]);
  });

  it("sorts unnumbered filenames alphabetically as a fallback", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/zeta.md": ruleFile("z", []),
      "/home/user/.config/opencode/review-rules/alpha.md": ruleFile("a", []),
      "/home/user/.config/opencode/review-rules/middle.md": ruleFile("m", []),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => r.body)).toEqual(["a", "m", "z"]);
  });

  it("puts numbered filenames before unnumbered ones", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/zzz.md": ruleFile("zzz", []),
      "/home/user/.config/opencode/review-rules/01-aaa.md": ruleFile("aaa", []),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => r.body)).toEqual(["aaa", "zzz"]);
  });

  it("interleaves global scope order across both directories", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/01-g-first.md": ruleFile(
        "g-01",
        [],
      ),
      "/home/user/.config/opencode/review-rules/02-g-second.md": ruleFile(
        "g-02",
        [],
      ),
      "/proj/.opencode/review-rules/01-p-first.md": ruleFile("p-01", []),
      "/proj/.opencode/review-rules/zz-late.md": ruleFile("p-zz", []),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => `${r.scope}:${r.body}`)).toEqual([
      "global:g-01",
      "global:g-02",
      "project:p-01",
      "project:p-zz",
    ]);
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — recursive discovery
// ---------------------------------------------------------------------------

describe("loadRuleFiles — recursive discovery", () => {
  it("finds .md files in subdirectories", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/top.md": ruleFile("top", []),
      "/home/user/.config/opencode/review-rules/sub/nested.md": ruleFile(
        "nested",
        [],
      ),
      "/home/user/.config/opencode/review-rules/sub/deep/inner.md": ruleFile(
        "inner",
        [],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => r.body).sort()).toEqual([
      "inner",
      "nested",
      "top",
    ]);
  });

  it("ignores non-.md files at any depth", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/keep.md": ruleFile("keep", []),
      "/home/user/.config/opencode/review-rules/skip.txt": "ignore me",
      "/home/user/.config/opencode/review-rules/sub/skip.json": "{}",
      "/home/user/.config/opencode/review-rules/sub/also-keep.md": ruleFile(
        "also-keep",
        [],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result.map((r) => r.body).sort()).toEqual(["also-keep", "keep"]);
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — frontmatter handling
// ---------------------------------------------------------------------------

describe("loadRuleFiles — frontmatter shapes", () => {
  it("accepts YAML list format", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/yaml.md": yamlRuleFile(
        "yaml body",
        ["security", "testing"],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.dimensions).toEqual(["security", "testing"]);
  });

  it("treats dimensions: [] as general", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/general.md": ruleFile(
        "general body",
        [],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(result[0]?.dimensions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — malformed handling
// ---------------------------------------------------------------------------

describe("loadRuleFiles — malformed handling", () => {
  it("skips files with no frontmatter and warns", () => {
    const warn = vi.fn();
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/bad.md": "no frontmatter here",
      "/home/user/.config/opencode/review-rules/good.md": ruleFile("good", []),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
      warn,
    });
    expect(result.map((r) => r.body)).toEqual(["good"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/bad\.md/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/frontmatter/);
  });

  it("skips files with frontmatter but no dimensions key and warns", () => {
    const warn = vi.fn();
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/notitled.md":
        noDimensionsFile("body"),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
      warn,
    });
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/dimensions/);
  });

  it("warns and skips when all dimensions are unknown", () => {
    const warn = vi.fn();
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/all-unknown.md": ruleFile(
        "body",
        ["nope-1", "nope-2"],
      ),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
      warn,
    });
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/nope-1|nope-2/);
  });

  it("filters unknown dimensions and keeps the file when some are known", () => {
    const warn = vi.fn();
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/mixed.md": ruleFile("body", [
        "security",
        "bogus",
      ]),
    });
    const result = loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
      warn,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.dimensions).toEqual(["security"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/bogus/);
  });

  it("does not warn when all dimensions are known", () => {
    const warn = vi.fn();
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/clean.md": ruleFile("body", [
        "security",
        "testing",
      ]),
    });
    loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses console.warn when no warn callback is supplied", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/no-fm.md": "no frontmatter",
    });
    loadRuleFiles({
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// loadRuleFiles — deterministic ordering of the returned array
// ---------------------------------------------------------------------------

describe("loadRuleFiles — overall determinism", () => {
  it("returns files in a fully deterministic order across multiple runs", () => {
    const fs = createMemFs({
      "/home/user/.config/opencode/review-rules/02.md": ruleFile("g2", []),
      "/home/user/.config/opencode/review-rules/01.md": ruleFile("g1", []),
      "/home/user/.config/opencode/review-rules/a.md": ruleFile("ga", []),
      "/proj/.opencode/review-rules/01.md": ruleFile("p1", []),
      "/proj/.opencode/review-rules/a.md": ruleFile("pa", []),
    });
    const opts = {
      globalDir: "/home/user/.config/opencode/review-rules",
      projectDir: "/proj/.opencode/review-rules",
      knownDimensions: KNOWN_DIMENSIONS,
      fs,
    } as const;
    const first = loadRuleFiles(opts).map((r) => r.body);
    const second = loadRuleFiles(opts).map((r) => r.body);
    const third = loadRuleFiles(opts).map((r) => r.body);
    expect(first).toEqual(["g1", "g2", "ga", "p1", "pa"]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// KNOWN_DIMENSIONS
// ---------------------------------------------------------------------------

describe("KNOWN_DIMENSIONS", () => {
  it("includes all built-in dimensions", () => {
    expect(KNOWN_DIMENSIONS.has("code-quality")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("security")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("performance")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("testing")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("documentation")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("error-handling")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("api-design")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("dependencies")).toBe(true);
    expect(KNOWN_DIMENSIONS.has("maintainability")).toBe(true);
  });

  it("does NOT include arbitrary identifiers", () => {
    expect(KNOWN_DIMENSIONS.has("nope")).toBe(false);
    expect(KNOWN_DIMENSIONS.has("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type sanity (compile-time, but vitest still resolves imports)
// ---------------------------------------------------------------------------

describe("RuleFile shape", () => {
  it("exposes path, scope, dimensions, body fields", () => {
    const sample: RuleFile = {
      path: "/x",
      scope: "global",
      dimensions: ["security"],
      body: "body",
    };
    expect(Object.keys(sample).sort()).toEqual([
      "body",
      "dimensions",
      "path",
      "scope",
    ]);
  });
});
