import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultVaultConfig } from "../src/config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audio provider config", () => {
  it("includes audioProvider in default config tasks", () => {
    const config = defaultVaultConfig();
    expect(config.tasks).toHaveProperty("audioProvider");
  });
});
