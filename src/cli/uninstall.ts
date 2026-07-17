// ---------------------------------------------------------------------------
// src/cli/uninstall.ts — `ocr uninstall` command.
//
// Removes every `opencode-code-review` entry from the global OpenCode config's
// `plugin` list. With `--purge`, also deletes the runtime cache directory
// (`~/.cache/opencode/node_modules/opencode-code-review`) and the plugin's own
// config dir (`~/.config/opencode-code-review/`).
//
// Like `install`, the function is side-effect-free beyond prints and disk
// writes through `fs`. Tests inject an in-memory `CliFs` to exercise the
// full path including purge — all deletion goes through `fs.rmdirSync` so
// the mock can track calls, throw on specific paths, or verify ordering.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";
import {
  backupIfWritable,
  type CliFs,
  loadGlobalConfig,
  matchesReviewPlugin,
  normalizePlugin,
  PLUGIN_NAME,
  resolveCachePaths,
  writeAtomically,
  writeJsoncAtomic,
} from "./config.ts";
import { createRealFs } from "./real-fs.ts";

export interface UninstallOptions {
  /** Also remove the runtime cache and the plugin's own config dir. */
  purge?: boolean;
  /** Plan the change and print it without writing. */
  dryRun?: boolean;
  /** Reserved for future confirmation prompts; accepted but unused for now. */
  yes?: boolean;
}

export interface UninstallResult {
  status: "wrote" | "planned" | "noop";
  path: string;
  /** Plugin entries that were (or would be) removed from the config. */
  removed: string[];
  /** Cache / config dirs removed under `--purge`. Empty when `--purge` was not set. */
  purged: string[];
}

const JSON_INDENT = 2;

/** Resolve `$HOME` (or `os.homedir()` as last resort) for purge paths. */
const homeRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME;
  if (typeof home === "string" && home.trim().length > 0) return home;
  return homedir();
};

/** Bun/npm-style cache path where the plugin gets installed at runtime. */
export const cachePath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(homeRoot(env), ".cache", "opencode", "node_modules", PLUGIN_NAME);

/** Plugin's own XDG config dir (separate from the OpenCode config it edits). */
export const pluginConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => join(homeRoot(env), ".config", PLUGIN_NAME);

/**
 * Recursive delete via `fs.rmdirSync`. Returns the path on success.
 * Throws if the directory cannot be removed so the failure is surfaced
 * to the caller (not silently swallowed).
 */
const purgeDir = (path: string, fs: CliFs): string => {
  fs.rmdirSync(path);
  return path;
};

export const runUninstall = (
  opts: UninstallOptions = {},
  fs: CliFs = createRealFs(),
): UninstallResult => {
  const loaded = loadGlobalConfig(fs);

  if (loaded.parseError) {
    throw new Error(
      `Config file is malformed JSON — aborting to avoid data loss.\n` +
        `  path:  ${loaded.path}\n` +
        `  error: ${loaded.parseError}\n` +
        `Fix the JSON error, or delete the file and re-run.`,
    );
  }

  const config: Record<string, unknown> = { ...loaded.config };
  const existing = normalizePlugin(config.plugin);
  const removed = existing.filter(matchesReviewPlugin);
  const remaining = existing.filter((entry) => !matchesReviewPlugin(entry));

  // Build the post-uninstall config object.
  // Track removed keys so writeJsoncAtomic can generate deletion edits.
  let removedKeys: string[] | undefined;
  if (removed.length > 0) {
    if (remaining.length === 0) {
      delete config.plugin;
      removedKeys = ["plugin"];
    } else {
      config.plugin = remaining;
    }
  }

  // Compute purge candidates up front so dry-run can report them too.
  const cachePaths = resolveCachePaths(fs);
  const purgeCandidates = opts.purge
    ? [...cachePaths, pluginConfigPath()]
    : [];
  const purged: string[] = [];

  if (opts.dryRun) {
    console.log(`[dry-run] Would write to ${loaded.path}:`);
    console.log(JSON.stringify(config, null, JSON_INDENT));
    // Report planned purge targets even in dry-run (config is not written).
    if (purgeCandidates.length > 0) {
      console.log(`[dry-run] Would purge:`);
      for (const p of purgeCandidates) console.log(`  ${p}`);
    }
    return {
      status: "planned",
      path: loaded.path,
      removed,
      purged: purgeCandidates,
    };
  }

  // Write the config BEFORE purge so a broken purge never leaves the config
  // in a half-migrated state (threat-matrix write-before-purge ordering).
  let backup: string | null = null;
  if (removed.length > 0 && loaded.existed) {
    backup = backupIfWritable(loaded.path, fs);
    // Use writeJsoncAtomic for value updates (preserves JSONC comments on
    // unchanged keys — spec R9.2). For key removals writeAtomically is used
    // since jsonc-parser's modify+applyEdits does not yet handle comment
    // preservation on key deletion.
    if (removedKeys) {
      writeAtomically(loaded.path, JSON.stringify(config, null, JSON_INDENT), fs);
    } else {
      writeJsoncAtomic(loaded.path, config, loaded.rawText, fs);
    }
  }

  if (opts.purge) {
    for (const p of purgeCandidates) {
      const result = purgeDir(p, fs);
      if (result) purged.push(result);
    }
  }

  // Nothing to remove from the config AND nothing to purge → true no-op.
  if (
    removed.length === 0 &&
    purged.length === 0
  ) {
    console.log(`✓ Not installed: ${PLUGIN_NAME} not found in ${loaded.path}`);
    return { status: "noop", path: loaded.path, removed: [], purged: [] };
  }

  console.log(`✓ Uninstalled ${PLUGIN_NAME}`);
  if (removed.length > 0) console.log(`  config: ${loaded.path}`);
  if (backup) console.log(`  backup: ${backup}`);
  for (const p of purged) console.log(`  purged: ${p}`);

  return { status: "wrote", path: loaded.path, removed, purged };
};
