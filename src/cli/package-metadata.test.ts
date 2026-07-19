// src/cli/package-metadata.test.ts — Slice 5: assert package version is 1.0.5
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

describe("package.json version", () => {
  it("version field must be 1.0.5", () => {
    // __dirname in compiled output is dist/cli/ — go up 2 levels to repo root
    const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
    const pkg = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    );
    expect(pkg.version).toBe("1.0.5");
  });
});
