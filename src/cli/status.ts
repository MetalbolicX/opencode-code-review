// ---------------------------------------------------------------------------
// src/cli/status.ts — `ocr status` and `ocr doctor` commands.
//
// `status` reports whether the plugin is installed (and at what version)
// in the global OpenCode config — it's a read-only, idempotent probe
// suitable for scripting.
//
// `doctor` aggregates environment health: Node version, OpenCode presence,
// config validity, legacy field warnings, cache presence, and config-dir
// writability. It NEVER reads the source checkout's package.json — that
// is a build-time `package-metadata.test.ts` concern.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CliFs,
  loadGlobalConfig,
  matchesReviewPlugin,
  normalizePlugin,
  resolveConfigPath,
} from "./config.ts";
import { createRealFs } from "./real-fs.ts";

export interface StatusResult {
  /** Whether an `opencode-code-review` entry is present in `plugin`. */
  installed: boolean;
  /** Resolved config path the loader used. */
  path: string;
  /** Detected on-disk format. */
  format: "json" | "jsonc";
  /** The active specifier, or `null` when not installed. */
  specifier: string | null;
  /** Other plugin entries preserved alongside the review one. */
  extras: string[];
}

const formatFromPath = (path: string): "json" | "jsonc" =>
  path.endsWith(".jsonc") ? "jsonc" : "json";

/**
 * Read-only status probe. Prints a human-readable report to stdout and
 * returns the same data as a structured result so callers (including
 * `main.ts` and tests) can consume it without parsing the message.
 *
 * If the global config exists but cannot be parsed, this throws a
 * descriptive error before producing any `Installed:` output. That keeps
 * `status` aligned with `install` / `uninstall`, which both refuse to
 * silently treat malformed JSON as "not installed". The shared
 * dispatcher in `main.ts` catches the throw and returns exit code 1.
 */
export const runStatus = (
  fs: CliFs = createRealFs(),
  env: NodeJS.ProcessEnv = process.env,
): StatusResult => {
  const loaded = loadGlobalConfig(fs, env);

  if (loaded.parseError) {
    throw new Error(
      `Config file is malformed JSON — aborting to avoid a misleading status.\n` +
        `  path:  ${loaded.path}\n` +
        `  error: ${loaded.parseError}\n` +
        `Fix the JSON error and re-run.`,
    );
  }

  const plugins = normalizePlugin(loaded.config.plugin);
  const reviewEntries = plugins.filter(matchesReviewPlugin);
  const extras = plugins.filter((entry) => !matchesReviewPlugin(entry));
  const format = formatFromPath(loaded.path);

  console.log(`Config path:    ${loaded.path}`);
  console.log(`Format:         ${format}`);
  console.log(
    `Exists on disk: ${loaded.existed ? "yes" : "no (will be created on install)"}`,
  );

  if (reviewEntries.length === 0) {
    console.log(`Installed:      no`);
    return {
      installed: false,
      path: loaded.path,
      format,
      specifier: null,
      extras,
    };
  }

  // In practice `install` dedupes so at most one review entry survives;
  // reporting the first keeps the output stable for scripting.
  const specifier = reviewEntries[0] ?? null;
  console.log(`Installed:      yes`);
  console.log(`Specifier:      ${specifier}`);
  if (extras.length > 0) {
    console.log(`Other plugins:  ${extras.join(", ")}`);
  }

  return {
    installed: true,
    path: loaded.path,
    format,
    specifier,
    extras,
  };
};

// ---------------------------------------------------------------------------
// Doctor diagnostics
// ---------------------------------------------------------------------------

/** Minimum supported Node.js version. */
const MIN_NODE_VERSION = 20;

/**
 * Parsed Node version result.
 * @param version - E.g. "v20.3.1" → { major: 20, minor: 3, patch: 1 }
 */
const parseNodeVersion = (
  version: string,
): { major: number; minor: number; patch: number } | null => {
  const m = version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
};

/**
 * Result of a doctor diagnostics run.
 * `ok` is true when there are zero issues. Warnings are non-fatal;
 * all issues are collected in `issues`.
 */
export interface DoctorResult {
  /** True when no fatal issues were found. */
  ok: boolean;
  /** Fatal issues that prevent correct operation. */
  issues: string[];
  /** Non-fatal warnings (e.g. legacy fields, missing optional metadata). */
  warnings: string[];
  /** Informational lines (e.g. cache presence). */
  info: string[];
}

/**
 * Signature of `spawnSync` — extracted as a type so it can be injected in tests.
 * Production code passes the real `spawnSync`; tests pass a mock function.
 */
export type SpawnFn = (
  cmd: string,
  args?: ReadonlyArray<string> | object,
  _opts?: object,
) => { status: number | null; stdout: string; stderr: string; error?: { code: string } };

