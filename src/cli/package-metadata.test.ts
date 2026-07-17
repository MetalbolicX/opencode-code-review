// ---------------------------------------------------------------------------
// src/cli/package-metadata.test.ts — Build-time package metadata validation.
//
// Verifies `package.json` declares `oc-plugin: ["server"]` at build time.
// This is a build-time enforcement contract, NOT a doctor runtime check.
//
// Task 1.4: parse repository package.json, assert `oc-plugin` equals `["server"]`
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  version?: string;
  "oc-plugin"?: string[];
  [key: string]: unknown;
}

const readRepoPackageJson = (): PackageJson => {
  // Resolve relative to this test file (src/cli/package-metadata.test.ts)
  const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
  const content = readFileSync(pkgPath, "utf8");
  return JSON.parse(content) as PackageJson;
};

// ---------------------------------------------------------------------------
// oc-plugin metadata
// ---------------------------------------------------------------------------

describe("package.json oc-plugin field", () => {
  // Task 1.4: oc-plugin must equal ["server"]
  it("declares oc-plugin: ['server'] (server-only target)", () => {
    const pkg = readRepoPackageJson();
    expect(pkg["oc-plugin"]).toEqual(["server"]);
  });

  it("package has a name", () => {
    const pkg = readRepoPackageJson();
    expect(pkg.name).toBeTruthy();
  });

  it("package has a version", () => {
    const pkg = readRepoPackageJson();
    expect(pkg.version).toBeTruthy();
  });
});
