// ---------------------------------------------------------------------------
// src/cli/update.ts — `ocr update` command (Update Lifecycle).
//
// Rewrite for Slice 4: update is now UNCONDITIONAL — no version-compare gate,
// no registry fetch, no staleness check. Every `ocr update` run:
//
//   1. Resolves cache paths under ~/.cache/opencode/packages/
//   2. Purges each path (best-effort — individual failures are swallowed)
//   3. Spawns `opencode plugin opencode-code-review --global --force`
//
// Exit-code semantics:
//   - spawn exits 0 → resolve with { status: 'stale', cachePaths, instruction }
//   - spawn exits non-zero → throw (error message mentions the exit code)
//   - opencode executable missing → throw
//
// Injectable seams:
//   - spawn: ProcessRunner — allows mock subprocess in tests
//
// Task 4.4 implementation:
//   - UpdateOptions, UpdateResult interfaces
//   - runUpdate(): unconditional purge + spawn lifecycle
//   - No symbol from registry.ts is referenced (import-graph invariant)
// ---------------------------------------------------------------------------

import { type CliFs, PLUGIN_NAME, resolveCachePaths } from "./config.ts";
import { spawnOpencodePlugin, type ProcessRunner } from "./spawn.ts";
import { purgeDirectory } from "./cache.ts";

export interface UpdateOptions {
  /**
   * Plan the change and print it without writing.
   * When true, runUpdate returns { status: 'noop' } without purging or spawning.
   */
  dryRun?: boolean;
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

/**
 * Run the unconditional update lifecycle:
 *
 *  1. Resolve cache paths under ~/.cache/opencode/packages/
 *  2. In dry-run mode: return { status: 'noop' } — no mutation.
 *  3. In real mode: purge each cache path (best-effort, swallow errors),
 *     then spawn `opencode plugin opencode-code-review --global --force`.
 *  4. Nonzero spawn exit → throw; missing executable → throw.
 *
 * There is no staleness gate and no registry consult — every run is a
 * clean reinstall. This guarantees the plugin cache is always consistent
 * with the latest published version.
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

  // Step 2: dry-run — report without mutating
  if (opts.dryRun) {
    console.log(`[dry-run] Update check:`);
    console.log(`  would purge: ${cachePaths.join(", ") || "(none found)"}`);
    console.log(`  would spawn: ${instruction}`);
    return { status: "noop", cachePaths: [], instruction };
  }

  // Step 3: real mode — purge each cache path (best-effort per path)
  for (const cachePath of cachePaths) {
    try {
      if (fs.existsSync(cachePath)) {
        purgeDirectory(fs, cachePath);
      }
    } catch {
      // Best-effort per path — individual purge failures are swallowed.
      // Other paths are still purged, and spawn still proceeds.
    }
  }

  // Step 4: spawn opencode plugin --global --force
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
      `opencode plugin ${PLUGIN_NAME} --global --force exited with status ${String(result.status)}:\n` +
        `  ${result.stderr.trim()}`,
    );
  }

  return {
    status: "stale",
    cachePaths,
    instruction: "",
  };
};
