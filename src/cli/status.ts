// ---------------------------------------------------------------------------
// src/cli/status.ts — `ocr status` command.
//
// `status` reports whether the plugin is installed (and at what version)
// in the global OpenCode config — it's a read-only, idempotent probe
// suitable for scripting.
// ---------------------------------------------------------------------------

import {
  type CliFs,
  loadGlobalConfig,
  matchesReviewPlugin,
  normalizePlugin,
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
