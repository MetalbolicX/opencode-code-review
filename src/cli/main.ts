#!/usr/bin/env node
// ---------------------------------------------------------------------------
// src/cli/main.ts — `ocr` CLI entry point.
//
// Parses argv with `node:util.parseArgs` and dispatches to install,
// uninstall, status, doctor, or update. Exit codes follow the standard
// CLI convention:
//
//   0 — success (including idempotent no-ops)
//   1 — operational / health failure
//   2 — invalid usage (unknown command, missing required arg, etc.)
//
// `runMain` is async and returns `Promise<MainResult>` so every command
// is properly awaited before the exit status is set. Bare `ocr` (no command)
// routes to install — this makes `ocr` a shortcut for `ocr install`.
//
// When the file is built (rolldown), the shebang stays in place so
// `dist/cli.mjs` is directly executable as `ocr`. During dev,
// `pnpm tsx src/cli/main.ts ...` works the same way.
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runInstall } from "./install.ts";
import type { ProcessRunner } from "./spawn.ts";
import { runDoctor, runStatus } from "./status.ts";
import { runUpdate } from "./update.ts";
import { runUninstall } from "./uninstall.ts";

const USAGE = `Usage: ocr <command> [options]

Commands:
  install     Register the plugin in the global OpenCode config
  uninstall   Remove the plugin from the global OpenCode config
  status      Show current installation status
  doctor      Run diagnostic checks on the installation
  update      Update to the latest version (or a specific version with --version)

Options (install):
  -v, --version <v>  Install a specific version (default: latest)
      --latest       Alias for --version latest
      --dry-run      Print the planned change without writing
      --yes          Skip confirmation prompts (reserved)

Options (uninstall):
       --purge        Also remove cache + ~/.config/opencode-code-review/
      --dry-run       Print the planned change without writing
      --yes          Skip confirmation prompts (reserved)

Options (all):
  -h, --help         Show this help and exit
`;

const printUsage = (): void => {
  console.log(USAGE);
};

const setExit = (code: 0 | 1 | 2): void => {
  process.exitCode = code;
};

