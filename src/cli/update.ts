// ---------------------------------------------------------------------------
// src/cli/update.ts — `ocr update` command (Update Lifecycle).
//
// PR 2 (ocr-update-cache-refresh): update is now UNCONDITIONAL with post-spawn
// cache-version verification. Every `ocr update` run:
//
//   1. Pre-read @latest/package.json version (if readable)
//   2. Resolve and purge all owned cache paths (best-effort, warnings surfaced)
//   3. Spawn `opencode plugin opencode-code-review --global --force`
//   4. Re-read @latest/package.json version
//   5. Compare — unchanged/unreadable/invalid → throw with rm -rf remediation
//   6. Changed → resolve with { status: 'stale', cachePaths, instruction }
//
// Exit-code semantics:
//   - spawn exits 0 + post-version changed → resolve { status: 'stale' }
//   - spawn exits 0 + post-version same/missing/invalid → throw (cache stale)
//   - spawn exits non-zero → throw (error message mentions the exit code)
//   - opencode executable missing → throw
//
// Injectable seams:
//   - spawn: ProcessRunner — allows mock subprocess in tests
//   - fs: CliFs — already injected; used for version reads
//
// Task 2.4 GREEN + Task 2.5 REFACTOR:
//   - UpdateOptions, UpdateResult interfaces
//   - runUpdate(): unconditional purge + spawn + post-verify lifecycle
//   - Centralized remediation/warning construction helpers
//   - No symbol from registry.ts is referenced (import-graph invariant)
// ---------------------------------------------------------------------------

import { basename } from "node:path";
import { type CliFs, PLUGIN_NAME, resolveCachePaths } from "./config.ts";
import {
  purgeAllCachePaths,
  readCacheManifestVersion,
  type PurgeOutcome,
} from "./cache.ts";
import { spawnOpencodePlugin, type ProcessRunner } from "./spawn.ts";

export interface UpdateOptions {
  /**
   * Plan the change and print it without writing.
   * When true, runUpdate returns { status: 'noop' } without purging or spawning.
   */
  dryRun?: boolean;
  /**
   * Emit diagnostic information to the console.
   * When set, prints: resolved cache paths, pre/post version, spawn argv,
   * per-path purge outcomes/warnings, and post-spawn exit code.
   */
  verbose?: boolean;
  /** Injectable process runner. Defaults to real opencode spawn. */
  spawn?: ProcessRunner;
}

export type UpdateStatus = "stale" | "noop";

export interface UpdateResult {
  /**
   * Outcome of the update run.
   * - `'noop'`: dry-run mode — no mutation occurred.
   * - `'stale'`: a real update run completed (purge + spawn attempted).
   */
  status: UpdateStatus;
  /**
   * Cache paths that were (or would be) purged.
   * Empty in dry-run mode.
   */
  cachePaths: string[];
  /**
   * Human-readable instruction describing what was (or would be) spawned.
   * Empty string in the return value after a real run.
   */
  instruction: string;
}

// ---------------------------------------------------------------------------
// Remediation and warning construction (Task 2.5 — centralize these)
// ---------------------------------------------------------------------------

/**
 * Build the actionable remediation message for a stale/unchanged cache.
 * Used when post-spawn verification detects that the cache was not refreshed.
 */
const buildRemediationMessage = (): string => {
  return (
    `Cache was not refreshed after reinstall.\n` +
    `  hint: run the following to clear the stale cache:\n` +
    `    rm -rf ~/.cache/opencode/packages/opencode-code-review* && ocr update`
  );
};

/**
 * Build a warning message for a purge outcome that had errors.
 * Returns a formatted string describing which path failed and why.
 * Errors are formatted as "operation:basename:reason" per purgeDirectoryImpl.
 */
const buildPurgeWarning = (outcome: PurgeOutcome): string => {
  const base = basename(outcome.path);
  if (outcome.errors.length === 0) return "";
  const errorSummary = outcome.errors.map((e) => `      - ${e}`).join("\n");
  return `  warning: purge errors for ${base}:\n${errorSummary}`;
};

/**
 * Emit purge outcome warnings to the console.
 * Called after purge completes but before spawn — warnings are non-fatal.
 */
const emitPurgeWarnings = (outcomes: PurgeOutcome[]): void => {
  for (const outcome of outcomes) {
    if (outcome.errors.length > 0) {
      console.warn(buildPurgeWarning(outcome));
    }
  }
};

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

