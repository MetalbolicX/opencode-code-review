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

export type ReviewIntensity = "lite" | "full" | "ultra";

export type ReviewProfile = "default" | "basic" | "medium" | "thermo-nuclear";

const VALID_INTENSITIES: readonly ReviewIntensity[] = ["lite", "full", "ultra"];

const VALID_PROFILES: readonly ReviewProfile[] = [
  "default",
  "basic",
  "medium",
  "thermo-nuclear",
];

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
  /**
   * Strictness level applied to the simplification lens within
   * `code-quality`. Anything other than `lite` | `full` | `ultra`
   * (including missing) is normalised to `"full"` by `loadConfig`.
   */
  intensity: ReviewIntensity;
  /**
   * Review profile that determines the rubric and rules applied.
   * Anything other than `"default"` | `"basic"` | `"medium"` | `"thermo-nuclear"`
   * (including missing) is normalised to `"default"` by `loadConfig`.
   */
  profile: ReviewProfile;
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
  intensity: "full",
  profile: "default",
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
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    console.warn(
      `[opencode-code-review] ${path}: could not read config — ${(err as Error).message}`,
    );
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      console.warn(
        `[opencode-code-review] ${path}: config root must be a JSON object`,
      );
      return null;
    }
    return parsed as Partial<ReviewConfig>;
  } catch (err) {
    console.warn(
      `[opencode-code-review] ${path}: malformed config JSON — ${(err as Error).message}`,
    );
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
    intensity: normalizeIntensity((projectCfg ?? globalCfg)?.intensity),
    profile: normalizeProfile((projectCfg ?? globalCfg)?.profile),
  };
};

/**
 * Coerce a raw `intensity` value from config (or `undefined`) into a valid
 * `ReviewIntensity`. Anything outside the allowed set falls back to `"full"`,
 * which is the documented default and keeps the loader strictly additive.
 */
const normalizeIntensity = (raw: unknown): ReviewIntensity => {
  if (typeof raw === "string") {
    if ((VALID_INTENSITIES as readonly string[]).includes(raw)) {
      return raw as ReviewIntensity;
    }
  }
  return "full";
};

/**
 * Coerce a raw `profile` value from config (or `undefined`) into a valid
 * `ReviewProfile`. Anything outside the allowed set falls back to `"default"`,
 * which is the documented default and keeps the loader strictly additive.
 */
const normalizeProfile = (raw: unknown): ReviewProfile => {
  if (typeof raw === "string") {
    if ((VALID_PROFILES as readonly string[]).includes(raw)) {
      return raw as ReviewProfile;
    }
  }
  return "default";
};
