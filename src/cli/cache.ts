// ---------------------------------------------------------------------------
// src/cli/cache.ts — Recursive directory purge for the opencode-code-review
// plugin cache.
//
// Cache path resolution is centralized in `src/cli/config.ts` (which see).
// This module exposes only the best-effort recursive delete so that failures
// during cleanup never abort the calling command.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import type { CliFs } from "./config.ts";

// ---------------------------------------------------------------------------
// Recursive purge
// ---------------------------------------------------------------------------

/**
 * Recursively delete a directory and all its contents using the injected fs.
 * Best-effort — a failed purge is not fatal; we want the install to keep going.
 */
export const purgeDirectory = (fs: CliFs, dirPath: string): void => {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
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
          purgeDirectory(fs, entryPath);
          fs.rmdirSync(entryPath);
        }
      } catch {
        // Not a directory (or unreadable) — best-effort unlink.
        fs.unlinkSync(entryPath);
      }
    } catch {
      // best-effort per entry
    }
  }

  try {
    fs.rmdirSync(dirPath);
  } catch {
    // best-effort
  }
};
