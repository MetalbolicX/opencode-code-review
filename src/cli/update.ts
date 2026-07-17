// ---------------------------------------------------------------------------
// src/cli/update.ts — `ocr update` command (Update Lifecycle).
//
// Queries the npm registry for the latest `opencode-code-review` version,
// compares it to the installed version from the global config, and when stale:
//   1. Purges matching cache entries from ~/.cache/opencode/packages/
//   2. Force-reinstalls via `opencode plugin opencode-code-review --global --force`
//
// Registry unreachable or malformed version → exits 1 BEFORE any mutation.
// Dry-run reports comparison without spawning or purging.
//
// Injectable seams:
//   - latestVersion: () => Promise<string | null>  — allows mock network
//   - spawn:        ProcessRunner                  — allows mock subprocess
//
// Task 4.4 implementation:
//   - UpdateOptions, UpdateResult interfaces
//   - extractVersion(): parse "opencode-code-review@1.2.3" → "1.2.3" | null
//   - resolveCachePaths(): enumerate ~/.cache/opencode/packages/ matching prefix
//   - runUpdate(): full lifecycle with registry/spawn/cache/purge seams
// ---------------------------------------------------------------------------

import {
  type CliFs,
  loadGlobalConfig,
  matchesReviewPlugin,
  PLUGIN_NAME,
  resolveCachePaths,
} from "./config.ts";
import { spawnOpencodePlugin, type ProcessRunner } from "./spawn.ts";
import { fetchLatestVersion, type LatestVersionFn } from "./registry.ts";

export interface UpdateOptions {
  /** Print comparison without purging or spawning. */
  dryRun?: boolean;
  /**
   * Injectable latest-version lookup. Defaults to the live npm registry query.
   * Tests pass a deterministic mock.
   */
  latestVersion?: LatestVersionFn;
  /** Injectable process runner. Defaults to real opencode spawn. */
  spawn?: ProcessRunner;
}

export type UpdateStatus = "stale" | "current" | "unreachable";

export interface UpdateResult {
  /** Outcome of the update check. */
  status: UpdateStatus;
  /**
   * Version currently registered in the global config, or `null` when
   * the plugin is not registered.
   */
  installedVersion: string | null;
  /** Latest version from the npm registry, or `null` when unreachable. */
  latestVersion: string | null;
  /** Cache paths that were (or would be) purged. Empty in dry-run / unreachable. */
  cachePaths: string[];
}

/** Separator between plugin name and version in a specifier string. */
const SPECIFIER_AT = "@";

/**
 * Extract the version from an npm specifier string.
 *
 * Examples:
 *   "opencode-code-review"          → null  (bare — no version known)
 *   "opencode-code-review@1.2.3"    → "1.2.3"
 *   "opencode-code-review@latest"   → "latest"
 *
 * A null return means the specifier is bare (no pinned version) and should
 * be treated as "always stale" so a bare specifier always triggers reinstall.
 */
export const extractVersion = (specifier: string): string | null => {
  if (typeof specifier !== "string") return null;
  const at = specifier.indexOf(SPECIFIER_AT);
  if (at === -1) return null; // bare specifier — no version pin
  const version = specifier.slice(at + 1);
  return version.length > 0 ? version : null;
};

/**
 * Run the full `ocr update` lifecycle:
 *
 *  1. Fetch latest version from registry (or injected mock).
 *  2. null / invalid → return { status: 'unreachable', ... } — NO mutation.
 *  3. Read installed specifier from opencode.json via loadGlobalConfig.
 *  4. Extract installed version (bare specifier → null = always stale).
 *  5. installed === latest → return { status: 'current', ... } — NO mutation.
 *  6. stale → purge cachePaths → spawn opencode plugin ... --force
 *  7. dry-run → report comparison without purge or spawn.
 *
 * Exit-code semantics are handled by `main.ts` based on the returned status.
 */
export const runUpdate = async (
  opts: UpdateOptions = {},
  fs: CliFs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateResult> => {
  const getLatest = opts.latestVersion ?? fetchLatestVersion;
  const spawnFn = opts.spawn ?? { run: spawnOpencodePlugin };

  // Step 1: fetch latest from registry
  const latest = await getLatest();

  // Step 2: null / invalid (empty / whitespace-only) → unreachable, no mutation
  // Both the registry seam and fetchLatestVersion itself treat malformed responses
  // as null; this guard additionally catches empty-string returns from a misbehaving
  // injected mock so tests can assert invalid latest → unreachable without
  // modifying the seam contract.
  if (latest === null || latest.trim().length === 0) {
    return {
      status: "unreachable",
      installedVersion: null,
      latestVersion: null,
      cachePaths: [],
    };
  }

  // Step 3: read installed specifier from global config
  const loaded = loadGlobalConfig(fs, env);
  const plugins = (() => {
    const raw = loaded.config.plugin;
    if (typeof raw === "string") return [raw];
    if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string");
    return [];
  })();
  const reviewEntry = plugins.find(matchesReviewPlugin) ?? null;

  // Step 4: extract installed version (bare → null = always stale)
  const installedVersion = reviewEntry ? extractVersion(reviewEntry) : null;

  // Step 5: installed === latest → current, no mutation
  if (installedVersion !== null && installedVersion === latest) {
    return {
      status: "current",
      installedVersion,
      latestVersion: latest,
      cachePaths: [],
    };
  }

  // Step 6: dry-run — report without mutating
  if (opts.dryRun) {
    console.log(`[dry-run] Comparison:`);
    console.log(`  installed: ${installedVersion ?? "(bare/unknown)"}`);
    console.log(`  latest:    ${latest}`);
    if (installedVersion === null) {
      console.log(`  → Would install bare specifier, force-reinstall.`);
    } else {
      console.log(`  → Would purge cache and force-reinstall.`);
    }
    return {
      status: installedVersion === null ? "stale" : "stale",
      installedVersion,
      latestVersion: latest,
      cachePaths: [],
    };
  }

  // Step 7: stale — purge matching cache entries then force-reinstall
  const cachePaths = resolveCachePaths(fs, env);
  for (const p of cachePaths) {
    fs.rmdirSync(p);
  }

  // Spawn: opencode plugin opencode-code-review --global --force
  const result = await spawnFn.run("opencode", [
    "plugin",
    PLUGIN_NAME,
    "--global",
    "--force",
  ]);

  if (result.missing) {
    throw new Error(
      `opencode: executable not found on PATH — is OpenCode installed?\n` +
        `  hint: install from https://opencode.ai and ensure it is on your PATH`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `opencode plugin update failed (exit ${result.status}):\n` +
        `  ${result.stderr.trim()}`,
    );
  }

  return {
    status: "stale",
    installedVersion,
    latestVersion: latest,
    cachePaths,
  };
};
