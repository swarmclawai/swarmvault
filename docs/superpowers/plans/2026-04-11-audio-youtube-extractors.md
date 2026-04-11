# Audio & YouTube Extractors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add audio transcription and YouTube transcript extractors to SwarmVault's ingestion pipeline.

**Architecture:** Two new `SourceKind` values (`audio`, `youtube`) with independent extraction paths. Audio routes through the existing provider system via `/v1/audio/transcriptions` (OpenAI-compatible). YouTube uses `youtube-transcript-plus` to fetch captions without a provider. Both follow the established extractor pattern: add types, add detection, add extract function, wire dispatch.

**Tech Stack:** TypeScript, vitest, `youtube-transcript-plus` (npm)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/engine/src/types.ts` | Add `SourceKind`, `ExtractionKind`, `ProviderCapability`, and audio transcription types to `ProviderAdapter` |
| `packages/engine/src/config.ts` | Add `audioProvider` to tasks schema and defaults |
| `packages/engine/src/extraction.ts` | `extractAudioTranscription()` and `extractYoutubeTranscript()` functions |
| `packages/engine/src/ingest.ts` | Audio detection in `inferKind()`, YouTube URL detection in `prepareUrlInputs()`, dispatch blocks in both file and URL handlers |
| `packages/engine/src/providers/base.ts` | Default `transcribeAudio()` stub on base adapter |
| `packages/engine/src/providers/openai-compatible.ts` | `transcribeAudio()` implementation via `/v1/audio/transcriptions` |
| `packages/engine/package.json` | Add `youtube-transcript-plus` dependency |
| `packages/engine/test/audio-extraction.test.ts` | Audio extractor + provider tests |
| `packages/engine/test/youtube-extraction.test.ts` | YouTube extractor tests |

---

### Task 1: Add type definitions

**Files:**
- Modify: `packages/engine/src/types.ts:3-13` (ProviderCapability)
- Modify: `packages/engine/src/types.ts:68-93` (SourceKind)
- Modify: `packages/engine/src/types.ts:331-353` (ExtractionKind)
- Modify: `packages/engine/src/types.ts:171-180` (ProviderAdapter)

- [ ] **Step 1: Add `"audio"` to ProviderCapability**

In `types.ts`, add `"audio"` to the `providerCapabilitySchema` enum (line 3-13):

```typescript
export const providerCapabilitySchema = z.enum([
  "responses",
  "chat",
  "structured",
  "tools",
  "vision",
  "embeddings",
  "streaming",
  "local",
  "image_generation",
  "audio"
]);
```

- [ ] **Step 2: Add `"audio"` and `"youtube"` to SourceKind**

In `types.ts`, add to the `SourceKind` union (after line 92, before `"code"`):

```typescript
export type SourceKind =
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "html"
  | "docx"
  | "epub"
  | "csv"
  | "xlsx"
  | "pptx"
  | "odt"
  | "odp"
  | "ods"
  | "jupyter"
  | "data"
  | "bibtex"
  | "rtf"
  | "org"
  | "asciidoc"
  | "transcript"
  | "chat_export"
  | "email"
  | "calendar"
  | "audio"
  | "youtube"
  | "binary"
  | "code";
```

- [ ] **Step 3: Add `"audio_transcription"` and `"youtube_transcript"` to ExtractionKind**

In `types.ts`, add to `ExtractionKind` (after `"image_vision"`, line 353):

```typescript
export type ExtractionKind =
  | "plain_text"
  | "html_readability"
  | "pdf_text"
  | "docx_text"
  | "epub_text"
  | "csv_text"
  | "xlsx_text"
  | "pptx_text"
  | "odt_text"
  | "odp_text"
  | "ods_text"
  | "jupyter_text"
  | "structured_data"
  | "bibtex_text"
  | "rtf_text"
  | "org_text"
  | "asciidoc_text"
  | "transcript_text"
  | "chat_export_text"
  | "email_text"
  | "calendar_text"
  | "image_vision"
  | "audio_transcription"
  | "youtube_transcript";
```

- [ ] **Step 4: Add audio transcription types and `transcribeAudio` to ProviderAdapter**

In `types.ts`, add after the `ImageGenerationResponse` interface (after line 169), before `ProviderAdapter`:

```typescript
export interface AudioTranscriptionRequest {
  mimeType: string;
  bytes: Buffer;
  fileName?: string;
  language?: string;
}

