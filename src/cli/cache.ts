// ---------------------------------------------------------------------------
// src/cli/cache.ts — Cache path resolution and recursive purge for the
// opencode-code-review plugin.
//
// Resolves paths under ~/.cache/opencode/packages/ that match the plugin name
// (exact and `@<version>` suffix variants). Purge is best-effort via CliFs
// so failures during cleanup never abort the calling command.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CliFs } from "./config.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Package directory used by OpenCode to cache plugin installs. */
export const PACKAGES_DIR_BASENAME = [
  ".cache",
  "opencode",
  "packages",
] as const;

/** Exact cache directory name we look for (bare specifier, no version suffix). */
export const CACHE_DIR_BASENAME = "opencode-code-review";

/**
 * The "@latest" suffixed cache directory name. This is the path reused
 * across version bumps that causes stale-cache issues without an explicit purge.
 */
export const CACHE_DIR_LATEST = `${CACHE_DIR_BASENAME}@latest`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of purging a single cache directory.
 * Errors are collected per-path so the caller can surface them without
 * aborting the purge of remaining paths (best-effort semantics).
 */
export interface PurgeOutcome {
  path: string;
  /** Error messages from this path; empty if the path was fully removed. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user's home directory, honoring a custom HOME env var.
 * Used by both resolveCachePaths and the config loader.
 */
export const resolveHome = (env: NodeJS.ProcessEnv = process.env): string => {
  return env.HOME ?? homedir();
};

/**
 * Return the absolute path of the OpenCode packages cache directory.
 */
export const resolvePackagesDir = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  return join(resolveHome(env), ...PACKAGES_DIR_BASENAME);
};

/**
 * Return the cache directories that match the opencode-code-review prefix.
 *
 * Real-world layout under ~/.cache/opencode/packages/ looks like:
 *   opencode-code-review/
 *   opencode-code-review@latest/
 *   some-other-plugin/
 *
 * We glob-match anything starting with `opencode-code-review` (exact or with
 * an `@<version>` suffix). When an injected fs is provided we list the
 * directory and filter; without one we return the two most common shapes
 * so callers can pre-check existence cheaply.
 */
export const resolveCachePaths = (
  env: NodeJS.ProcessEnv = process.env,
  fs?: CliFs,
): string[] => {
  const packagesDir = resolvePackagesDir(env);
  if (fs) {
    if (!fs.existsSync(packagesDir)) return [];
    try {
      const entries = fs.readdirSync(packagesDir);
      return entries
        .filter(
          (name) =>
            name === CACHE_DIR_BASENAME ||
            name.startsWith(`${CACHE_DIR_BASENAME}@`),
        )
        .map((name) => join(packagesDir, name));
    } catch {
      return [];
    }
  }
  // No fs injection — return the conventional candidates. Callers that care
  // about existence should still check with existsSync().
  return [
    join(packagesDir, CACHE_DIR_BASENAME),
    join(packagesDir, `${CACHE_DIR_BASENAME}@latest`),
  ];
};

// ---------------------------------------------------------------------------
// Recursive purge
// ---------------------------------------------------------------------------

/**
 * Internal purge implementation that accumulates errors rather than swallowing
 * them silently. Used by purgeAllCachePaths to surface structured outcomes.
 * Retains the same best-effort deletion semantics as purgeDirectory.
 *
 * Error messages are normalized to <operation>:<basename>:<reason> so that
 * no arbitrary path information is leaked through the PurgeOutcome surface.
 *
 * @param fs     - Filesystem adapter.
 * @param dirPath - Directory to purge.
 * @param errors  - Accumulator for error messages; errors from failed
 *                   unlink/rmdir operations are pushed here.
 */
const purgeDirectoryImpl = (
  fs: CliFs,
  dirPath: string,
  errors: string[],
): void => {
  const base = basename(dirPath);

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    errors.push(`readdir:${base}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = join(dirPath, entry);
    try {
      if (!fs.existsSync(entryPath)) continue;
      try {
        const subEntries = fs.readdirSync(entryPath);
        if (subEntries.length === 0) {
          fs.rmdirSync(entryPath);
        } else {
          purgeDirectoryImpl(fs, entryPath, errors);
        }
      } catch {
        // Not a directory (or unreadable) — best-effort unlink.
        try {
          fs.unlinkSync(entryPath);
        } catch (unlinkErr) {
          errors.push(`unlink:${entry}:${(unlinkErr as Error).message}`);
        }
      }
    } catch {
      // best-effort per entry — record but continue
    }
  }

  try {
    fs.rmdirSync(dirPath);
  } catch (rmdirErr) {
    errors.push(`rmdir:${base}:${(rmdirErr as Error).message}`);
  }
};

/**
 * Recursively delete a directory and all its contents using the injected fs.
 * Best-effort — a failed purge is not fatal; we want the install to keep going.
 *
 * For structured error reporting, use `purgeAllCachePaths` instead.
 */
export const purgeDirectory = (fs: CliFs, dirPath: string): void => {
  const errors: string[] = [];
  purgeDirectoryImpl(fs, dirPath, errors);
  // Best-effort: errors are accumulated internally but not propagated.
  // Callers who need structured outcomes should call purgeAllCachePaths.
};

// ---------------------------------------------------------------------------
// Aggregate purge
// ---------------------------------------------------------------------------

/**
 * Purge all cache directories owned by this plugin, aggregating per-path
 * outcomes. Best-effort — errors on one path do not abort the remaining paths.
 *
 * Unrelated directories (not matching the opencode-code-review prefix) are
 * never touched.
 *
 * @param fs   - Filesystem adapter (for test injection).
 * @param env  - Process env to resolve HOME and cache directory.
 * @returns Array of PurgeOutcome, one per discovered owned path.
 */
export const purgeAllCachePaths = (
  fs: CliFs,
  env: NodeJS.ProcessEnv = process.env,
): PurgeOutcome[] => {
  const ownedPaths = resolveCachePaths(env, fs);
  if (ownedPaths.length === 0) return [];

  const outcomes: PurgeOutcome[] = [];

  for (const path of ownedPaths) {
    const errors: string[] = [];
    purgeDirectoryImpl(fs, path, errors);
    outcomes.push({ path, errors });
  }

  return outcomes;
};

// ---------------------------------------------------------------------------
// Cache manifest helper
// ---------------------------------------------------------------------------

/**
 * Read the `version` field from the `@latest` cache manifest.
 *
 * Returns `undefined` when:
 *   - The `@latest` cache directory does not exist.
 *   - The `package.json` is missing or unreadable.
 *   - The file is not valid JSON.
 *   - The parsed JSON has no `version` field (or it is not a string).
 *
 * This is the narrow helper used for pre/post spawn verification only —
 * it does NOT gate whether a spawn runs (per the spec, registry.ts is
 * never consulted and version comparison is verify-only).
 */
export const readCacheManifestVersion = (
  fs: CliFs,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const latestDir = join(resolvePackagesDir(env), CACHE_DIR_LATEST);
  const manifestPath = join(latestDir, "package.json");

  if (!fs.existsSync(manifestPath)) {
    return undefined;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "string") {
    return undefined;
  }

  return obj.version;
};
