import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    "plugin": "src/index.ts",
    "cli": "src/cli/main.ts",
  },
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
