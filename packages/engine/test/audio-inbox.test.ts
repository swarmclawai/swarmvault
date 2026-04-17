import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importInbox, initVault, loadVaultConfig } from "../src/index.js";
import * as registry from "../src/providers/registry.js";
import type { ProviderAdapter } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-audio-inbox-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function buildSilentWav(): Buffer {
  const buffer = Buffer.alloc(44 + 16);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + 16, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(16, 40);
  return buffer;
}

describe("audio files via inbox", () => {
  it("picks up .wav files dropped into raw/inbox/ and routes them through the audio provider", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const mockProvider: ProviderAdapter = {
      id: "mock-audio",
      type: "local-whisper",
      model: "mock-model",
      capabilities: new Set(["audio", "local"]),
      generateText: vi.fn(),
      generateStructured: vi.fn(),
      transcribeAudio: vi.fn().mockResolvedValue({
        text: "Meeting recap: ship the audio inbox before release.",
        duration: 4.2,
        language: "en"
      })
    } as unknown as ProviderAdapter;
    vi.spyOn(registry, "getProviderForTask").mockResolvedValue(mockProvider);

    const { paths } = await loadVaultConfig(rootDir);
    const inboxAudio = path.join(paths.inboxDir, "memo.wav");
    await fs.writeFile(inboxAudio, buildSilentWav());

    const result = await importInbox(rootDir);
    expect(result.imported).toHaveLength(1);
    const manifest = result.imported[0];
    expect(manifest.sourceKind).toBe("audio");
    expect(manifest.extractedTextPath).toBeDefined();

    const extractedText = await fs.readFile(path.resolve(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("Meeting recap");
    expect(mockProvider.transcribeAudio).toHaveBeenCalledTimes(1);
  });
});
