import { describe, expect, it } from "vitest";
import { semanticSlug, slugify } from "../src/utils.js";

describe("semanticSlug", () => {
  it("preserves the existing slug for ASCII names", () => {
    for (const value of ["Knowledge Graphs", "C++", "---", "Mixed_CASE 123", "a".repeat(100)]) {
      expect(semanticSlug(value)).toBe(slugify(value));
    }
  });

  it("creates stable, distinct ASCII-safe ids for CJK names", () => {
    expect(semanticSlug("毫毛分身术")).toBe("u-ab81bb62e240263350eccd9c5a5aa3740fbf551b331999e81b5935d9657bac48");
    expect(semanticSlug("毫毛分身术")).not.toBe(semanticSlug("筋斗云"));
    expect(semanticSlug("孙悟空 Monkey King")).not.toBe(semanticSlug("猪八戒 Monkey King"));
    expect(semanticSlug("毫毛分身术")).toMatch(/^[a-z0-9-]+$/);
    expect(semanticSlug("毫毛分身术").length).toBeLessThanOrEqual(80);
  });

  it("normalizes Unicode compatibility forms before deriving identity", () => {
    expect(semanticSlug("Cafe\u0301")).toBe(semanticSlug("Café"));
    expect(semanticSlug("ＡＩ")).toBe(semanticSlug("AI"));
  });
});
