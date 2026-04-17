import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverLocalWhisperBinary,
  expectedModelPath,
  ingestInputDetailed,
  initVault,
  LocalWhisperProviderAdapter,
  registerLocalWhisperProvider
} from "../src/index.js";

/**
 * Integration coverage for the local-whisper audio path. Skips cleanly when the
 * developer machine does not have whisper.cpp on $PATH or the base.en model
 * downloaded — CI lanes without these prerequisites stay green while machines
 * that can actually run it exercise the real pipeline.
 */

async function probeIntegrationPrereqs(): Promise<{ binaryPath: string; modelPath: string } | null> {
  const discovery = await discoverLocalWhisperBinary();
  if (!discovery.binaryPath) return null;
  const modelPath = expectedModelPath("base.en");
  try {
    await fs.access(modelPath);
  } catch {
    return null;
  }
  return { binaryPath: discovery.binaryPath, modelPath };
}

function buildSilentWav(options: { seconds?: number; sampleRate?: number } = {}): Buffer {
  const seconds = options.seconds ?? 1;
  const sampleRate = options.sampleRate ?? 16000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = Math.floor(seconds * sampleRate) * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  let offset = 0;
  buffer.write("RIFF", offset);
  offset += 4;
  buffer.writeUInt32LE(36 + dataSize, offset);
  offset += 4;
  buffer.write("WAVE", offset);
  offset += 4;
  buffer.write("fmt ", offset);
  offset += 4;
  buffer.writeUInt32LE(16, offset);
  offset += 4;
  buffer.writeUInt16LE(1, offset);
  offset += 2;
  buffer.writeUInt16LE(numChannels, offset);
  offset += 2;
  buffer.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buffer.writeUInt32LE(byteRate, offset);
  offset += 4;
  buffer.writeUInt16LE(blockAlign, offset);
  offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset);
  offset += 2;
  buffer.write("data", offset);
  offset += 4;
  buffer.writeUInt32LE(dataSize, offset);
  // remaining bytes are already zero-filled (silence)
  return buffer;
}

const prereqs = await probeIntegrationPrereqs();
const runIntegration = prereqs !== null;

describe.skipIf(!runIntegration)("LocalWhisperProviderAdapter integration", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-whisper-int-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("transcribes a synthetic silent WAV without throwing and returns a defined text field", async () => {
    // prereqs are non-null inside this branch (describe.skipIf)
    const { binaryPath, modelPath } = prereqs as { binaryPath: string; modelPath: string };
    const adapter = new LocalWhisperProviderAdapter("local-whisper", "base.en", {
      binaryPath,
      modelPath,
      threads: 2
    });

    const result = await adapter.transcribeAudio({
      mimeType: "audio/wav",
      bytes: buildSilentWav({ seconds: 1 }),
      fileName: "silence.wav"
    });

    expect(typeof result.text).toBe("string");
    // Silence commonly yields empty or near-empty transcription text; we assert
    // the pipeline ran cleanly rather than that specific content was heard.
  }, 45_000);
});

describe.skipIf(!runIntegration)("audio ingest end-to-end via local-whisper", () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-whisper-ingest-"));
  });

  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("ingests a synthetic WAV using local-whisper and records provider provenance", async () => {
    await initVault(vaultDir);
    await registerLocalWhisperProvider({ rootDir: vaultDir, model: "base.en" });

    const audioPath = path.join(vaultDir, "sample.wav");
    await fs.writeFile(audioPath, buildSilentWav({ seconds: 1 }));

    const result = await ingestInputDetailed(vaultDir, audioPath);
    const manifest = [...result.created, ...result.updated][0];
    expect(manifest).toBeDefined();
    expect(manifest.sourceKind).toBe("audio");

    // The extraction artifact sidecar should carry local-whisper provenance.
    expect(manifest.extractedMetadataPath).toBeDefined();
    const artifact = JSON.parse(await fs.readFile(path.resolve(vaultDir, manifest.extractedMetadataPath as string), "utf8")) as {
      providerId?: string;
      providerModel?: string;
      sourceKind?: string;
    };
    expect(artifact.providerId).toBe("local-whisper");
    expect(artifact.providerModel).toBe("base.en");
  }, 60_000);
});
