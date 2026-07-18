# opencode-code-review

An automatic code review plugin for [OpenCode](https://opencode.ai) CLI. Automatically reviews staged changes when a session goes idle, with configurable cooldown, multi-dimension analysis, and auto-fix support.

## Features

- **Auto-review on idle** — automatically triggers code review when session completes, with configurable cooldown (`cooldown_seconds`) to prevent duplicate reviews
- **Auto-fix chain** — critical issues spawn a `ocr-review:fixer` sub-agent that applies minimal fixes automatically
- **On-demand review** — `/ocr-review` slash command or Tab-switchable `ocr-review` agent for manual reviews
- Three review scopes: staged changes, last commit, full branch diff
- Configurable review dimensions (code quality, security, performance, testing, documentation)
- Structured output with severity levels (critical / suggestion / highlight)
- Supports Chinese and English output

## Installation

### Local plugin (recommended)

Copy or symlink into your OpenCode plugins directory:

```bash
# Project-level
mkdir -p .opencode/plugins
ln -s /path/to/opencode-code-review/src/index.ts .opencode/plugins/opencode-code-review.ts

# Or global
ln -s /path/to/opencode-code-review/src/index.ts ~/.config/opencode/plugins/opencode-code-review.ts
```

### npm

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-code-review"]
}
```

Or install directly:

```bash
npm install -g opencode-code-review
```

## Development

Requires Node.js 18+ and pnpm.

```bash
pnpm install          # Install dependencies
pnpm typecheck       # Type-check TypeScript
pnpm lint            # Lint with Biome
pnpm build           # Compile to dist/
pnpm verify          # Run all checks (typecheck, lint, build, test)
```

## Usage

### Slash Command

```
/ocr-review                    # Review staged changes
/ocr-review:auto               # Toggle auto-review (query current state)
/ocr-review:auto on            # Enable auto-review
/ocr-review:auto off           # Disable auto-review
```

Note: `/ocr-review:auto` changes are in-memory only and reset to the config file value on restart.

### Agent Mode

Press `Tab` twice to switch to the `ocr-review` agent, then describe what you want reviewed.

### CLI

```bash
opencode run --agent ocr-review "Review the current changes"
```

## Configuration

Create `.opencode/review.json` in your project (or `~/.config/opencode/review.json` globally):

```json
{
  "language": "zh",
  "dimensions": [
    "code-quality",
    "security",
    "performance",
    "testing",
    "documentation"
  ],
  "max_diff_lines": 500,
  "trigger": {
    "auto_on_idle": true,
    "cooldown_seconds": 120
  },
  "custom_rules": [
    "All API endpoints must have error handling",
    "Database queries must use parameterized statements"
  ],
  "intensity": "full",
  "parallel": true,
  "profile": "default"
}
```

### Thermo-Nuclear Profile Example

```json
{
  "profile": "thermo-nuclear",
  "dimensions": ["code-quality", "security"],
  "parallel": true
}
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `language` | Output language (`"zh"` or `"en"`) | `"zh"` |
| `dimensions` | Review dimensions to check | All 5 dimensions |
| `max_diff_lines` | Max diff lines before truncation | `500` |
| `trigger.auto_on_idle` | Auto-review when session goes idle | `false` |
| `trigger.cooldown_seconds` | Minimum interval between auto-reviews (seconds) | `120` |
| `custom_rules` | Additional project-specific rules | `[]` |
| `intensity` | Simplification-lens strictness (`"lite"` / `"full"` / `"ultra"`); see [Code Quality Simplification Lens](#code-quality-simplification-lens) | `"full"` |
| `parallel` | Run dimension sub-agents in parallel (`true`) or sequentially (`false`) | `true` |
| `profile` | Review profile (`"default"` / `"basic"` / `"medium"` / `"thermo-nuclear"`); see [Profiles](#profiles) | `"default"` |

## Code Quality Simplification Lens

The `code-quality` dimension can flag code that can be deleted, skipped, shrunk, or replaced with stdlib / native equivalents. The lens never overrides correctness, security, accessibility, or behavior — it is a strictness slider, not a permission to change semantics.

### Tags

Simplification findings are emitted using exactly five tags:

| Tag | Meaning |
|-----|---------|
| `delete` | Deletable redundancy (unused imports / variables, dead branches, removable comments) |
| `yagni` | Logic that exists only for speculative future needs |
| `shrink` | Behavior-equivalent rewrites only — outputs, side effects, error handling, and resource release are all preserved |
| `stdlib` | Replaceable by the standard library or an existing dependency |
| `native` | Replaceable by a language or platform built-in |

The tag list is centralised in `src/prompts/shared.ts` (`SIMPLIFICATION_TAGS`) so the dimension body, the orchestrator prompts, the fixer exclusion clause, and the tests share one source of truth.

### Functional Safety Boundary

The lens will **not** recommend a simplification that:

- changes **behavior**, **output**, or **side effects**
- weakens **input validation**, **error handling**, or **resource release**
- weakens **security** (auth, secrets, injection defense)
- weakens **accessibility**
- weakens a **performance hot path**

`shrink` is reserved for provably-equivalent rewrites. Anything that drifts from the original semantics falls outside the lens and is rejected.

### Intensity

`intensity` controls how aggressively the lens scans for opportunities. It only changes the `code-quality` simplification review — it does not create a new dimension, add a severity level, or affect security / performance / testing / documentation.

| Value | Effect |
|-------|--------|
| `lite` | Only flag clearly deletable, low-risk redundancy (unused imports / variables, obvious dead code, trivially duplicated logic) |
| `full` | **Default.** Standard evaluation across all five tags at normal depth |
| `ultra` | Flag every reasonable candidate, including subtle `shrink` / `stdlib` / `native` rewrites |

Any value other than `lite` / `full` / `ultra` (or a missing field) is normalised to `"full"`, so the setting is always safe to add incrementally.

### Output Convention

Simplification findings MAY be prefixed with `[tag]` for classification, e.g.:

```text
🟡 **[src/utils.ts:42]** [yagni] Helper kept for an "edge case" with no current call site
🟡 **[src/parser.ts:88]** [stdlib] Re-implements `Array.prototype.flatMap`
🟡 **[src/api.ts:120]** [shrink] Loop with same output and side effects as `Promise.all`
```

The `[tag]` is a classifier only — it does **not** change the severity (🔴 / 🟡 / ✅). Reviewers may omit the prefix when classification is not useful in context.

### Fixer Safety

The auto-fixer is explicitly forbidden from touching simplification findings, even when other findings in the same review are auto-fixable. This is a defense-in-depth rule: if a simplification issue is forwarded to the fixer, it is reported as `⚠️ ... Simplification finding, do not auto-fix` instead of being patched. All five tags — `delete`, `yagni`, `shrink`, `stdlib`, `native` — are excluded from auto-fix.

Simplification requires human judgment because auto-fixing it can change behavior, weaken validation, or shift semantics. If you want a finding fixed, apply it manually after review.

## Profiles

`profile` selects a review posture that changes the tone and depth of simplification guidance within the `code-quality` dimension. It is orthogonal to `intensity` and does not affect other dimensions or the auto-fixer.

| Profile | Scope | Posture |
|---------|-------|---------|
| `"default"` | No ladder emitted | N/A — no simplification guidance |
| `"basic"` | Code-quality ladder, rungs 1–3 | Advisory — "consider" wording |
| `"medium"` | Code-quality ladder, rungs 1–5 | Enforced — "must" wording |
| `"thermo-nuclear"` | Code-quality ladder, rungs 1–7 + existing thermo rubric | Aggressive — `[thermo]` exclusion |

### YAGNI Ladder

The ladder is a 7-rung "does this need to exist?" checklist. Each rung maps to one or more existing simplification tags. The ladder is emitted only within the `code-quality` dimension — security, performance, testing, and documentation dimensions are unaffected by any profile.

| Rung | Question | Tags |
|------|----------|------|
| 1 | Need to exist? | `delete`, `yagni` |
| 2 | Reuse existing codebase code? | `yagni`, `shrink` |
| 3 | Stdlib equivalent? | `stdlib` |
| 4 | Native language feature? | `native` |
| 5 | Installed dependency? | `stdlib` |
| 6 | Collapsible to a one-liner? | `shrink` |
| 7 | Safety fallback baseline | none (functional-safety contract) |

### `basic`

Sets the review posture to advisory. The ladder includes rungs 1–3. Reviewers are asked to "consider" each question but no finding is blocked.

```json
{
  "profile": "basic"
}
```

Posture is prompt wording only — it does not gate, block, or auto-fix any candidate, and it does not affect the fixer.

### `medium`

Sets the review posture to enforced. The ladder includes rungs 1–5. Reviewers are expected to apply the "must" criteria when evaluating candidates.

```json
{
  "profile": "medium"
}
```

### `thermo-nuclear`

**Opt-in.** Activated by setting `profile: "thermo-nuclear"` in `.opencode/review.json`.

This profile applies a structural-simplification lens to the `code-quality` dimension — it actively flags code that can be deleted, replaced with stdlib, or shrunk without changing behaviour. It is not a sixth dimension; it overlays the `code-quality` dimension with sharper criteria.

**How it differs from `intensity`:**

| Dimension | `intensity` | `profile` |
|-----------|-------------|-----------|
| Scope | Only `code-quality` | Only `code-quality` |
| Effect | How hard the lens scans | What the lens is looking for |
| Tags | N/A | Adds structural tags (`delete`, `yagni`, `shrink`, `stdlib`, `native`) |
| Auto-fixer | Affected by `intensity` level | Explicitly blocked for all thermo findings |

The two settings are independent and compose: you can run `profile: "thermo-nuclear"` with any `intensity` value.

```json
{
  "profile": "thermo-nuclear"
}
```

## Parallel Mode

`parallel` controls whether dimension sub-agents run concurrently or sequentially.

| Value | Behaviour |
|-------|-----------|
| `true` (default) | All enabled dimensions spawn as independent sub-agents and run concurrently |
| `false` | Dimensions run one after another in the order listed in `dimensions` |

Parallel mode is faster for multi-dimension reviews but uses more concurrent agent slots. Sequential mode is useful for constrained environments or when dimension results need to be ordered.

```json
{
  "parallel": false
}
```

## File Rules

File rules let you add dimension-specific guidance that applies only to certain files or directories. Rules are defined in `.opencode/review-rules/` directories within your project.

### Directory Structure

```
.opencode/
  review-rules/
    <dimension>/
      <rule-name>.md   # general rule — applies to all files in the project
    <dimension>/
      <subdir>/        # scoped rule — applies only to files under <subdir>
        <rule-name>.md
```

### Rule File Format

```markdown
# Rule title (first line becomes the rule identifier)

Additional context and guidance for the reviewer.
Can include multiple paragraphs, code examples, etc.
```

### Routing

- Files directly under `.opencode/review-rules/<dimension>/` are **general rules** — injected into every review for that dimension regardless of which files changed.
- Files in sub-directories under `.opencode/review-rules/<dimension>/` are **scoped rules** — injected only when the review touches files within that sub-directory's path.

### Example

```
.opencode/
  review-rules/
    security/
      no-sql-injection.md          # general — applies to all security reviews
      auth/
        mfa-required.md             # scoped — only when auth/ files are changed
```

## License

MIT
