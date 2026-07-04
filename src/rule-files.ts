// ---------------------------------------------------------------------------
// src/rule-files.ts — Loader for markdown rule documents under `review-rules/`.
//
// Reviewers can keep review guidance in markdown files instead of stuffing
// it into `review.json.custom_rules`. Each file has frontmatter:
//
//   ---
//   dimensions: [security, testing]
//   ---
//
//   # Body content here.
//
//   - rule one
//   - rule two
//
// `dimensions: []` means the file applies to every dimension (general rules).
// `dimensions: [security, testing]` scopes the file to those dimensions
// only. Unknown dimension names are filtered out with a warning; if every
// name was unknown the file is skipped entirely.
//
// Two directories are scanned and merged:
//
//   global   = $HOME/.config/opencode/review-rules
//   project  = <project>/.opencode/review-rules
//
// Global files come first, project files after. Within each scope the
// ordering is:
//
//   1. numbered filenames (matching /^\d+-/) sorted by the numeric prefix
//   2. unnumbered filenames sorted alphabetically
//
// Files without valid frontmatter are skipped with a console.warn (or a
// caller-supplied `warn` callback) so a single broken file does not break
// the load.
//
// Disk I/O is funnelled through an injected `RuleFilesFs` interface (the
// same trick `src/cli/config.ts` uses) so the test suite can run entirely
// against an in-memory filesystem.
// ---------------------------------------------------------------------------

/** Built-in dimensions that may appear in rule frontmatter. */
export const KNOWN_DIMENSIONS: ReadonlySet<string> = new Set([
  "code-quality",
  "security",
  "performance",
  "testing",
  "documentation",
  "error-handling",
  "api-design",
  "dependencies",
  "maintainability",
]);

/** Subset of `node:fs` that the loader needs. Tests inject a fake. */
export interface RuleFilesFs {
  readFileSync(path: string): string;
  readdirSync(path: string): string[];
  existsSync(path: string): boolean;
}

/** One parsed rule document. */
export interface RuleFile {
  /** Absolute path to the source `.md` file. */
  path: string;
  /** Which directory the file came from. */
  scope: "global" | "project";
  /**
   * Dimensions this rule applies to. Empty array = general rule that
   * applies to every active dimension.
   */
  dimensions: string[];
  /** Markdown body with frontmatter stripped. */
  body: string;
}

/** Options for {@link loadRuleFiles}. */
export interface LoadRuleFilesOptions {
  /** Absolute path to the global rules directory. */
  globalDir: string;
  /** Absolute path to the project rules directory. */
  projectDir: string;
  /** Set of known dimension names used to filter frontmatter. */
  knownDimensions: ReadonlySet<string>;
  /** Filesystem adapter. */
  fs: RuleFilesFs;
  /** Optional warning sink (defaults to `console.warn`). */
  warn?: (message: string) => void;
}

/** Result of {@link parseFrontmatter}. */
export interface ParsedFrontmatter {
  /** Dimensions list as it appears in the file, before validation. */
  dimensions: string[];
  /** Body content with the frontmatter block removed. */
  body: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse a markdown document with YAML-style frontmatter delimited by `---`.
 *
 * Supports three shapes for the `dimensions` key:
 *
 *   dimensions: []                    → []
 *   dimensions: [security, testing]   → ["security", "testing"]
 *   dimensions:                       → YAML list
 *     - security
 *     - testing
 *
 * Returns `null` when the opening `---` is missing or when the
 * `dimensions` key is absent. Callers must handle the `null` case by
 * skipping the file with a warning.
 */
export const parseFrontmatter = (text: string): ParsedFrontmatter | null => {
  const src = text.replace(/\r\n/g, "\n");

  // Frontmatter must start at the very first line.
  if (!src.startsWith("---\n") && src !== "---") return null;

  // Walk lines from index 1 looking for the closing `---` line.
  const rest = src.startsWith("---\n") ? src.slice(4) : src.slice(3);
  const lines = rest.split("\n");
  let closingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "--- ") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return null;

  const frontLines = lines.slice(0, closingIdx);
  const bodyLines = lines.slice(closingIdx + 1);
  // Drop a leading blank line that follows the closing fence so bodies
  // like "---\nbody" become "body" not "\nbody".
  while (bodyLines.length > 0 && bodyLines[0] === "") bodyLines.shift();
  const body = bodyLines.join("\n");

  const dimensions = parseDimensionsKey(frontLines);
  if (dimensions === null) return null;

  return { dimensions, body };
};

/**
 * Extract the `dimensions` value from frontmatter lines. Returns:
 *   - `string[]` when the key exists (possibly empty)
 *   - `null` when the key is missing
 */
const parseDimensionsKey = (frontLines: string[]): string[] | null => {
  for (let i = 0; i < frontLines.length; i++) {
    const line = frontLines[i] as string;
    const match = /^dimensions\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const inline = (match[1] ?? "").trim();
    if (inline === "") {
      // YAML list form: subsequent indented `- item` lines.
      const items: string[] = [];
      for (let j = i + 1; j < frontLines.length; j++) {
        const next = frontLines[j] as string;
        const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(next);
        if (!itemMatch) break;
        items.push((itemMatch[1] ?? "").trim());
      }
      return items;
    }
    // Inline form: `[]` or `[a, b, c]`.
    return parseInlineDimensions(inline);
  }
  return null;
};

