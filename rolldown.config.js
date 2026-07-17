import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    "plugin": "src/index.ts",
    "cli": "src/cli/main.ts",
  },
  // Keep jsonc-parser external so the published package resolves the real
  // dependency at runtime instead of inlining rolldown's CommonJS helper chunk.
  external: ["jsonc-parser"],
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].mjs",
    sourcemap: true,
  },
  platform: "node",
  target: "node18",
  resolve: {
    extensions: [".ts", ".js", ".mjs"],
  },
});
