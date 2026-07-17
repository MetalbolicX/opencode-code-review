// ---------------------------------------------------------------------------
// src/cli/registry.test.ts — Unit tests for npm registry latest-version lookup.
//
// fetchLatestVersion uses native fetch() (Node 20+) and returns the version
// string from the npm registry JSON response, or null on any failure.
// Tests inject a fake fetch to exercise all failure modes deterministically.
//
// Task 4.1 RED tests:
//   - Valid response: { "version": "1.2.3" } → "1.2.3"
//   - Network failure: fetch rejects → null (does NOT throw)
//   - Malformed response: non-JSON or missing version field → null
//   - Empty response: {} → null
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLatestVersion } from "./registry.ts";

type FakeFetch = (url: string) => Promise<unknown>;

const createFakeFetch = (result: unknown): FakeFetch => {
  return vi.fn(async (_url: string) => {
    if (result instanceof Error) throw result;
    return result;
  }) as FakeFetch;
};

// ---------------------------------------------------------------------------
// Helper to inject a fake fetch into the module under test
// ---------------------------------------------------------------------------

const overrideFetchForRegistry = (fake: FakeFetch): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const urlStr = input instanceof URL ? input.href : String(input);
      const value = await fake(urlStr);
      return {
        ok: true,
        status: 200,
        json: async () => value,
      } as Response;
    },
  );
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = {
    HOME: process.env.HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  process.env.HOME = "/home/test";
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchLatestVersion", () => {
  // Task 4.1 RED: Valid response → version string
  it("returns the version string from a valid JSON response", async () => {
    overrideFetchForRegistry(createFakeFetch({ version: "1.2.3" }));
    const version = await fetchLatestVersion();
    expect(version).toBe("1.2.3");
  });

  // Task 4.1 RED: Valid response — semver with pre-release suffix
  it("returns the full version string including pre-release suffix", async () => {
    overrideFetchForRegistry(createFakeFetch({ version: "2.0.0-beta.1" }));
    const version = await fetchLatestVersion();
    expect(version).toBe("2.0.0-beta.1");
  });

  // Task 4.1 RED: Network failure — fetch rejects → null (does NOT throw)
  it("returns null when fetch rejects (network failure)", async () => {
    overrideFetchForRegistry(createFakeFetch(new Error("ENOTFOUND")));
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
    // Must NOT throw — null is the sentinel, not an exception
  });

  // Task 4.1 RED: Network failure — HTTP error status → null
  it("returns null when registry returns a non-OK HTTP status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        ({
          ok: false,
          status: 404,
        }) as Response,
    );
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
  });

  // Task 4.1 RED: Malformed response — non-JSON body → null
  it("returns null when response body is not valid JSON", async () => {
    overrideFetchForRegistry(
      createFakeFetch(Promise.resolve("Internal Server Error")),
    );
    // Patch json() to throw
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
        }) as unknown as Response,
    );
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
  });

  // Task 4.1 RED: Malformed response — missing version field → null
  it("returns null when JSON has no version field", async () => {
    overrideFetchForRegistry(createFakeFetch({ name: "opencode-code-review" }));
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
  });

  // Task 4.1 RED: Empty response: {} → null
  it("returns null when response body is an empty object", async () => {
    overrideFetchForRegistry(createFakeFetch({}));
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
  });

  // Task 4.1 RED: version field is null → null
  it("returns null when version field is explicitly null", async () => {
    overrideFetchForRegistry(createFakeFetch({ version: null }));
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
  });

  // Task 4.1 RED: version field is a number (not a string) → null
  it("returns null when version field is a number", async () => {
    overrideFetchForRegistry(createFakeFetch({ version: 1.23 }));
    const version = await fetchLatestVersion();
    expect(version).toBeNull();
  });
});
