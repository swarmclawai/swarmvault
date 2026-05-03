import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestInputDetailed, initVault } from "../src/index.js";
import * as registry from "../src/providers/registry.js";
import type { ProviderAdapter } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-audio-redaction-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.SWARMVAULT_YTDLP_BINARY;
  vi.restoreAllMocks();
});

async function makeFakeBinary(dir: string, name: string, script: string): Promise<string> {
  const binPath = path.join(dir, name);
  await fs.writeFile(binPath, `#!/usr/bin/env node\n${script}\n`, "utf8");
  await fs.chmod(binPath, 0o755);
  return binPath;
}

/**
 * Minimal valid 16-bit mono 16kHz WAV with a short run of silence. The mock
 * provider never decodes it — the bytes exist only so the ingest pipeline
 * classifies the source as `audio/wav`.
 */
function buildSilentWav(seconds = 0.1): Buffer {
  const sampleRate = 16000;
  const bytesPerSample = 2;
  const dataSize = Math.max(2, Math.floor(seconds * sampleRate) * bytesPerSample);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

describe("audio transcription redaction", () => {
  it("scrubs secrets from the transcribed text before writing the extracted-text sidecar", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const secretLive = `sk_${"li"}ve_FIXTUREFIXTUREFIXTUREFIXTUREFIXTURE`;
    const transcribedText = `Ok so the key we rolled was ${secretLive} and the AKIAIOSFODNN7EXAMPLE profile.`;

    const mockProvider: ProviderAdapter = {
      id: "mock-audio",
      type: "openai",
      model: "whisper-mock",
      capabilities: new Set(["audio"]),
      generateText: vi.fn(),
      generateStructured: vi.fn(),
      transcribeAudio: vi.fn().mockResolvedValue({
        text: transcribedText,
        duration: 3.5,
        language: "en"
      })
    } as unknown as ProviderAdapter;
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider);

    const audioPath = path.join(rootDir, "memo.wav");
    await fs.writeFile(audioPath, buildSilentWav());

    const result = await ingestInputDetailed(rootDir, audioPath);
    const manifest = [...result.created, ...result.updated][0];
    expect(manifest).toBeDefined();
    expect(manifest.sourceKind).toBe("audio");
    expect(manifest.extractedTextPath).toBeDefined();

    const extractedPath = path.resolve(rootDir, manifest.extractedTextPath as string);
    const extracted = await fs.readFile(extractedPath, "utf8");
    expect(extracted).not.toContain(secretLive);
    expect(extracted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(extracted).toContain("[REDACTED]");

    expect(result.redactions).toBeDefined();
    const patternIds = (result.redactions ?? []).flatMap((entry) => entry.matches.map((match) => match.patternId));
    expect(patternIds).toContain("aws_access_key_id");
    expect(patternIds).toContain("stripe_live_key");
  });

  it("scrubs secrets from public video transcripts before writing raw and extract sidecars", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const binDir = await createTempWorkspace();
    process.env.SWARMVAULT_YTDLP_BINARY = await makeFakeBinary(
      binDir,
      "yt-dlp",
      [
        "const fs = require('node:fs');",
        "const outIndex = process.argv.indexOf('-o') + 1;",
        "const template = process.argv[outIndex];",
        "fs.writeFileSync(template.replace('%(ext)s', 'wav'), 'downloaded wav');"
      ].join("\n")
    );

    const secretLive = `sk_${"li"}ve_PUBLICVIDEOFIXTUREFIXTUREFIXTURE`;
    const mockProvider: ProviderAdapter = {
      id: "mock-public-video",
      type: "openai",
      model: "whisper-mock",
      capabilities: new Set(["audio"]),
      generateText: vi.fn(),
      generateStructured: vi.fn(),
      transcribeAudio: vi.fn().mockResolvedValue({
        text: `The public demo mentions ${secretLive} and AKIAIOSFODNN7EXAMPLE.`,
        language: "en"
      })
    } as unknown as ProviderAdapter;
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider);

    const result = await ingestInputDetailed(rootDir, "https://videos.example/demo", { video: true });
    const manifest = [...result.created, ...result.updated][0];
    expect(manifest).toBeDefined();
    expect(manifest.sourceKind).toBe("video");

    const rawContent = await fs.readFile(path.resolve(rootDir, manifest.storedPath), "utf8");
    expect(rawContent).not.toContain(secretLive);
    expect(rawContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(rawContent).toContain("[REDACTED]");

    const extractedContent = await fs.readFile(path.resolve(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedContent).not.toContain(secretLive);
    expect(extractedContent).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(extractedContent).toContain("[REDACTED]");
  });
});
