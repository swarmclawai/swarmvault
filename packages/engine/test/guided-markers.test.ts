import { describe, expect, it } from "vitest";
import { hasGuidedSourceMarkers } from "../src/markdown.js";

describe("guided source markers", () => {
  it("conservatively detects incomplete markers before obsolete page cleanup", () => {
    expect(hasGuidedSourceMarkers("<!-- swarmvault-guided-source:session:start -->")).toBe(true);
    expect(hasGuidedSourceMarkers("ordinary generated markdown")).toBe(false);
    expect(hasGuidedSourceMarkers(null)).toBe(false);
  });
});
