import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultVaultConfig } from "../src/config.js";
import { createProvider } from "../src/index.js";
import { OpenAiCompatibleProviderAdapter } from "../src/providers/openai-compatible.js";
import type { ProviderConfig } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audio provider config", () => {
  it("includes audioProvider in default config tasks", () => {
    const config = defaultVaultConfig();
    expect(config.tasks).toHaveProperty("audioProvider");
  });
});

describe("OpenAiCompatibleProviderAdapter.transcribeAudio", () => {
  it("sends multipart POST to /audio/transcriptions and returns transcript", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            text: "Hello, this is a test transcript.",
            duration: 12.5,
            language: "en"
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProviderAdapter("test-audio", "openai", "whisper-1", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      apiStyle: "chat",
      capabilities: ["chat", "audio"]
    });

    const result = await provider.transcribeAudio({
      mimeType: "audio/mpeg",
      bytes: Buffer.from("fake-audio-bytes"),
      fileName: "recording.mp3"
    });

    expect(result.text).toBe("Hello, this is a test transcript.");
    expect(result.duration).toBe(12.5);
    expect(result.language).toBe("en");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);

    const formData = init.body as FormData;
    expect(formData.get("model")).toBe("whisper-1");
    expect(formData.get("response_format")).toBe("verbose_json");
    expect(formData.get("file")).toBeInstanceOf(File);
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }))
    );

    const provider = new OpenAiCompatibleProviderAdapter("test-audio", "openai", "whisper-1", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "bad-key",
      apiStyle: "chat",
      capabilities: ["chat", "audio"]
    });

    await expect(
      provider.transcribeAudio({
        mimeType: "audio/mpeg",
        bytes: Buffer.from("fake-audio-bytes")
      })
    ).rejects.toThrow(/401/);
  });
});

describe("provider audio capability", () => {
  const rootDir = path.join(os.tmpdir(), "swarmvault-audio-cap-test");

  it("openai provider includes audio capability by default", async () => {
    const provider = await createProvider("test", { type: "openai", model: "whisper-1" } as ProviderConfig, rootDir);
    expect(provider.capabilities.has("audio")).toBe(true);
  });

  it("groq provider includes audio capability by default", async () => {
    process.env.GROQ_API_KEY = "test";
    const provider = await createProvider("test", { type: "groq", model: "whisper-large-v3" } as ProviderConfig, rootDir);
    expect(provider.capabilities.has("audio")).toBe(true);
    delete process.env.GROQ_API_KEY;
  });

  it("anthropic provider does not include audio capability", async () => {
    const provider = await createProvider("test", { type: "anthropic", model: "claude-sonnet-4-20250514" } as ProviderConfig, rootDir);
    expect(provider.capabilities.has("audio")).toBe(false);
  });
});
