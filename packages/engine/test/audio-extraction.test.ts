import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultVaultConfig } from "../src/config.js";
import { extractAudioTranscription } from "../src/extraction.js";
import { createProvider } from "../src/index.js";
import { OpenAiCompatibleProviderAdapter } from "../src/providers/openai-compatible.js";
import * as registry from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderConfig } from "../src/types.js";

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
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
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

describe("extractAudioTranscription", () => {
  it("returns transcript text and artifact when provider is available", async () => {
    const mockProvider = {
      id: "mock-audio",
      type: "openai" as const,
      model: "whisper-1",
      capabilities: new Set(["audio", "chat", "structured"] as const),
      generateText: vi.fn(),
      generateStructured: vi.fn(),
      transcribeAudio: vi.fn().mockResolvedValue({
        text: "The quick brown fox jumps over the lazy dog.",
        duration: 5.2,
        language: "en"
      })
    };
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider as unknown as ProviderAdapter);

    const result = await extractAudioTranscription("/tmp/test-vault", {
      mimeType: "audio/mpeg",
      bytes: Buffer.from("fake-audio"),
      fileName: "test.mp3"
    });

    expect(result.extractedText).toBe("The quick brown fox jumps over the lazy dog.");
    expect(result.artifact.extractor).toBe("audio_transcription");
    expect(result.artifact.sourceKind).toBe("audio");
    expect(result.artifact.providerId).toBe("mock-audio");
    expect(result.artifact.providerModel).toBe("whisper-1");
    expect(result.artifact.metadata?.duration).toBe("5.2");
    expect(result.artifact.metadata?.language).toBe("en");
  });

  it("returns warning artifact when no audio provider is configured", async () => {
    vi.spyOn(registry, "getProviderForTask").mockRejectedValue(new Error('No provider configured for task "audioProvider".'));

    const result = await extractAudioTranscription("/tmp/test-vault", {
      mimeType: "audio/wav",
      bytes: Buffer.from("fake-audio")
    });

    expect(result.extractedText).toBeUndefined();
    expect(result.artifact.warnings).toBeDefined();
    expect(result.artifact.warnings![0]).toContain("unavailable");
  });

  it("returns warning artifact when provider lacks audio capability", async () => {
    const mockProvider = {
      id: "no-audio",
      type: "heuristic" as const,
      model: "heuristic-v1",
      capabilities: new Set(["chat", "structured"] as const),
      generateText: vi.fn(),
      generateStructured: vi.fn()
    };
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider as unknown as ProviderAdapter);

    const result = await extractAudioTranscription("/tmp/test-vault", {
      mimeType: "audio/mpeg",
      bytes: Buffer.from("fake-audio")
    });

    expect(result.extractedText).toBeUndefined();
    expect(result.artifact.warnings![0]).toContain("unavailable");
  });
});
