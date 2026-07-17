import { describe, expect, it } from "vitest";
// @ts-expect-error - the rolldown config is plain JS.
import config from "../rolldown.config.js";

describe("rolldown config", () => {
  it("keeps jsonc-parser external", () => {
    expect(config.external).toContain("jsonc-parser");
  });
});
