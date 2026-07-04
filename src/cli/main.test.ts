// ---------------------------------------------------------------------------
// src/cli/main.test.ts — Unit tests for the `ocr` CLI dispatcher.
//
// `runMain(argv)` parses argv with `node:util.parseArgs` and routes to
// `runInstall` / `runUninstall` / `runStatus`. We mock the three
// command runners so the tests are pure dispatch logic — no real fs,
// no real config, no real exit.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runInstall = vi.fn();
const runUninstall = vi.fn();
const runStatus = vi.fn();

vi.mock("./install.ts", () => ({ runInstall }));
vi.mock("./uninstall.ts", () => ({ runUninstall }));
vi.mock("./status.ts", () => ({ runStatus }));

const { runMain } = await import("./main.ts");

let savedExit: number;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedExit = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = 0;
  runInstall.mockReset();
  runUninstall.mockReset();
  runStatus.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = savedExit;
  vi.restoreAllMocks();
});

describe("runMain (dispatcher)", () => {
  it("prints usage and exits 2 when no command is given", () => {
    const r = runMain([]);
    expect(r.command).toBeNull();
    expect(r.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing command"),
    );
  });

  it("prints usage and exits 0 for --help", () => {
    const r = runMain(["--help"]);
    expect(r.command).toBe("help");
    expect(r.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: ocr"));
  });

  it("prints usage and exits 0 for -h", () => {
    const r = runMain(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Usage: ocr"));
  });

  it("routes `install` to runInstall and exits 0", () => {
    const r = runMain(["install"]);
    expect(r.command).toBe("install");
    expect(r.exitCode).toBe(0);
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(runInstall).toHaveBeenCalledWith({
      version: undefined,
      dryRun: false,
      yes: false,
    });
  });

  it("forwards --version and --dry-run to runInstall", () => {
    runMain(["install", "--version", "1.2.3", "--dry-run"]);
    expect(runInstall).toHaveBeenCalledWith({
      version: "1.2.3",
      dryRun: true,
      yes: false,
    });
  });

  it("maps --latest to version=latest", () => {
    runMain(["install", "--latest"]);
    expect(runInstall).toHaveBeenCalledWith(
      expect.objectContaining({ version: "latest" }),
    );
  });

  it("routes `uninstall` to runUninstall and exits 0", () => {
    const r = runMain(["uninstall"]);
    expect(r.command).toBe("uninstall");
    expect(r.exitCode).toBe(0);
    expect(runUninstall).toHaveBeenCalledWith({
      purge: false,
      dryRun: false,
      yes: false,
    });
  });

  it("forwards --purge and --dry-run to runUninstall", () => {
    runMain(["uninstall", "--purge", "--dry-run"]);
    expect(runUninstall).toHaveBeenCalledWith({
      purge: true,
      dryRun: true,
      yes: false,
    });
  });

  it("routes `status` to runStatus and exits 0", () => {
    const r = runMain(["status"]);
    expect(r.command).toBe("status");
    expect(r.exitCode).toBe(0);
    expect(runStatus).toHaveBeenCalledTimes(1);
  });

  it("returns exit 2 for an unknown command", () => {
    const r = runMain(["frobnicate"]);
    expect(r.command).toBeNull();
    expect(r.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown command"),
    );
  });

  it("returns exit 1 when the underlying command throws", () => {
    runInstall.mockImplementation(() => {
      throw new Error("boom");
    });
    const r = runMain(["install"]);
    expect(r.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});
