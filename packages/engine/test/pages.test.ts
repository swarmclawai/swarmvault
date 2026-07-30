import { describe, expect, it } from "vitest";
import { normalizeStringArray } from "../src/pages.js";

describe("normalizeStringArray", () => {
  it("filters non-strings and dedupes while preserving first-seen order", () => {
    expect(normalizeStringArray(["alpha", "beta", "alpha", 1, null, "beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
  });
});
