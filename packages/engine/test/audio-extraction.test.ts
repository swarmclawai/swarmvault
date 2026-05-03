import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultVaultConfig } from "../src/config.js";
import { extractAudioTranscription, extractPublicVideoTranscription, extractVideoTranscription } from "../src/extraction.js";
import { createProvider } from "../src/index.js";
import { OpenAiCompatibleProviderAdapter } from "../src/providers/openai-compatible.js";
import * as registry from "../src/providers/registry.js";
import type { ProviderAdapter, ProviderConfig } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-video-extraction-"));
  tempDirs.push(dir);
  return dir;
}

async function makeFakeBinary(dir: string, name: string, script: string): Promise<string> {
  const binPath = path.join(dir, name);
  await fs.writeFile(binPath, `#!/usr/bin/env node\n${script}\n`, "utf8");
  await fs.chmod(binPath, 0o755);
  return binPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.SWARMVAULT_FFMPEG_BINARY;
  delete process.env.SWARMVAULT_YTDLP_BINARY;
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

  it("forwards corpusHint as Whisper prompt when provided", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ text: "hi" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProviderAdapter("test-audio", "openai", "whisper-1", {
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      apiStyle: "chat",
      capabilities: ["chat", "audio"]
    });

    await provider.transcribeAudio({
      mimeType: "audio/mpeg",
      bytes: Buffer.from("fake"),
      corpusHint: "This audio is likely about ClaimGraph, ApprovalBundle."
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const formData = init.body as FormData;
    expect(formData.get("prompt")).toBe("This audio is likely about ClaimGraph, ApprovalBundle.");
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

describe("video transcription extraction", () => {
  it("extracts local video audio with ffmpeg and routes it through the audio provider", async () => {
    const tmpDir = await makeTempDir();
    process.env.SWARMVAULT_FFMPEG_BINARY = await makeFakeBinary(
      tmpDir,
      "ffmpeg",
      "const fs = require('node:fs'); fs.writeFileSync(process.argv.at(-1), 'fake wav bytes');"
    );
    const mockProvider = {
      id: "mock-video-audio",
      type: "openai" as const,
      model: "whisper-1",
      capabilities: new Set(["audio"] as const),
      generateText: vi.fn(),
      generateStructured: vi.fn(),
      transcribeAudio: vi.fn().mockResolvedValue({
        text: "The architecture review discusses graph clusters.",
        duration: 9,
        language: "en"
      })
    };
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider as unknown as ProviderAdapter);

    const result = await extractVideoTranscription("/tmp/test-vault", {
      mimeType: "video/mp4",
      bytes: Buffer.from("fake video"),
      fileName: "review.mp4"
    });

    expect(result.extractedText).toContain("architecture review");
    expect(result.artifact.extractor).toBe("video_transcription");
    expect(result.artifact.sourceKind).toBe("video");
    expect(result.artifact.providerId).toBe("mock-video-audio");
    expect(mockProvider.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: "audio/wav",
        fileName: "review.wav"
      })
    );
  });

  it("downloads public video audio with yt-dlp when URL video mode is requested", async () => {
    const tmpDir = await makeTempDir();
    process.env.SWARMVAULT_YTDLP_BINARY = await makeFakeBinary(
      tmpDir,
      "yt-dlp",
      [
        "const fs = require('node:fs');",
        "const outIndex = process.argv.indexOf('-o') + 1;",
        "const template = process.argv[outIndex];",
        "fs.writeFileSync(template.replace('%(ext)s', 'wav'), 'downloaded wav');"
      ].join("\n")
    );
    const mockProvider = {
      id: "mock-public-video",
      type: "openai" as const,
      model: "whisper-1",
      capabilities: new Set(["audio"] as const),
      generateText: vi.fn(),
      generateStructured: vi.fn(),
      transcribeAudio: vi.fn().mockResolvedValue({
        text: "Public demo transcript.",
        language: "en"
      })
    };
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider as unknown as ProviderAdapter);

    const result = await extractPublicVideoTranscription("/tmp/test-vault", {
      url: "https://videos.example/demo"
    });

    expect(result.extractedText).toBe("Public demo transcript.");
    expect(result.artifact.extractor).toBe("video_transcription");
    expect(result.artifact.metadata?.url).toBe("https://videos.example/demo");
  });

  it("returns an explicit warning when the optional ffmpeg binary is unavailable", async () => {
    process.env.SWARMVAULT_FFMPEG_BINARY = path.join(os.tmpdir(), "missing-ffmpeg");

    const result = await extractVideoTranscription("/tmp/test-vault", {
      mimeType: "video/mp4",
      bytes: Buffer.from("fake video"),
      fileName: "missing.mp4"
    });

    expect(result.extractedText).toBeUndefined();
    expect(result.artifact.sourceKind).toBe("video");
    expect(result.artifact.warnings?.[0]).toContain("ffmpeg");
  });
});
