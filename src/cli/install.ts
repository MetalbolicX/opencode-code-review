// ---------------------------------------------------------------------------
// src/cli/install.ts — `ocr install` command.
//
// Idempotent install for `opencode-code-review[@version]`. Existing plugin
// entries are removed before the new specifier is appended so re-running with
// the same version is a no-op. With `--dry-run` the pipeline runs end-to-end
// but no bytes hit disk.
//
// Stale cache entries matching `opencode-code-review*` under
// `~/.cache/opencode/packages/` are purged during install. For `--dry-run`,
// the planned purge paths are reported without deleting them.
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
  resolveCachePaths,
  writeAtomically,
} from "./config.ts";
import { createRealFs } from "./real-fs.ts";
import { purgeDirectory } from "./cache.ts";

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
  /** Cache paths purged (or planned for purge under `--dry-run`). */
  purged: string[];
}

const JSON_INDENT = 2;

/**
 * Run `ocr install` against the global OpenCode config.
 *
 * Order: load config → normalize → compute cache candidates →
 * noop guard (pure or with stale cache) →
 * backup → atomic write → purge stale cache.
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

  // Compute stale cache paths to purge (always, not just on dry-run).
  const purgeCandidates = resolveCachePaths(fs, env);

  // No-op: same effective plugin list as before.
  const effectiveExisting = [
    ...dedupePlugins(existing.filter((e) => !matchesReviewPlugin(e))),
    specifier,
  ];
  const isNoop =
    !opts.dryRun &&
    JSON.stringify(effectiveExisting) === JSON.stringify(existing);

  // Pure no-op: same effective plugin list AND no stale cache to purge.
  if (isNoop && purgeCandidates.length === 0) {
    console.log(`✓ Already installed (${specifier}) at ${loaded.path}`);
    return { status: "noop", path: loaded.path, specifier, backup: null, purged: [] };
  }

  // No-op with stale cache — purge cache without rewriting config.
  if (isNoop && purgeCandidates.length > 0) {
    const purged: string[] = [];
    for (const p of purgeCandidates) {
      try {
        if (fs.existsSync(p)) {
          purgeDirectory(fs, p);
          purged.push(p);
        }
      } catch {
        // best-effort — purge failure is non-fatal
      }
    }
    console.log(`✓ Already installed (${specifier}) at ${loaded.path}`);
    for (const p of purged) console.log(`  purged: ${p}`);
    return { status: "noop", path: loaded.path, specifier, backup: null, purged };
  }

  // Keep non-plugin entries; drop all plugin entries so we always append fresh.
  const nonPlugin = existing.filter((entry) => !matchesReviewPlugin(entry));
  config.plugin = [...dedupePlugins(nonPlugin), specifier];

  if (opts.dryRun) {
    console.log(`[dry-run] Would write to ${loaded.path}:`);
    console.log(JSON.stringify(config, null, JSON_INDENT));
    if (purgeCandidates.length > 0) {
      console.log(`[dry-run] Would purge stale cache:`);
      for (const p of purgeCandidates) console.log(`  ${p}`);
    }
    return { status: "planned", path: loaded.path, specifier, backup: null, purged: purgeCandidates };
  }

  // Write the config BEFORE purging so a broken purge never leaves the config
  // in a half-migrated state (threat-matrix write-before-purge ordering).
  let backup: string | null = null;
  if (loaded.existed) {
    backup = backupIfWritable(loaded.path, fs);
  }
  writeAtomically(loaded.path, JSON.stringify(config, null, JSON_INDENT), fs);

  // Purge stale cache entries AFTER config write (best-effort — non-fatal).
  const purged: string[] = [];
  for (const p of purgeCandidates) {
    try {
      if (fs.existsSync(p)) {
        purgeDirectory(fs, p);
        purged.push(p);
      }
    } catch {
      // best-effort — purge failure is non-fatal
    }
  }

  console.log(`✓ Installed ${specifier}`);
  console.log(`  config: ${loaded.path}`);
  if (backup) console.log(`  backup: ${backup}`);
  if (purged.length > 0) {
    for (const p of purged) console.log(`  purged: ${p}`);
  }
  console.log(`tip: Run \`ocr doctor\` to verify your setup`);

  return { status: "wrote", path: loaded.path, specifier, backup, purged };
};