interface ParsedArgs {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

const parseCliArgs = (argv: readonly string[]): ParsedArgs => {
  const parsed = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    strict: true,
    options: {
      version: { type: "string", short: "v" },
      latest: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      purge: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  return {
    values: parsed.values as Record<string, string | boolean | undefined>,
    positionals: parsed.positionals,
  };
};

/**
 * Strip Node + script argv entries when the entry point is invoked via
 * the shell (shebang) or via `node ./dist/cli.mjs`. When called from a
 * test harness with synthetic args, no stripping happens.
 */
const sliceProcessArgv = (argv: readonly string[]): readonly string[] => {
  if (argv.length < 2) return argv;
  const first = argv[0] ?? "";
  if (
    first === process.argv[0] ||
    first.endsWith("node") ||
    first.endsWith("node.exe")
  ) {
    return argv.slice(2);
  }
  return argv;
};

export interface MainResult {
  command: string | null;
  exitCode: 0 | 1 | 2;
}

/**
 * Options for the CLI entry point. All are optional for production use;
 * tests inject fakes to assert dispatch behaviour.
 */
export interface MainOptions {
  /**
   * Injectable process runner for update. When provided, update uses it
   * instead of the real `opencode plugin` spawn.
   */
  spawn?: ProcessRunner;
}

/**
 * Async dispatcher: takes argv, awaits the matching command, sets
 * `process.exitCode`, and returns a structured result so tests can assert
 * without reading the exit code.
 *
 * Bare `ocr` (no command) routes to install — this makes `ocr` a shortcut
 * for `ocr install`.
 */
export const runMain = async (
  argv: readonly string[] = process.argv,
  opts: MainOptions = {},
): Promise<MainResult> => {
  const args = sliceProcessArgv(argv);

  // Short-circuit `--help` / `-h` before `parseArgs` so the user can ask
  // for help without supplying a command.
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    printUsage();
    return { command: "help", exitCode: 0 };
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(args);
  } catch (err) {
    console.error(`ocr: ${(err as Error).message}`);
    setExit(2);
    return { command: null, exitCode: 2 };
  }

  if (parsed.values.help) {
    printUsage();
    return { command: "help", exitCode: 0 };
  }

  // Bare `ocr` with no positional command → route to install (not exit 2).
  const command = parsed.positionals[0] ?? "install";

  try {
    switch (command) {
      case "install": {
        const versionRaw = parsed.values.version;
        const version =
          parsed.values.latest === true
            ? "latest"
            : typeof versionRaw === "string"
              ? versionRaw
              : undefined;
        await runInstall({
          version,
          dryRun: parsed.values["dry-run"] === true,
          yes: parsed.values.yes === true,
        });
        return { command, exitCode: 0 };
      }
      case "uninstall": {
        await runUninstall({
          purge: parsed.values.purge === true,
          dryRun: parsed.values["dry-run"] === true,
          yes: parsed.values.yes === true,
        });
        return { command, exitCode: 0 };
      }
      case "status": {
        await runStatus();
        return { command, exitCode: 0 };
      }
      case "doctor": {
        const result = runDoctor();
        for (const warning of result.warnings) {
          console.log(`[warning] ${warning}`);
        }
        for (const infoLine of result.info) {
          console.log(`[info] ${infoLine}`);
        }
        if (result.issues.length > 0) {
          for (const issue of result.issues) {
            console.error(`[issue] ${issue}`);
          }
          setExit(1);
          return { command, exitCode: 1 };
        }
        if (result.warnings.length > 0) {
          console.log("Doctor check completed with warnings (see above).");
        } else {
          console.log("Doctor check passed — environment is healthy.");
        }
        return { command, exitCode: 0 };
      }
      case "update": {
        const dryRun = parsed.values["dry-run"] === true;
        const { createRealFs } = await import("./real-fs.ts");
        const result = await runUpdate(
          {
            dryRun,
            spawn: opts.spawn,
          },
          createRealFs(),
          process.env,
        );

        switch (result.status) {
          case "noop":
            // dry-run output is printed inside runUpdate; summary line here
            console.log(`Update available — run without --dry-run to install.`);
            return { command, exitCode: 0 };
          case "stale":
            console.log(`Updated to opencode-code-review`);
            if (result.cachePaths.length > 0) {
              for (const p of result.cachePaths) {
                console.log(`  purged: ${p}`);
              }
            }
            return { command, exitCode: 0 };
          default: {
            // Exhaustive: UpdateStatus is "stale" | "noop"
            const _exhaustive: never = result.status;
            return _exhaustive;
          }
        }
      }
      default: {
        console.error(
          `ocr: unknown command '${command}'. Run \`ocr --help\` for usage.`,
        );
        setExit(2);
        return { command: null, exitCode: 2 };
      }
    }
  } catch (err) {
    console.error(`ocr: ${(err as Error).message}`);
    setExit(1);
    return { command, exitCode: 1 };
  }
};

/**
 * `true` when the file is the program's entry point (shebang / `node
 * cli.mjs`), `false` when it was imported from a test harness. We avoid
 * `import.meta.main` because the package floor is Node 20 and that field
 * only landed in Node 22.
 */
const invokedAsMain = ((): boolean => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

/**
 * CLI bootstrap — called by the IIFE at the bottom of this module when
 * main.ts is the program entry point. Tests can call this directly with
 * custom argv to exercise the full dispatch-and-exit path.
 *
 * @param argv  argv to pass to runMain (default: process.argv.slice(2))
 * @returns     the exit code set on process.exitCode by the dispatched command
 */
export async function runCli(argv?: string[]): Promise<number> {
  const result = await runMain(argv ?? process.argv.slice(2));
  return result.exitCode;
}

if (invokedAsMain) {
  runCli().catch((err) => {
    console.error(`ocr: ${(err as Error).message}`);
    setExit(1);
  });
}
