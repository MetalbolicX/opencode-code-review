// ---------------------------------------------------------------------------
// src/cli/install.ts — `ocr install` command.
//
// Idempotent install for `opencode-code-review[@version]`. Existing plugin
// entries are removed before the new specifier is appended so re-running with
// the same version is a no-op. With `--dry-run` the pipeline runs end-to-end
// but no bytes hit disk.
//
// Side effects beyond prints and writes go through the injected `CliFs`
// so tests can run entirely in-memory with a deterministic filesystem.
// ---------------------------------------------------------------------------

import {
  backupIfWritable,
  buildSpecifier,
  type CliFs,
  dedupePlugins,
  loadGlobalConfig,
  matchesReviewPlugin,
  normalizePlugin,
  PLUGIN_NAME,
  writeAtomically,
} from "./config.ts";
import { createRealFs } from "./real-fs.ts";

export interface InstallOptions {
  /** Optional version pin (e.g. `"1.2.3"`, `"latest"`). Omit for bare specifier. */
  version?: string;
  /** Plan the change and print it without writing. */
  dryRun?: boolean;
  /** Reserved for future confirmation prompts; accepted but unused for now. */
  yes?: boolean;
}

export interface InstallResult {
  /** Outcome of the command. */
  status: "wrote" | "planned" | "noop";
  /** Resolved config path (existing or newly-targeted). */
  path: string;
  /** Specifier that was added (or would be added under `--dry-run`). */
  specifier: string;
  /** Backup path created before the write, or `null` when no backup was needed. */
  backup: string | null;
}

const JSON_INDENT = 2;

/**
 * Run `ocr install` against the global OpenCode config.
 *
 * Steps: load → normalize → dedupe (drops existing plugin entries) →
 * append new specifier → backup → atomic write.
 */
export const runInstall = (
  opts: InstallOptions = {},
  fs: CliFs = createRealFs(),
  env: NodeJS.ProcessEnv = process.env,
): InstallResult => {
  // `--latest` means "install the latest version from npm" — bare specifier.
  const isLatest = opts.version === "latest";
  const specifier = isLatest ? PLUGIN_NAME : buildSpecifier(opts.version);
  const loaded = loadGlobalConfig(fs, env);

  if (loaded.parseError) {
    throw new Error(
      `Config file is malformed JSON — aborting to avoid data loss.\n` +
        `  path:  ${loaded.path}\n` +
        `  error: ${loaded.parseError}\n` +
        `Fix the JSON error, or delete the file and re-run to create a fresh config.`,
    );
  }

  const config: Record<string, unknown> = { ...loaded.config };
  const existing = normalizePlugin(config.plugin);

  // Keep non-plugin entries; drop all plugin entries so we always append fresh.
  const nonPlugin = existing.filter((entry) => !matchesReviewPlugin(entry));
  const finalPlugins = [...nonPlugin, specifier];

  // No-op: same effective plugin list as before (handles same-version reinstall).
  const isNoop = JSON.stringify(finalPlugins) === JSON.stringify(existing);

  if (isNoop) {
    console.log(`✓ Already installed (${specifier}) at ${loaded.path}`);
    return { status: "noop", path: loaded.path, specifier, backup: null };
  }

  // Dedupe non-plugin entries (last occurrence wins) so a hand-edited config
  // with duplicate plugins is cleaned up on write.
  config.plugin = [...dedupePlugins(nonPlugin), specifier];

  if (opts.dryRun) {
    console.log(`[dry-run] Would write to ${loaded.path}:`);
    console.log(JSON.stringify(config, null, JSON_INDENT));
    return { status: "planned", path: loaded.path, specifier, backup: null };
  }

  const backup = backupIfWritable(loaded.path, fs);
  writeAtomically(loaded.path, JSON.stringify(config, null, JSON_INDENT), fs);

  console.log(`✓ Installed ${specifier}`);
  console.log(`  config: ${loaded.path}`);
  if (backup) console.log(`  backup: ${backup}`);
  console.log(`tip: Run \`ocr doctor\` to verify your setup`);

  return { status: "wrote", path: loaded.path, specifier, backup };
};
