import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Stale compiled .js files may sit in src/ from prior tooling runs.
    // They shadow the .ts source under vitest's default include pattern
    // and drag in fixtures that predate the current config shape.
    exclude: ["**/*.test.js", "**/*.js", "dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "html"],
    },
  },
});