const makeSpawnFn = (spawnSync: typeof import("node:child_process").spawnSync): SpawnFn =>
  (cmd, args, _opts) => {
    const result = spawnSync(cmd, args as Parameters<typeof spawnSync>[1]);
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      error: result.error != null ? { code: String((result.error as NodeJS.ErrnoException).code) } : undefined,
    };
  };

/**
 * Run environment diagnostics for the plugin.
 *
 * Checks performed (server-only, no TUI, no rule dir):
 * 1. Node version ≥ 20
 * 2. `opencode` on PATH
 * 3. Config readable & valid JSON
 * 4. Legacy `plugins` (plural) field warning
 * 5. Plugin field shape (array | string | undefined)
 * 6. Cache presence for `~/.cache/opencode/packages/opencode-code-review*`
 * 7. Config directory writability
 *
 * This function intentionally does NOT read the source checkout's
 * `package.json` — that is a build-time `package-metadata.test.ts` concern.
 *
 * @param fs        - Filesystem adapter (defaults to real fs in production).
 * @param env       - Process environment (defaults to `process.env`).
 * @param spawnFn   - Injectable spawn runner (defaults to real `spawnSync`).
 */
export const runDoctor = (
  fs: CliFs = createRealFs(),
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: SpawnFn = makeSpawnFn(spawnSync),
): DoctorResult => {
  const issues: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // 1. Node version check.
  const parsedVersion = parseNodeVersion(process.version);
  if (
    parsedVersion === null ||
    parsedVersion.major < MIN_NODE_VERSION
  ) {
    issues.push(
      `Node.js ${process.version} is below the minimum required version ${MIN_NODE_VERSION}.`,
    );
  }

  // 2. OpenCode on PATH check.
  try {
    const result = spawnFn("opencode", ["--version"], {
      shell: false,
      encoding: "utf8",
    });
    if (result.error != null && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
      issues.push(
        "opencode: executable not found on PATH — is OpenCode installed?\n" +
          "  hint: install from https://opencode.ai and ensure it is on your PATH",
      );
    } else if (result.status !== 0) {
      issues.push(
        `opencode --version exited with status ${result.status} (${result.stderr.trim()}).`,
      );
    }
  } catch (err) {
    issues.push(
      `opencode: could not be invoked — ${(err as Error).message}`,
    );
  }

  // 3. Config readability and validity.
  const loaded = loadGlobalConfig(fs, env);
  if (!loaded.existed) {
    warnings.push(
      `Config file not found at ${loaded.path} — run \`ocr install\` first.`,
    );
  } else if (loaded.parseError) {
    issues.push(
      `Config file is malformed JSON — fix the error below before continuing.\n` +
        `  path:  ${loaded.path}\n` +
        `  error: ${loaded.parseError}`,
    );
  }

  // 4. Legacy `plugins` (plural) field warning.
  if ("plugins" in loaded.config) {
    warnings.push(
      "Config contains a legacy `plugins` field. " +
        "Please migrate to the `plugin` (singular) field.",
    );
  }

  // 5. Plugin field shape check.
  const rawPlugin = loaded.config.plugin;
  if (
    rawPlugin !== undefined &&
    typeof rawPlugin !== "string" &&
    !Array.isArray(rawPlugin)
  ) {
    issues.push(
      `Config \`plugin\` field has unexpected type "${typeof rawPlugin}". ` +
        "Expected a string, an array of strings, or nothing.",
    );
  }

  // 6. Cache presence — enumerate packages dir for matching entries.
  const home = env.HOME ?? homedir();
  const packagesDir = join(home, ".cache", "opencode", "packages");
  let cacheEntries: string[] = [];
  try {
    const entries = fs.readdirSync(packagesDir);
    cacheEntries = entries.filter((e) => e.startsWith("opencode-code-review"));
  } catch {
    // Directory doesn't exist or not readable — treat as empty.
    cacheEntries = [];
  }
  if (cacheEntries.length > 0) {
    info.push(
      `Cache: ${cacheEntries.length} entry(s) found in ${packagesDir}`,
    );
    for (const entry of cacheEntries) {
      info.push(`  - ${entry}`);
    }
  } else {
    info.push(`Cache: no opencode-code-review entries found in ${packagesDir}`);
  }

  // 7. Config directory writability.
  const configResolved = resolveConfigPath(fs, env);
  const configParent = configResolved.path.slice(
    0,
    configResolved.path.lastIndexOf("/"),
  );
  if (!fs.existsSync(configParent)) {
    issues.push(
      `Config parent directory does not exist and cannot be created: ${configParent}`,
    );
  } else if (!fs.canWrite(configParent)) {
    issues.push(
      `Config directory is not writable: ${configParent}`,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    info,
  };
};