/**
 * Run the unconditional update lifecycle with post-spawn cache verification:
 *
 *  1. Pre-read @latest/package.json version (if readable) — undefined if absent
 *  2. In dry-run mode: return { status: 'noop' } — no mutation.
 *  3. Purge each cache path via purgeAllCachePaths (best-effort, warnings emitted)
 *  4. Spawn `opencode plugin opencode-code-review --global --force`
 *  5. Re-read @latest/package.json version
 *  6. Throw if post-version is undefined, invalid, or equals pre-version
 *     (cache was not refreshed → actionable rm -rf hint)
 *  7. Resolve { status: 'stale' } when cache was refreshed
 *
 * There is no staleness gate and no registry consult — every run is a
 * clean reinstall. Version comparison is verify-only and never gates spawn.
 */
export const runUpdate = async (
  opts: UpdateOptions = {},
  fs: CliFs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateResult> => {
  const spawnFn = opts.spawn ?? { run: spawnOpencodePlugin };

  // Step 1: resolve cache paths
  const cachePaths = resolveCachePaths(fs, env);
  const instruction = `opencode plugin ${PLUGIN_NAME} --global --force`;

  // Step 2: pre-read the local @latest version before any mutation
  const preVersion = readCacheManifestVersion(fs, env);

  if (opts.verbose) {
    console.log(
      `[verbose] resolved cache paths: ${cachePaths.join(", ") || "(none)"}`,
    );
    console.log(`[verbose] pre-purge version: ${preVersion ?? "(none)"}`);
    console.log(`[verbose] would spawn: ${instruction}`);
  }

  // Step 3: dry-run — report without mutating
  if (opts.dryRun) {
    console.log(`[dry-run] Update check:`);
    console.log(`  would purge: ${cachePaths.join(", ") || "(none found)"}`);
    console.log(`  would spawn: ${instruction}`);
    return { status: "noop", cachePaths: [], instruction };
  }

  // Step 4: real mode — purge all owned cache paths (best-effort, warnings surfaced)
  const purgeOutcomes = purgeAllCachePaths(fs, env);

  if (opts.verbose) {
    for (const outcome of purgeOutcomes) {
      if (outcome.errors.length === 0) {
        console.log(`[verbose] purged: ${outcome.path}`);
      } else {
        console.log(`[verbose] purge errors: ${outcome.path}`);
      }
    }
    if (purgeOutcomes.some((outcome) => outcome.errors.length > 0)) {
      emitPurgeWarnings(purgeOutcomes);
    }
  } else {
    // Always emit purge warnings regardless of verbose mode (non-fatal but informative)
    emitPurgeWarnings(purgeOutcomes);
  }

  // Step 5: spawn opencode plugin --global --force
  const result = await spawnFn.run("opencode", [
    "plugin",
    PLUGIN_NAME,
    "--global",
    "--force",
  ]);

  if (opts.verbose) {
    console.log(`[verbose] spawn exit code: ${result.status}`);
  }

  if (result.missing) {
    throw new Error(
      `opencode: executable not found on PATH — is OpenCode installed?\n` +
        `  hint: install from https://opencode.ai and ensure it is on your PATH`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `opencode plugin ${PLUGIN_NAME} --global --force exited with status ${String(result.status)}:\n` +
        `  ${result.stderr.trim()}`,
    );
  }

  // Step 6: post-spawn cache verification — re-read the @latest version
  const postVersion = readCacheManifestVersion(fs, env);

  if (opts.verbose) {
    console.log(`[verbose] post-spawn version: ${postVersion ?? "(none)"}`);
  }

  // Step 7: verify the cache was actually refreshed
  if (postVersion === undefined) {
    // Cache manifest is missing or unreadable after spawn — cannot verify refresh
    throw new Error(
      `Cannot verify cache refresh — @latest/package.json is missing or unreadable after spawn.\n` +
        buildRemediationMessage(),
    );
  }

  if (preVersion !== undefined && postVersion === preVersion) {
    // Cache did not change — likely a stale-cache scenario
    throw new Error(
      `Cache was not refreshed — version "${postVersion}" is unchanged after reinstall.\n` +
        buildRemediationMessage(),
    );
  }

  // Cache was refreshed (or first install with no pre-version)
  return {
    status: "stale",
    cachePaths,
    instruction: "",
  };
};
