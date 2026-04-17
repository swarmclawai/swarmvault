import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProvider } from "../src/index.js";
import { LocalWhisperProviderAdapter } from "../src/providers/local-whisper.js";
import type { ProviderConfig } from "../src/types.js";

const originalEnv = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  CEREBRAS_API_KEY: process.env.CEREBRAS_API_KEY
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("provider registry", () => {
  it("creates named OpenAI-compatible provider presets with the expected defaults", async () => {
    process.env.OPENROUTER_API_KEY = "openrouter-test";
    process.env.GROQ_API_KEY = "groq-test";
    process.env.TOGETHER_API_KEY = "together-test";
    process.env.XAI_API_KEY = "xai-test";
    process.env.CEREBRAS_API_KEY = "cerebras-test";

    const rootDir = path.join(os.tmpdir(), "swarmvault-provider-registry");
    const cases: Array<{
      type: ProviderConfig["type"];
      expectedBaseUrl: string;
      expectedKey: string;
    }> = [
      { type: "openrouter", expectedBaseUrl: "https://openrouter.ai/api/v1", expectedKey: "openrouter-test" },
      { type: "groq", expectedBaseUrl: "https://api.groq.com/openai/v1", expectedKey: "groq-test" },
      { type: "together", expectedBaseUrl: "https://api.together.xyz/v1", expectedKey: "together-test" },
      { type: "xai", expectedBaseUrl: "https://api.x.ai/v1", expectedKey: "xai-test" },
      { type: "cerebras", expectedBaseUrl: "https://api.cerebras.ai/v1", expectedKey: "cerebras-test" }
    ];

    for (const testCase of cases) {
      const provider = await createProvider(
        testCase.type,
        {
          type: testCase.type,
          model: "test-model"
        },
        rootDir
      );
      expect(provider.type).toBe(testCase.type);
      expect(provider.capabilities.has("chat")).toBe(true);
      expect(provider.capabilities.has("structured")).toBe(true);
      expect(provider.capabilities.has("embeddings")).toBe(true);
      expect((provider as { baseUrl?: string }).baseUrl).toBe(testCase.expectedBaseUrl);
      expect((provider as { apiKey?: string }).apiKey).toBe(testCase.expectedKey);
      expect((provider as { apiStyle?: string }).apiStyle).toBe("chat");
    }
  });

  it("creates a LocalWhisperProviderAdapter for type local-whisper with audio-only capabilities", async () => {
    const rootDir = path.join(os.tmpdir(), "swarmvault-provider-registry-whisper");
    const provider = await createProvider(
      "local-whisper",
      {
        type: "local-whisper",
        model: "base.en",
        binaryPath: "/usr/local/bin/whisper-cli",
        modelPath: "/tmp/ggml-base.en.bin",
        threads: 8,
        extraArgs: ["--no-fallback"]
      },
      rootDir
    );
    expect(provider).toBeInstanceOf(LocalWhisperProviderAdapter);
    expect(provider.type).toBe("local-whisper");
    expect(provider.model).toBe("base.en");
    expect(provider.capabilities.has("audio")).toBe(true);
    expect(provider.capabilities.has("local")).toBe(true);
    expect(provider.capabilities.has("chat")).toBe(false);
    expect(provider.capabilities.has("structured")).toBe(false);
    expect(provider.capabilities.has("embeddings")).toBe(false);
  });
});
