// ---------------------------------------------------------------------------
// scripts/verify-install.mjs — Global install parity check.
//
// Compares the local symlinked plugin (`.opencode/plugins/ocr.ts`, the raw
// TypeScript source) against the published plugin installed at
// `~/.cache/opencode/packages/opencode-code-review@latest/dist/plugin.mjs`.
//
// Asserts `global ⊇ local` for agents / commands / tools. Local is the
// reference — if anything registered locally is missing from the global
// install, this script exits non-zero.
//
// Skip with `SKIP_INSTALL_VERIFY=1` for environments where the global
// plugin is intentionally absent (CI without `ocr install`).
//
// Usage:
//   npx ocr@latest update                  # populate the global cache first
//   pnpm verify:install                    # then run this script
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const LOCAL_PLUGIN = join(REPO_ROOT, ".opencode/plugins/ocr.ts");
const GLOBAL_PLUGIN = join(
  homedir(),
  ".cache/opencode/packages/opencode-code-review@latest/dist/plugin.mjs",
);

const PROBE_INPUT = JSON.stringify({
  client: { session: { promptAsync: async () => ({}) } },
  project: {},
  directory: "/tmp",
  worktree: "/tmp",
});

// ---------------------------------------------------------------------------

const skip = process.env.SKIP_INSTALL_VERIFY === "1";
if (skip) {
  console.log("SKIP_INSTALL_VERIFY=1 — skipping install parity check.");
  process.exit(0);
}

if (!existsSync(GLOBAL_PLUGIN)) {
  console.error(`FAIL: global plugin not installed.`);
  console.error(`  expected: ${GLOBAL_PLUGIN}`);
  console.error(`  fix:      npx opencode-code-review@latest update`);
  console.error(`  skip:     SKIP_INSTALL_VERIFY=1 pnpm verify:install`);
  process.exit(1);
}

// Load the local plugin by spawning a Node subprocess with
// --experimental-strip-types so it can import the raw `.ts` source the same
// way OpenCode's runtime does.
function loadLocal() {
  const snippet = `
    import ocr from ${JSON.stringify(LOCAL_PLUGIN)};
    const result = await ocr.server(${PROBE_INPUT});
    const cfg = { agent: {}, command: {} };
    await result.config(cfg);
    process.stdout.write(JSON.stringify({
      agents: Object.keys(cfg.agent).sort(),
      commands: Object.keys(cfg.command).sort(),
      tools: Object.keys(result.tool ?? {}).sort(),
    }));
  `;
  const out = execFileSync(
    "node",
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", snippet],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  return JSON.parse(out.trim());
}

async function loadGlobal() {
  const mod = await import(GLOBAL_PLUGIN);
  const plugin = mod.default;
  if (typeof plugin?.server !== "function") {
    throw new Error(
      `global plugin missing V1 'server' descriptor — check oc-plugin / exports in package.json`,
    );
  }
  const result = await plugin.server(JSON.parse(PROBE_INPUT));
  const cfg = { agent: {}, command: {} };
  await result.config(cfg);
  return {
    agents: Object.keys(cfg.agent).sort(),
    commands: Object.keys(cfg.command).sort(),
    tools: Object.keys(result.tool ?? {}).sort(),
  };
}

const local = loadLocal();
const global = await loadGlobal();

const missing = {
  agents: local.agents.filter((k) => !global.agents.includes(k)),
  commands: local.commands.filter((k) => !global.commands.includes(k)),
  tools: local.tools.filter((k) => !global.tools.includes(k)),
};

const fail =
  missing.agents.length > 0 ||
  missing.commands.length > 0 ||
  missing.tools.length > 0;

if (fail) {
  console.error("FAIL: global plugin does not register all features present in local plugin.");
  console.error(JSON.stringify(missing, null, 2));
  console.error(`  local:  ${LOCAL_PLUGIN}`);
  console.error(`  global: ${GLOBAL_PLUGIN}`);
  process.exit(1);
}

console.log("PASS: global ⊇ local");
console.log(`  agents:   ${global.agents.length}`);
console.log(`  commands: ${global.commands.length}`);
console.log(`  tools:    ${global.tools.length}`);