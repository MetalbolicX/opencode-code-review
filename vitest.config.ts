import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Stale compiled .js files may sit in src/ from prior tooling runs.
    // They shadow the .ts source under vitest's default include pattern
    // and drag in fixtures that predate the current config shape.
    exclude: ["**/*.test.js", "**/*.js", "dist/**", "node_modules/**"],
    // Fail the verification gate when a committed test narrows focus with
    // .only/.skip — they make CI pass while hiding regressions locally.
    forbidOnly: true,
    coverage: {
      // Coverage collection is opt-in on `vitest run`; without this flag the
      // thresholds below are never evaluated and the gate is a no-op.
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html"],
      // Thresholds reflect the current baseline; a regression in any metric
      // fails the run so coverage never quietly drops on a merged PR.
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 85,
        lines: 90,
      },
    },
  },
});
