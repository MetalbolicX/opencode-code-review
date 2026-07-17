// ---------------------------------------------------------------------------
// src/cli/real-fs.ts — Default `CliFs` adapter backed by `node:fs`.
//
// The CLI commands (`install`, `uninstall`, `status`) default to the real
// filesystem in production. Tests inject an in-memory adapter via the
// second argument to keep everything deterministic and fast.
//
// The mapping is intentionally thin: only the methods `CliFs` exposes are
// bound, and `readFileSync` returns a UTF-8 string (the only shape the CLI
// helpers consume). The `rmdirSync` implementation uses `node:fs.rmSync`
// with `recursive: true` so it can handle non-empty directories during
// purge operations.
// ---------------------------------------------------------------------------

import {
  accessSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import type { CliFs } from "./config.ts";

/**
 * Build a `CliFs` that delegates to `node:fs`. All methods are sync; the
 * CLI is short-lived and never benefits from async I/O.
 */
export const createRealFs = (): CliFs => ({
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileSync: (path, content) => {
    writeFileSync(path, content);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  copyFileSync: (from, to) => {
    copyFileSync(from, to);
  },
  unlinkSync: (path) => {
    unlinkSync(path);
  },
  mkdirSync: (path, opts) => {
    mkdirSync(path, opts);
  },
  readdirSync: (path) => readdirSync(path),
  existsSync: (path) => existsSync(path),
  rmdirSync: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  canWrite: (path) => {
    try {
      accessSync(path, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
});
