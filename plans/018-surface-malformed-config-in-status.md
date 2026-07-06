# Plan 018: Surface malformed config in ocr status

> Keep the behavior aligned with install/uninstall: malformed config should be explicit, not silently recast as "not installed." 

## Status
| Field | Value |
|---|---|
| Priority | P1 |
| Effort | S |
| Risk | LOW |
| Depends on | - |
| Category | correctness |
| Planned at | 2026-07-05 |

## Why this matters
`status` is the operator's first diagnostic command. If the global config is malformed, it should say so directly instead of reporting a benign-looking "Installed: no".

## Current state
- `src/cli/config.ts:476-493` returns `parseError` on malformed global config.
- `src/cli/status.ts:42-63` ignores `parseError` and continues.
- `src/cli/install.ts:64-71` and `src/cli/uninstall.ts:85-92` already abort on malformed config.

## Commands you will need
| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exits 0 |
| Tests | `pnpm test` | exits 0 |

## Scope
In scope: `src/cli/status.ts`, status tests.
Out of scope: config parsing itself.

## Git workflow
Use `fix(cli): surface malformed config in status`.

## Steps
1. Check `loaded.parseError` in `runStatus`.
2. Print a clear error and return a non-zero result when the global config is malformed.
3. Add a malformed-config regression test to `src/cli/status.test.ts`.

## Test plan
- Malformed config emits an error and non-zero exit.
- Healthy config still reports installed state normally.

## Done criteria
- [ ] `status` no longer hides malformed global config.
- [ ] Tests cover the broken-config case.
- [ ] `pnpm verify` passes.

## STOP conditions
If the current CLI entrypoint does not propagate a non-zero return from `runStatus`, stop and inspect `main.ts` before changing the function contract.

## Maintenance notes
This is a diagnostics fix, not a config-loader change.
