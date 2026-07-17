// ---------------------------------------------------------------------------
// src/cli/spawn.ts — Shell-free, injectable OpenCode plugin spawn wrapper.
//
// All `opencode plugin` invocations go through this seam so tests can inject
// a fake process runner that never actually spawns a subprocess.
// `shell: false` and fixed argv are enforced by design — there is no string
// interpolation into a shell command.
//
// The `ProcessRunner` interface is the injectable seam; production code uses
// `spawnOpencodePlugin` which wraps `child_process.spawnSync` with `shell: false`.
// ---------------------------------------------------------------------------

import { spawnSync, type SpawnSyncOptions } from "node:child_process";

/**
 * Result of a process run — mirrors `SpawnSyncReturns<string>` with an
 * additional `error` field for clear missing-executable messaging.
 */
export interface ProcessResult {
  /** Process exit code. */
  status: number | null;
  /** Captured stdout (decoded as utf8). */
  stdout: string;
  /** Captured stderr (decoded as utf8). */
  stderr: string;
  /** True when the spawn could not even be attempted (executable missing). */
  missing: boolean;
}

/**
 * Injectable process runner. `run(executable, args)` executes
 * `executable` with `args` and returns a `ProcessResult`.
 *
 * The returned `Promise` is always resolved (never rejected) — callers
 * interpret `result.missing` or `result.status` to decide success.
 */
export interface ProcessRunner {
  run(executable: "opencode", args: string[]): Promise<ProcessResult>;
}

/**
 * Default `ProcessRunner` backed by `child_process.spawnSync` with
 * `shell: false`. This is the production implementation.
 *
 * @param executable  - Must be `"opencode"` (enforced at call sites).
 * @param args        - Fixed argv passed directly; never string-interpolated.
 * @returns Resolved process result.
 */
export const spawnOpencodePlugin: ProcessRunner["run"] = async (
  executable,
  args,
) => {
  const opts: SpawnSyncOptions = {
    shell: false,
    encoding: "utf8",
  };

  const result = spawnSync(executable, args, opts);

  if (result.error != null && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      status: null,
      stdout: "",
      stderr: `opencode: executable not found on PATH (${(result.error as NodeJS.ErrnoException).code})`,
      missing: true,
    };
  }

  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    missing: false,
  };
};
