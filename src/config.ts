import { readFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  KNOWN_DIMENSIONS,
  loadRuleFiles,
  type RuleFile,
  type RuleFilesFs,
} from "./rule-files.ts";

export interface ReviewConfig {
  language: string;
  dimensions: string[];
  max_diff_lines: number;
  trigger: {
    auto_on_idle: boolean;
    cooldown_seconds: number;
  };
  custom_rules: string[];
  /**
   * Markdown rule documents loaded from `review-rules/`. General rules
   * (empty dimensions) apply everywhere; scoped rules route to the
   * dimensions listed in their frontmatter.
   */
  file_rules: RuleFile[];
  parallel: boolean;
}

const DEFAULT_CONFIG: ReviewConfig = {
  language: "zh",
  dimensions: [
    "code-quality",
    "security",
    "performance",
    "testing",
    "documentation",
  ],
  max_diff_lines: 500,
  trigger: {
    auto_on_idle: false,
    cooldown_seconds: 120,
  },
  custom_rules: [],
  file_rules: [],
  parallel: true,
};

const CONFIG_FILENAME = "review.json";
const GLOBAL_RULES_DIRNAME = "review-rules";
const PROJECT_RULES_DIRNAME = "review-rules";

/** Sync `node:fs` adapter injected into `loadRuleFiles`. */
const makeNodeFs = (): RuleFilesFs => ({
  readFileSync: (p: string): string => nodeFs.readFileSync(p, "utf-8"),
  readdirSync: (p: string): string[] => nodeFs.readdirSync(p),
  existsSync: (p: string): boolean => nodeFs.existsSync(p),
});

const readJsonFile = async (
  path: string,
): Promise<Partial<ReviewConfig> | null> => {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

export const loadConfig = async (projectDir: string): Promise<ReviewConfig> => {
  const globalPath = join(homedir(), ".config", "opencode", CONFIG_FILENAME);
  const projectPath = join(projectDir, ".opencode", CONFIG_FILENAME);

  const [globalCfg, projectCfg] = await Promise.all([
    readJsonFile(globalPath),
    readJsonFile(projectPath),
  ]);

  // Markdown rule documents live under `review-rules/` in two scopes.
  // Missing directories are silently skipped by the loader — a fresh
  // install or a project without a rules tree is normal.
  const fileRules = loadRuleFiles({
    globalDir: join(homedir(), ".config", "opencode", GLOBAL_RULES_DIRNAME),
    projectDir: join(projectDir, ".opencode", PROJECT_RULES_DIRNAME),
    knownDimensions: KNOWN_DIMENSIONS,
    fs: makeNodeFs(),
  });

  return {
    ...DEFAULT_CONFIG,
    ...globalCfg,
    ...projectCfg,
    trigger: {
      ...DEFAULT_CONFIG.trigger,
      ...(globalCfg?.trigger ?? {}),
      ...(projectCfg?.trigger ?? {}),
    },
    file_rules: fileRules,
  };
};
