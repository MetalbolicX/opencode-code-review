import opencodeReview from "./index.ts";

/**
 * OpenCode plugin entry point.
 *
 * Exports the V1 plugin descriptor shape (`{ id, server }`) so opencode's
 * loader takes the V1 path in `applyPlugin` (packages/opencode/src/plugin/index.ts),
 * which calls only `descriptor.server(input)` and ignores named exports.
 *
 * The legacy fallback path would otherwise iterate every exported function
 * in this module and invoke it as a plugin factory — `src/index.ts` also
 * exports the `extractSessionId` helper, which would be called with the
 * plugin input, return `undefined`, and crash the loader with
 * "undefined is not an object (evaluating 'N.config')".
 *
 * Keeping the wrapper thin (no re-exports) ensures the legacy path never
 * sees helper functions from `src/index.ts`.
 */
export default {
  id: "opencode-code-review",
  server: opencodeReview,
};
