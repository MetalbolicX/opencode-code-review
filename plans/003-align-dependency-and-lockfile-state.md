# Plan 003: Align plugin dependency and lockfile state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 1513b1f..HEAD -- package.json package-lock.json .opencode/package.json .opencode/package-lock.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `1513b1f`, 2026-07-01

## Why this matters

The repo currently has conflicting dependency truth sources. Root `package.json` uses `@opencode-ai/plugin: "latest"`, root `package-lock.json` resolves an older version from a private registry, and `.opencode/package.json` pins a newer explicit version. That makes installs non-deterministic and creates avoidable "works on my machine" risk. This is cheap to fix and improves reproducibility immediately.

## Current state

- The relevant files:
  - `package.json` — root manifest used for repo-level dependency intent.
  - `package-lock.json` — root resolved dependency graph.
  - `.opencode/package.json` — OpenCode-local plugin dependency pin.
  - `.opencode/package-lock.json` — OpenCode-local resolved dependency graph.

- Current code/data excerpts:
  - `package.json:3`
    - `"version": "0.2.0"`
  - `package.json:8`
    - `"test": "echo \"TODO: add tests\" && exit 0"`
  - `package.json:20`
    - `"@opencode-ai/plugin": "latest"`
  - `package-lock.json:3`
    - `"version": "0.1.0"`
  - `package-lock.json:101`
    - root lock resolves `@opencode-ai/plugin` to `1.15.4`
  - `package-lock.json:17` and similar
    - resolved URLs point at `https://npm.my-nas.lan/...`
  - `.opencode/package.json:3`
    - `"@opencode-ai/plugin": "1.17.13"`

- Repo conventions that apply here:
  - Keep the fix limited to dependency metadata and lockfiles.
  - Do not combine this with new tooling, CI, or test framework work in this plan.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Drift check | `git diff --stat 1513b1f..HEAD -- package.json package-lock.json .opencode/package.json .opencode/package-lock.json` | no unexpected drift, or drift understood before editing |
| Inspect current plugin versions | `rg -n '@opencode-ai/plugin|npm.my-nas.lan|\"version\": \"0\\.1\\.0\"|\"latest\"' package.json package-lock.json .opencode/package.json .opencode/package-lock.json` | shows the current drift before the change |
| Reinstall root dependencies | `npm install --registry https://registry.npmjs.org` | exit 0 and regenerated root lockfile |
| Optional reinstall `.opencode` dependencies | `npm install --registry https://registry.npmjs.org` in `.opencode/` | exit 0 if the local plugin sandbox should be refreshed |
| Verify alignment | `rg -n '@opencode-ai/plugin|npm.my-nas.lan|\"version\": \"0\\.1\\.0\"|\"latest\"' package.json package-lock.json .opencode/package.json .opencode/package-lock.json` | old drift markers gone or intentionally preserved with explanation |
| Scope check | `git diff --stat -- package.json package-lock.json .opencode/package.json .opencode/package-lock.json` | only in-scope files changed |

## Scope

**In scope**:
- `package.json`
- `package-lock.json`
- `.opencode/package.json`
- `.opencode/package-lock.json`

**Out of scope**:
- source files under `src/`
- CI workflows
- adding new dependencies for tests/lint/typecheck
- publishing setup or npm release automation

## Git workflow

- Branch: `advisor/003-align-dependency-lockfiles`
- Commit style: concise imperative or conventional commit is acceptable.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Choose one intended `@opencode-ai/plugin` version and make root intent explicit

Use `.opencode/package.json:3` as the current strongest source of truth unless live constraints contradict it.

Target behavior:
- Replace root `"latest"` with an explicit version or semver range aligned to the chosen version.
- Keep the root and `.opencode` manifests intentionally aligned, or document a deliberate reason if they must differ.

Preferred target:
- Root `package.json` uses `^1.17.13` or exact `1.17.13`.
- `.opencode/package.json` remains at `1.17.13` unless there is a proven reason to change both together.

**Verify**: `rg -n '@opencode-ai/plugin' package.json .opencode/package.json` → both manifests show intentional, explicit versions.

### Step 2: Regenerate the root lockfile against the public registry

Refresh `package-lock.json` so it matches the manifest version and no longer points at the private NAS registry.

Target behavior:
- Top-level lockfile version metadata should align with `package.json`.
- Resolved URLs should no longer point to `npm.my-nas.lan`.
- The resolved `@opencode-ai/plugin` version should match the manifest intent from Step 1.

**Verify**: `rg -n 'npm.my-nas.lan|\"version\": \"0\\.1\\.0\"|@opencode-ai/plugin' package-lock.json` → no private-registry URLs, no stale top-level version, plugin version aligned.

### Step 3: Refresh `.opencode` lockfile only if needed

If `.opencode/package-lock.json` already matches its manifest and uses public registry URLs, do not churn it unnecessarily. If it does not, regenerate it too.

**Verify**: `rg -n 'npm.my-nas.lan|@opencode-ai/plugin' .opencode/package-lock.json` → either already clean or updated cleanly.

## Test plan

- No new tests in this plan.
- Verification is metadata-based:
  - root manifest and lockfile agree on intended plugin version
  - root lockfile no longer references the private registry
  - `.opencode` dependency metadata is either aligned or intentionally preserved with explanation
- Optional follow-up after install succeeds:
  - `npx tsc --noEmit`
  - This is useful but not required for this dependency-only plan.

## Done criteria

- [ ] `package.json` no longer uses `"latest"` for `@opencode-ai/plugin`
- [ ] `package-lock.json` top-level version metadata no longer says `0.1.0`
- [ ] `package-lock.json` no longer references `npm.my-nas.lan`
- [ ] root resolved `@opencode-ai/plugin` version matches the intended manifest version
- [ ] no out-of-scope files changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- The live manifests or lockfiles no longer match the excerpts above.
- Regenerating the lockfile requires credentials or registry access unavailable to the executor.
- Aligning root and `.opencode` versions reveals a real runtime incompatibility in the OpenCode host.
- The install command changes many files outside the in-scope list.

## Maintenance notes

- Reviewers should look specifically for accidental dependency upgrades beyond `@opencode-ai/plugin`.
- This plan intentionally does not add typecheck/test/lint dependencies; that belongs in the verification-infrastructure work.
- After this lands, future dependency bumps should avoid `latest` and keep root and `.opencode` aligned unless the repo documents a deliberate split.
