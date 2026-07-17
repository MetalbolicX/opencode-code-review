// ---------------------------------------------------------------------------
// src/cli/install.ts — `ocr install` command.
//
// Delegates plugin registration to `opencode plugin <specifier> --global`
// via an injectable `ProcessRunner` seam. No direct config editing.
//
// The function is pure of side effects beyond what it prints. Tests inject
// a fake `ProcessRunner` to exercise every branch deterministically.
//
// Task 2.2:
//   - Async delegation only through ProcessRunner
//   - No direct config write
//   - InstallOptions: { version?, dryRun?, yes?, spawn? }
//   - InstallResult: { status: 'wrote' | 'skipped', specifier: string }
//   - Remove: config loading, normalizePlugin, dedupePlugins, backupIfWritable,
//             writeAtomically, path/backup fields
// ---------------------------------------------------------------------------

import { buildSpecifier, PLUGIN_NAME } from "./config.ts";
import { spawnOpencodePlugin, type ProcessRunner } from "./spawn.ts";

export interface InstallOptions {
  /** Optional version pin (e.g. `"1.2.3"`, `"latest"`). Omit for bare specifier. */
  version?: string;
  /** Plan the change and print it without writing or spawning. */
  dryRun?: boolean;
  /** Reserved for future confirmation prompts; accepted but unused for now. */
  yes?: boolean;
  /** Injectable process runner (defaults to the real opencode spawn). */
  spawn?: ProcessRunner;
}

export interface InstallResult {
  /** Outcome of the command. */
  status: "wrote" | "skipped";
  /** Resolved specifier that was used (or would be used). */
  specifier: string;
}

/**
 * Run `ocr install` by delegating to `opencode plugin <specifier> --global`.
 *
 * Steps: build specifier → dry-run report → spawn opencode → propagate errors.
 * The specifier is either the bare `opencode-code-review` (no version) or
 * `opencode-code-review@<version>` when `--version` is given.
 */
export const runInstall = async (
  opts: InstallOptions = {},
): Promise<InstallResult> => {
  // `--latest` means "install the latest version from npm" — opencode plugin
  // without a version suffix delegates to npm resolution, so we pass bare specifier.
  const isLatest = opts.version === "latest";
  const specifier = isLatest ? PLUGIN_NAME : buildSpecifier(opts.version);

  if (opts.dryRun) {
    console.log(`[dry-run] Would run: opencode plugin ${specifier} --global`);
    return { status: "skipped", specifier };
  }

  const spawnFn = opts.spawn ?? { run: spawnOpencodePlugin };
  const result = await spawnFn.run("opencode", ["plugin", specifier, "--global"]);

  if (result.missing) {
    throw new Error(
      `opencode: executable not found on PATH — is OpenCode installed?\n` +
        `  hint: install from https://opencode.ai and ensure it is on your PATH`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `opencode plugin registration failed (exit ${result.status}):\n` +
        `  ${result.stderr.trim()}`,
    );
  }

  return { status: "wrote", specifier };
};
