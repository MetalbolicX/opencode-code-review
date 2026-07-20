// src/cli/spawn.ts — Shell-free, injectable OpenCode plugin spawn wrapper.
// Slice 2: async child_process.spawn + 30s SIGKILL. ProcessRunner interface preserved for update.ts.

import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Result of a process run via the async spawn seam.
 * Mirrors the reference repo's SpawnResult.
 */
export interface SpawnResult {
  /** Process exit code. */
  status: number | null;
  /** Captured stdout (decoded as utf8). */
  stdout: string;
  /** Captured stderr (decoded as utf8). */
  stderr: string;
}

/**
 * Backward-compatible result type for `ProcessRunner`.
 * Adds `missing: boolean` on top of SpawnResult fields.
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

// ---------------------------------------------------------------------------
// SpawnFn types (new injectable seam — reference repo design)
// ---------------------------------------------------------------------------

/**
 * Options passed to a `SpawnFn`.
 */
export interface SpawnCallOptions {
  env: NodeJS.ProcessEnv;
  stdio?: "pipe" | "inherit";
}

/**
 * Injectable spawn function. Receives the raw command + args so callers
 * can be tested with a deterministic fake.
 *
 * The returned `Promise` resolves with `SpawnResult` on success or failure;
 * callers interpret `result.status` and `result.stderr` to decide outcomes.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: SpawnCallOptions,
) => Promise<SpawnResult> | SpawnResult;

/**
 * Options for `spawnOpencodePlugin`.
 */
export interface SpawnOpencodePluginOptions {
  /**
   * Injected spawn function. Defaults to `defaultSpawn` (async spawn with
   * 30-second SIGKILL timeout).
   */
  spawn?: SpawnFn;
  /** Environment variables passed to the child process. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * stdio mode for the child process.
   * - `"pipe"` (default): capture stdout/stderr into result strings.
   * - `"inherit"`: forward directly to the parent process (no capture).
   */
  stdio?: "pipe" | "inherit";
}

// ---------------------------------------------------------------------------
// Default async spawn — 30-second SIGKILL timeout
// ---------------------------------------------------------------------------

/**
 * Default process spawner used by spawnOpencodePlugin.
 * Executes a command with the given arguments via child_process.spawn
 * with shell: false, resolving with { status, stdout, stderr } on any
 * outcome (success, error, timeout).
 */
export const defaultSpawn: SpawnFn = async (
  command,
  args,
  options,
): Promise<SpawnResult> => {
  const stdio = options.stdio ?? "pipe";

  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Hard timeout: SIGKILL after 30 s
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore "process already exited" errors
      }
    }, 30_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: err.message });
    });
  });
};

// ---------------------------------------------------------------------------
// Public API — spawnOpencodePlugin
//
// Two calling conventions:
//  1. ProcessRunner-compatible: spawnOpencodePlugin(executable, args)
//     → executable is always "opencode"; args includes "plugin" prefix.
//  2. New SpawnFn-based: spawnOpencodePlugin(args, opts?)
//     → preferred new interface; "plugin" is prepended internally
// ---------------------------------------------------------------------------

/**
 * Run `opencode plugin <args...>` and return captured stdout/stderr.
 *
 * SIGNATURE A (ProcessRunner-compatible):
 *   spawnOpencodePlugin("opencode", ["plugin", "spec", "--global", "--force"])
 *   → executable is always "opencode"; args includes "plugin" prefix.
 *   → Used by update.ts via { run: spawnOpencodePlugin }.
 *
 * SIGNATURE B (SpawnFn-based — preferred new interface):
 *   spawnOpencodePlugin(["spec", "--global", "--force"], { spawn?, env?, stdio? })
 *   → "plugin" is prepended internally.
 *   → Preferred for new code using SpawnFn injection.
 *
 * Default spawn uses async `spawn` with a 30-second SIGKILL timer so the
 * call never blocks the CLI indefinitely even when the opencode CLI hangs.
 */
type SpawnOverload = {
  // Signature A — ProcessRunner-compatible (executable, args, opts?)
  // The third arg { spawn?, env?, stdio? } is for unit-test injectability only.
  (executable: "opencode", args: string[], opts?: SpawnOpencodePluginOptions): Promise<ProcessResult>;
  // Signature B — SpawnFn-based (args, opts?)
  (args: string[], opts?: SpawnOpencodePluginOptions): Promise<SpawnResult>;
};

const _spawnPluginImpl = async (
  executableOrArgs: "opencode" | string[],
  argsOrOpts?: string[] | SpawnOpencodePluginOptions,
  signatureAOpts?: SpawnOpencodePluginOptions,
): Promise<ProcessResult | SpawnResult> => {
  // Detect which signature is being used
  const isSignatureA = executableOrArgs === "opencode";

  let pluginArgs: string[];
  let opts: SpawnOpencodePluginOptions;

  if (isSignatureA) {
    // Signature A: (executable, args, opts?)
    // args already includes "plugin" prefix; opts is for testing injectability.
    pluginArgs = argsOrOpts as string[];
    opts = signatureAOpts ?? {};
  } else {
    // Signature B: (args, opts) — prepend "plugin" internally
    // e.g. args = ["opencode-code-review", "--global", "--force"]
    pluginArgs = ["plugin", ...executableOrArgs];
    opts = (argsOrOpts as SpawnOpencodePluginOptions) ?? {};
  }

  const env = opts.env ?? process.env;
  const stdio = opts.stdio ?? "pipe";
  const spawnFn = opts.spawn ?? defaultSpawn;

  let result: SpawnResult;
  try {
    result = await Promise.resolve(
      spawnFn("opencode", pluginArgs, { env, stdio }),
    );
  } catch (err) {
    // Spawn failure (command not found, permission denied, etc.) — return safe result
    result = {
      status: null,
      stdout: "",
      stderr: (err as Error).message,
    };
  }

  if (isSignatureA) {
    // Return ProcessResult (with missing field) for ProcessRunner callers
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      missing: result.status === null && !!result.stderr,
    } as ProcessResult;
  }

  return result as SpawnResult;
};

// Cast the implementation to satisfy the overloads
export const spawnOpencodePlugin: SpawnOverload = _spawnPluginImpl as SpawnOverload;

// ---------------------------------------------------------------------------
// ProcessRunner interface (used by update.ts and main.ts option types)
// ---------------------------------------------------------------------------

/**
 * Injectable process runner used by update.ts and main.ts.
 * The returned `Promise` is always resolved (never rejected) — callers
 * interpret `result.missing` or `result.status` to decide outcomes.
 */
export interface ProcessRunner {
  run(executable: "opencode", args: string[]): Promise<ProcessResult>;
}