/** Parse an inline dimensions value like `[]` or `[a, b]`. */
const parseInlineDimensions = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (trimmed === "[]") return [];
  // Strip outer brackets if present.
  const inner =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (inner.trim() === "") return [];
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

// ---------------------------------------------------------------------------
// Sort key
// ---------------------------------------------------------------------------

const SCOPE_ORDER: Record<"global" | "project", number> = {
  global: 0,
  project: 1,
};

const sortKey = (file: RuleFile): readonly [number, number, string] => {
  const filename = basename(file.path);
  const numbered = /^(\d+)-/.exec(filename);
  if (numbered) {
    return [SCOPE_ORDER[file.scope], 0, numbered[1] ?? "0"];
  }
  return [SCOPE_ORDER[file.scope], 1, filename];
};

const basename = (filePath: string): string => {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
};

// ---------------------------------------------------------------------------
// Recursive directory walk
// ---------------------------------------------------------------------------

/**
 * Walk `dir` recursively and yield every `.md` file as an absolute path.
 * Missing directories are silently skipped — they are normal on fresh
 * installs and on projects without rules.
 */
const walkMdFiles = (dir: string, fs: RuleFilesFs): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = current.endsWith("/")
        ? `${current}${entry}`
        : `${current}/${entry}`;
      // Treat anything that ends in `.md` as a file. Subdirectories do not
      // end in `.md`, so the same heuristic works for both — we cannot
      // stat files in this abstracted FS.
      if (entry.endsWith(".md")) {
        out.push(child);
      } else {
        stack.push(child);
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load every `.md` rule document from both the global and project rules
 * directories, parse its frontmatter, validate the dimensions list
 * against `knownDimensions`, and return the surviving files in a
 * deterministic order:
 *
 *   1. global scope, numbered filenames (numeric order)
 *   2. global scope, unnumbered filenames (alphabetical)
 *   3. project scope, numbered filenames (numeric order)
 *   4. project scope, unnumbered filenames (alphabetical)
 *
 * Files with malformed or missing frontmatter are skipped with a warning;
 * unknown dimension names are filtered out with a warning, and a file
 * whose dimensions all turned out unknown is also skipped.
 */
export const loadRuleFiles = (opts: LoadRuleFilesOptions): RuleFile[] => {
  const { globalDir, projectDir, knownDimensions, fs } = opts;
  const warn = opts.warn ?? ((msg: string) => console.warn(msg));

  const candidates: RuleFile[] = [];

  for (const mdPath of walkMdFiles(globalDir, fs)) {
    const file = tryParseFile(mdPath, "global", fs, warn);
    if (file) candidates.push(file);
  }
  for (const mdPath of walkMdFiles(projectDir, fs)) {
    const file = tryParseFile(mdPath, "project", fs, warn);
    if (file) candidates.push(file);
  }

  const validated: RuleFile[] = [];
  for (const file of candidates) {
    const { kept, dropped } = validateDimensions(
      file.dimensions,
      knownDimensions,
    );
    if (file.dimensions.length > 0 && kept.length === 0) {
      // All named dimensions were unknown — single consolidated warning so
      // the user sees one cause-and-effect, not two separate alerts.
      warn(
        `[review-rules] skipping ${file.path}: all dimensions were unknown (${dropped.join(", ")})`,
      );
      continue;
    }
    if (dropped.length > 0) {
      warn(
        `[review-rules] ${file.path}: dropping unknown dimension(s): ${dropped.join(", ")}`,
      );
    }
    validated.push({ ...file, dimensions: kept });
  }

  validated.sort((a, b) => {
    const [scopeA, groupA, keyA] = sortKey(a);
    const [scopeB, groupB, keyB] = sortKey(b);
    if (scopeA !== scopeB) return scopeA - scopeB;
    if (groupA !== groupB) return groupA - groupB;
    return keyA.localeCompare(keyB);
  });

  return validated;
};

/**
 * Try to read + parse one rule file. Returns `null` when the file cannot
 * be read or its frontmatter is unusable, after emitting a warning that
 * tells the user why (so they can fix the file).
 */
const tryParseFile = (
  path: string,
  scope: "global" | "project",
  fs: RuleFilesFs,
  warn: (message: string) => void,
): RuleFile | null => {
  let raw: string;
  try {
    raw = fs.readFileSync(path);
  } catch {
    warn(`[review-rules] skipping ${path}: could not read file`);
    return null;
  }
  // Distinguish "no frontmatter at all" from "frontmatter present but no
  // `dimensions` key" so the user gets an actionable message either way.
  const hasFrontmatter =
    raw.startsWith("---\n") || raw.startsWith("---\r\n") || raw === "---";
  if (!hasFrontmatter) {
    warn(`[review-rules] skipping ${path}: missing frontmatter block`);
    return null;
  }
  const parsed = parseFrontmatter(raw);
  if (parsed === null) {
    warn(
      `[review-rules] skipping ${path}: frontmatter is missing the required \`dimensions\` key`,
    );
    return null;
  }
  return {
    path,
    scope,
    dimensions: parsed.dimensions,
    body: parsed.body,
  };
};

/**
 * Split a raw dimensions list into the names that are known and the names
 * that aren't. Empty input is preserved as empty (general rule).
 */
const validateDimensions = (
  raw: readonly string[],
  known: ReadonlySet<string>,
): { kept: string[]; dropped: string[] } => {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const d of raw) {
    if (known.has(d)) kept.push(d);
    else dropped.push(d);
  }
  return { kept, dropped };
};