export interface AudioTranscriptionResponse {
  text: string;
  duration?: number;
  language?: string;
}
```

Then add `transcribeAudio` to the `ProviderAdapter` interface (line 171-180):

```typescript
export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  readonly model: string;
  readonly capabilities: Set<ProviderCapability>;
  generateText(request: GenerationRequest): Promise<GenerationResponse>;
  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T>;
  embedTexts?(texts: string[]): Promise<number[][]>;
  generateImage?(request: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  transcribeAudio?(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse>;
}
```

- [ ] **Step 5: Verify types compile**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec tsc --noEmit -p packages/engine/tsconfig.json`
Expected: No type errors (only adding new union members and an optional method).

- [ ] **Step 6: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/types.ts
git commit -m "Add audio and youtube type definitions to engine"
```

---

### Task 2: Add `audioProvider` to config

**Files:**
- Modify: `packages/engine/src/config.ts:145-152` (tasks schema)
- Modify: `packages/engine/src/config.ts:325-331` (default config)

- [ ] **Step 1: Write test for audioProvider config**

Create `packages/engine/test/audio-extraction.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { defaultVaultConfig } from "../src/config.js";

describe("audio provider config", () => {
  it("includes audioProvider in default config tasks", () => {
    const config = defaultVaultConfig();
    expect(config.tasks).toHaveProperty("audioProvider");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: FAIL — `audioProvider` not in tasks.

- [ ] **Step 3: Add `audioProvider` to tasks schema**

In `config.ts`, add `audioProvider` to the tasks schema (line 145-152):

```typescript
  tasks: z.object({
    compileProvider: z.string().min(1),
    queryProvider: z.string().min(1),
    lintProvider: z.string().min(1),
    visionProvider: z.string().min(1),
    imageProvider: z.string().min(1).optional(),
    embeddingProvider: z.string().min(1).optional(),
    audioProvider: z.string().min(1).optional()
  }),
```

- [ ] **Step 4: Add audioProvider to default config**

In `config.ts`, in the `defaultVaultConfig()` function, add to the tasks object (line 325-331). Since it's optional and the default heuristic provider doesn't support audio, leave it undefined:

```typescript
    tasks: {
      compileProvider: "local",
      queryProvider: "local",
      lintProvider: "local",
      visionProvider: "local",
      imageProvider: "local",
      audioProvider: undefined
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/config.ts packages/engine/test/audio-extraction.test.ts
git commit -m "Add audioProvider to vault config tasks schema"
```

---

### Task 3: Implement `transcribeAudio` on providers

**Files:**
- Modify: `packages/engine/src/providers/base.ts:29-35`
- Modify: `packages/engine/src/providers/openai-compatible.ts:141-262`
- Modify: `packages/engine/test/audio-extraction.test.ts`

- [ ] **Step 1: Write test for OpenAI-compatible audio transcription**

Add to `packages/engine/test/audio-extraction.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultVaultConfig } from "../src/config.js";
import { OpenAiCompatibleProviderAdapter } from "../src/providers/openai-compatible.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: FAIL — `transcribeAudio` is not a function.

- [ ] **Step 3: Add default `transcribeAudio` stub to BaseProviderAdapter**

In `base.ts`, add the import and default stub method (after `generateImage`, line 33-35):

First add the import:
```typescript
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResponse,
  GenerationAttachment,
  GenerationRequest,
  GenerationResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProviderAdapter,
  ProviderCapability,
  ProviderType
} from "../types.js";
```

Then add the method:
```typescript
  public async transcribeAudio(_request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse> {
    throw new Error(`Provider ${this.id} does not support audio transcription.`);
  }
```

- [ ] **Step 4: Implement `transcribeAudio` on OpenAiCompatibleProviderAdapter**

In `openai-compatible.ts`, add the import for the new types:

```typescript
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResponse,
  GenerationRequest,
  GenerationResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProviderCapability,
  ProviderType
} from "../types.js";
```

Then add the method to the `OpenAiCompatibleProviderAdapter` class (after `generateImage`, before the private methods):

```typescript
  public async transcribeAudio(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse> {
    const extension = request.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
    const fileName = request.fileName ?? `audio.${extension}`;

    const formData = new FormData();
    formData.append("file", new File([request.bytes], path.basename(fileName), { type: request.mimeType }));
    formData.append("model", this.model);
    formData.append("response_format", "verbose_json");
    if (request.language) {
      formData.append("language", request.language);
    }

    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        ...buildAuthHeaders(this.apiKey),
        ...this.headers
      },
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Provider ${this.id} audio transcription failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      text?: string;
      duration?: number;
      language?: string;
    };

    return {
      text: payload.text ?? "",
      duration: payload.duration,
      language: payload.language
    };
  }
```

Add `import path from "node:path";` at the top of `openai-compatible.ts` if not already present.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: All 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/providers/base.ts packages/engine/src/providers/openai-compatible.ts packages/engine/test/audio-extraction.test.ts
git commit -m "Implement transcribeAudio on OpenAI-compatible provider"
```

---

### Task 4: Add `"audio"` capability to provider presets

**Files:**
- Modify: `packages/engine/src/providers/registry.ts:46-150`

- [ ] **Step 1: Write test for audio capability on presets**

Add to `packages/engine/test/audio-extraction.test.ts`:

```typescript
import { createProvider } from "../src/index.js";
import type { ProviderConfig } from "../src/types.js";
import os from "node:os";
import path from "node:path";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: FAIL — `audio` not in capabilities.

- [ ] **Step 3: Add `"audio"` to provider default capabilities**

In `registry.ts`, add `"audio"` to the default capabilities for providers that support the `/v1/audio/transcriptions` endpoint:

**OpenAI** (line 56-65): Add `"audio"` to the capabilities array:
```typescript
        capabilities: resolveCapabilities(config, [
          "responses",
          "chat",
          "structured",
          "tools",
          "vision",
          "embeddings",
          "streaming",
          "image_generation",
          "audio"
        ])
```

**Ollama** (line 73-82): Add `"audio"`:
```typescript
        capabilities: resolveCapabilities(config, [
          "responses",
          "chat",
          "structured",
          "tools",
          "vision",
          "embeddings",
          "streaming",
          "local",
          "audio"
        ])
```

**Groq** (line 99-105): Add `"audio"`:
```typescript
      capabilities: ["chat", "structured", "embeddings", "audio"]
```

**openai-compatible** (line 84-91): Add `"audio"`:
```typescript
        capabilities: resolveCapabilities(config, ["chat", "structured", "embeddings", "audio"])
```

Leave Anthropic, Gemini, OpenRouter, Together, xAI, and Cerebras **without** `"audio"` — they don't support this endpoint (users can override with explicit `capabilities` in config if a provider adds support later).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/providers/registry.ts packages/engine/test/audio-extraction.test.ts
git commit -m "Add audio capability to OpenAI, Ollama, and Groq provider presets"
```

---

### Task 5: Implement `extractAudioTranscription()`

**Files:**
- Modify: `packages/engine/src/extraction.ts:1-14` (imports)
- Modify: `packages/engine/src/extraction.ts` (new function after `extractImageWithVision`)
- Modify: `packages/engine/test/audio-extraction.test.ts`

- [ ] **Step 1: Write test for extractAudioTranscription**

Add to `packages/engine/test/audio-extraction.test.ts`:

```typescript
import { extractAudioTranscription } from "../src/extraction.js";
import * as registry from "../src/providers/registry.js";

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
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider as any);

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
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider as any);

    const result = await extractAudioTranscription("/tmp/test-vault", {
      mimeType: "audio/mpeg",
      bytes: Buffer.from("fake-audio")
    });

    expect(result.extractedText).toBeUndefined();
    expect(result.artifact.warnings![0]).toContain("unavailable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: FAIL — `extractAudioTranscription` not exported.

- [ ] **Step 3: Implement `extractAudioTranscription` in extraction.ts**

Add to `extraction.ts`, after the `extractImageWithVision` function (after line 214):

```typescript
export async function extractAudioTranscription(
  rootDir: string,
  input: { mimeType: string; bytes: Buffer; fileName?: string }
): Promise<{ extractedText?: string; artifact: SourceExtractionArtifact }> {
  let provider: ProviderAdapter;
  try {
    provider = await getProviderForTask(rootDir, "audioProvider");
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("audio", input.mimeType, "audio_transcription"),
        warnings: [`Audio transcription unavailable: ${error instanceof Error ? error.message : "provider not configured"}`]
      }
    };
  }

  if (!provider.capabilities.has("audio") || !provider.transcribeAudio) {
    return {
      artifact: {
        ...extractionMetadata("audio", input.mimeType, "audio_transcription"),
        warnings: [`Audio transcription unavailable for provider ${provider.id}. Configure a provider with audio capability.`]
      }
    };
  }

  try {
    const result = await provider.transcribeAudio({
      mimeType: input.mimeType,
      bytes: input.bytes,
      fileName: input.fileName
    });

    const metadata: Record<string, string> = {};
    if (result.duration !== undefined) {
      metadata.duration = String(result.duration);
    }
    if (result.language) {
      metadata.language = result.language;
    }

    return {
      extractedText: result.text || undefined,
      artifact: {
        ...extractionMetadata("audio", input.mimeType, "audio_transcription"),
        providerId: provider.id,
        providerModel: provider.model,
        metadata: Object.keys(metadata).length ? metadata : undefined
      }
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("audio", input.mimeType, "audio_transcription"),
        providerId: provider.id,
        providerModel: provider.model,
        warnings: [`Audio transcription failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/audio-extraction.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/extraction.ts packages/engine/test/audio-extraction.test.ts
git commit -m "Implement extractAudioTranscription with provider-based transcription"
```

---

### Task 6: Wire audio into ingest pipeline

**Files:**
- Modify: `packages/engine/src/ingest.ts:159-277` (inferKind)
- Modify: `packages/engine/src/ingest.ts:2500-2510` (file dispatch)
- Modify: `packages/engine/src/ingest.ts:2771-2780` (URL dispatch)
- Modify: `packages/engine/src/ingest.ts:1955-1971` (shouldDeferWatchSemanticRefresh)
- Modify: `packages/engine/src/ingest.ts:21-39` (imports)

- [ ] **Step 1: Add audio import to ingest.ts**

In `ingest.ts`, add `extractAudioTranscription` to the import from `extraction.js` (around line 21-39):

```typescript
  extractAudioTranscription,
```

- [ ] **Step 2: Add audio detection to `inferKind()`**

In `ingest.ts`, add audio detection after the image check (line 273-275) and before the `return "binary"` fallback (line 276). Insert before the image check to ensure audio MIME types aren't caught by the image branch:

```typescript
  if (
    mimeType.startsWith("audio/") ||
    /\.(mp3|wav|m4a|ogg|flac|webm|aac|wma)$/i.test(filePath)
  ) {
    return "audio";
  }
```

Place this block **before** the `image` check (line 273), since `audio/` and `image/` MIME prefixes don't overlap, but `.webm` files with `video/webm` MIME could be ambiguous. The extension check `.webm` here is acceptable since audio `.webm` files are common and video ones will typically have a `video/` MIME type which won't match `audio/`.

- [ ] **Step 3: Add audio dispatch to `prepareFileInputs()` file handler**

In `ingest.ts`, add an `else if` block for audio in the file handler dispatch chain, after the `image` block (after line 2509) and before the `else` fallback (line 2510):

```typescript
  } else if (sourceKind === "audio") {
    title = path.basename(absoluteInput, path.extname(absoluteInput));
    const extracted = await extractAudioTranscription(rootDir, {
      mimeType,
      bytes: payloadBytes,
      fileName: absoluteInput
    });
    extractedText = extracted.extractedText;
    extractionArtifact = extracted.artifact;
  } else {
```

- [ ] **Step 4: Add audio dispatch to `prepareUrlInputs()` URL handler**

In `ingest.ts`, add an `else if` block for audio in the URL handler dispatch chain, after the `image` block (after line 2779) and before the closing `}` (line 2780):

```typescript
    } else if (sourceKind === "audio") {
      const extracted = await extractAudioTranscription(rootDir, {
        mimeType,
        bytes: payloadBytes,
        fileName: inputUrl.pathname
      });
      extractedText = extracted.extractedText;
      extractionArtifact = extracted.artifact;
    }
```

- [ ] **Step 5: Add `"audio"` to `shouldDeferWatchSemanticRefresh`**

In `ingest.ts`, add `"audio"` to the `shouldDeferWatchSemanticRefresh` function (line 1955-1971):

```typescript
    sourceKind === "image" ||
    sourceKind === "audio"
```

- [ ] **Step 6: Verify compilation**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec tsc --noEmit -p packages/engine/tsconfig.json`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/ingest.ts
git commit -m "Wire audio extraction into ingest pipeline with format detection"
```

---

### Task 7: Install `youtube-transcript-plus` dependency

**Files:**
- Modify: `packages/engine/package.json`

- [ ] **Step 1: Install the dependency**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm add youtube-transcript-plus --filter @swarmvaultai/engine`
Expected: Package added to `packages/engine/package.json` dependencies.

- [ ] **Step 2: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/package.json pnpm-lock.yaml
git commit -m "Add youtube-transcript-plus dependency for YouTube extraction"
```

---

### Task 8: Implement `extractYoutubeTranscript()`

**Files:**
- Create: `packages/engine/test/youtube-extraction.test.ts`
- Modify: `packages/engine/src/extraction.ts`

- [ ] **Step 1: Write test for extractYoutubeTranscript**

Create `packages/engine/test/youtube-extraction.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock youtube-transcript-plus before importing extraction
vi.mock("youtube-transcript-plus", () => ({
  fetchTranscript: vi.fn()
}));

import { extractYoutubeTranscript } from "../src/extraction.js";
import { fetchTranscript } from "youtube-transcript-plus";

const mockFetchTranscript = vi.mocked(fetchTranscript);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractYoutubeTranscript", () => {
  it("returns formatted markdown with transcript and metadata", async () => {
    mockFetchTranscript.mockResolvedValue({
      transcript: [
        { text: "Hello world.", offset: 0, duration: 2000 },
        { text: "This is a test.", offset: 2000, duration: 3000 }
      ],
      videoDetails: {
        title: "Test Video",
        author: "Test Author",
        lengthSeconds: "300",
        viewCount: "1000"
      }
    } as any);

    const result = await extractYoutubeTranscript({
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    });

    expect(result.title).toBe("Test Video");
    expect(result.extractedText).toContain("# Test Video");
    expect(result.extractedText).toContain("Test Author");
    expect(result.extractedText).toContain("Hello world.");
    expect(result.extractedText).toContain("This is a test.");
    expect(result.artifact.extractor).toBe("youtube_transcript");
    expect(result.artifact.sourceKind).toBe("youtube");
    expect(result.artifact.metadata?.author).toBe("Test Author");
  });

  it("returns warning when transcript fetch fails", async () => {
    mockFetchTranscript.mockRejectedValue(new Error("Subtitles are disabled for this video"));

    const result = await extractYoutubeTranscript({
      videoId: "invalid123",
      url: "https://www.youtube.com/watch?v=invalid123"
    });

    expect(result.extractedText).toBeUndefined();
    expect(result.artifact.warnings).toBeDefined();
    expect(result.artifact.warnings![0]).toContain("disabled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/youtube-extraction.test.ts`
Expected: FAIL — `extractYoutubeTranscript` not exported.

- [ ] **Step 3: Implement `extractYoutubeTranscript` in extraction.ts**

Add the import at the top of `extraction.ts`:

```typescript
import { fetchTranscript } from "youtube-transcript-plus";
```

Add the function after `extractAudioTranscription`:

```typescript
export async function extractYoutubeTranscript(input: {
  videoId: string;
  url: string;
}): Promise<{ title?: string; extractedText?: string; artifact: SourceExtractionArtifact }> {
  try {
    const result = await fetchTranscript(input.videoId, { videoDetails: true });

    const details = result.videoDetails;
    const title = details?.title ?? `YouTube ${input.videoId}`;
    const transcriptText = result.transcript?.map((part: { text: string }) => part.text).join(" ") ?? "";

    const sections: string[] = [`# ${title}`];

    const metaLines: string[] = [];
    if (details?.author) metaLines.push(`**Author:** ${details.author}`);
    if (details?.lengthSeconds) {
      const seconds = parseInt(details.lengthSeconds, 10);
      if (!isNaN(seconds)) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        metaLines.push(`**Duration:** ${minutes}:${String(secs).padStart(2, "0")}`);
      }
    }
    if (details?.viewCount) metaLines.push(`**Views:** ${Number(details.viewCount).toLocaleString()}`);
    metaLines.push(`**URL:** ${input.url}`);

    if (metaLines.length) {
      sections.push(metaLines.join("\n"));
    }

    if (transcriptText.trim()) {
      sections.push(`## Transcript\n\n${transcriptText.trim()}`);
    }

    const extractedText = sections.join("\n\n");

    const metadata: Record<string, string> = {};
    if (details?.title) metadata.title = details.title;
    if (details?.author) metadata.author = details.author;
    if (details?.lengthSeconds) metadata.duration = details.lengthSeconds;
    if (details?.viewCount) metadata.viewCount = details.viewCount;

    return {
      title,
      extractedText: extractedText || undefined,
      artifact: {
        ...extractionMetadata("youtube", "text/html", "youtube_transcript"),
        metadata: Object.keys(metadata).length ? metadata : undefined
      }
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("youtube", "text/html", "youtube_transcript"),
        warnings: [`YouTube transcript extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/youtube-extraction.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/extraction.ts packages/engine/test/youtube-extraction.test.ts
git commit -m "Implement extractYoutubeTranscript with metadata and caption fetching"
```

---

### Task 9: Wire YouTube into ingest pipeline

**Files:**
- Modify: `packages/engine/src/ingest.ts:2547-2582` (prepareUrlInputs — YouTube URL detection)
- Modify: `packages/engine/src/ingest.ts` (imports)

- [ ] **Step 1: Add YouTube helper function and import to ingest.ts**

Add `extractYoutubeTranscript` to the import from `extraction.js`:

```typescript
  extractYoutubeTranscript,
```

Add the YouTube URL parser function near the top of `ingest.ts` (after the existing helper functions like `isImagePath`, around line 297):

```typescript
const YOUTUBE_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/i
];

function parseYoutubeVideoId(url: string): string | undefined {
  for (const pattern of YOUTUBE_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Add YouTube detection at the top of `prepareUrlInputs()`**

In `ingest.ts`, in `prepareUrlInputs()`, add YouTube detection **before** the `fetch()` call (after `validateUrlSafety` at line 2548, before line 2549):

```typescript
  const youtubeVideoId = parseYoutubeVideoId(input);
  if (youtubeVideoId) {
    const extracted = await extractYoutubeTranscript({ videoId: youtubeVideoId, url: input });
    const title = extracted.title ?? `YouTube ${youtubeVideoId}`;
    const extractedText = extracted.extractedText;
    const payloadBytes = Buffer.from(extractedText ?? "", "utf8");

    return [
      finalizePreparedInput({
        title,
        originType: "url",
        sourceKind: "youtube",
        url: normalizeOriginUrl(input),
        mimeType: "text/html",
        storedExtension: ".md",
        payloadBytes,
        extractedText,
        extractionArtifact: extracted.artifact,
        extractionHash: buildExtractionHash(extractedText, extracted.artifact),
        details: extracted.artifact.metadata
      })
    ];
  }
```

This short-circuits the URL handler for YouTube — no HTTP fetch needed since `youtube-transcript-plus` fetches its own data.

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec tsc --noEmit -p packages/engine/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Run the full test suite**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/`
Expected: All tests PASS including existing tests (no regressions).

- [ ] **Step 5: Commit**

```bash
cd /Users/wayde/Dev/swarmvault/opensource
git add packages/engine/src/ingest.ts
git commit -m "Wire YouTube transcript extraction into URL ingest pipeline"
```

---

### Task 10: Verify end-to-end

- [ ] **Step 1: Run full type check**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec tsc --noEmit -p packages/engine/tsconfig.json`
Expected: No errors.

- [ ] **Step 2: Run all engine tests**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm exec vitest run packages/engine/test/`
Expected: All tests PASS.

- [ ] **Step 3: Run lint**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && pnpm check`
Expected: No lint errors on changed files.

- [ ] **Step 4: Verify exports**

Run: `cd /Users/wayde/Dev/swarmvault/opensource && node -e "import('@swarmvaultai/engine').then(m => { console.log('extractAudioTranscription:', typeof m.extractAudioTranscription); console.log('extractYoutubeTranscript:', typeof m.extractYoutubeTranscript); })"`
Expected: Both functions exported as `function`.
