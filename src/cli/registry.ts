// ---------------------------------------------------------------------------
// src/cli/registry.ts — npm registry latest-version lookup for the OCR plugin.
//
// Uses native fetch() (Node 20+) to query the npm registry for the latest
// published version of `opencode-code-review`. The result feeds into the
// update lifecycle: a valid semver string triggers a stale update (purge +
// force-reinstall); null means registry unreachable and exits 1 before any
// mutation.
//
// The `LatestVersionFn` type is the injectable seam; production code uses
// `fetchLatestVersion` which hits the live npm registry, while tests inject
// a deterministic mock so registry failures can be exercised without network.
//
// Registry URL resolves to the dist-tag redirect for the `latest` version.
// ---------------------------------------------------------------------------

/** npm registry URL for the `opencode-code-review` package's latest dist-tag. */
export const REGISTRY_URL =
  "https://registry.npmjs.org/opencode-code-review/latest";

/**
 * Signature of the latest-version lookup — injected into `runUpdate` so
 * tests can mock network failures and malformed responses deterministically.
 */
export type LatestVersionFn = () => Promise<string | null>;

/**
 * Fetch the latest published version of `opencode-code-review` from the
 * npm registry.
 *
 * Returns the version string on success (e.g. `"1.2.3"`), or `null` when:
 *   - fetch throws (network / DNS failure)
 *   - registry returns a non-OK HTTP status
 *   - response body is not valid JSON
 *   - JSON object has no `version` field, or the field is not a string
 *
 * Does NOT throw — callers handle `null` as "registry unreachable".
 */
export const fetchLatestVersion: LatestVersionFn = async () => {
  let response: Response;
  try {
    response = await fetch(REGISTRY_URL);
  } catch {
    // Network unreachable, DNS failure, etc.
    return null;
  }

  if (!response.ok) {
    // Registry returned 404 / 500 / etc.
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Body is not valid JSON.
    return null;
  }

  if (
    body === null ||
    typeof body !== "object" ||
    !("version" in body) ||
    typeof (body as Record<string, unknown>).version !== "string"
  ) {
    return null;
  }

  const version = (body as { version: string }).version;
  if (version.length === 0) return null;

  return version;
};
