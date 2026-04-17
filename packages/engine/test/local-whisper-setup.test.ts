import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initWorkspace, loadVaultConfig } from "../src/index.js";
import {
  discoverLocalWhisperBinary,
  downloadWhisperModel,
  expectedModelPath,
  LOCAL_WHISPER_MODEL_SIZES,
  modelDownloadUrl,
  registerLocalWhisperProvider,
  summarizeLocalWhisperSetup
} from "../src/providers/local-whisper-setup.js";

async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `swarmvault-${label}-`));
}

async function makeFakeBinary(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const full = path.join(dir, name);
  await fs.writeFile(full, "#!/bin/sh\nexit 0\n");
  await fs.chmod(full, 0o755);
  return full;
}

describe("discoverLocalWhisperBinary", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await makeTempDir("whisper-discover");
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns the env override when SWARMVAULT_WHISPER_BINARY is set", async () => {
    const result = await discoverLocalWhisperBinary({
      env: { SWARMVAULT_WHISPER_BINARY: "/opt/custom/whisper" }
    });
    expect(result.binaryPath).toBe("/opt/custom/whisper");
    expect(result.source).toBe("env");
  });

  it("searches PATH for whisper-cli and returns the first match", async () => {
    const binDir = path.join(tmpRoot, "bin");
    await makeFakeBinary(binDir, "whisper-cli");
    const result = await discoverLocalWhisperBinary({ env: { PATH: binDir } });
    expect(result.binaryPath).toBe(path.join(binDir, "whisper-cli"));
    expect(result.source).toBe("path");
  });

  it("returns not-found when no candidate exists on PATH", async () => {
    const result = await discoverLocalWhisperBinary({
      env: { PATH: path.join(tmpRoot, "empty") }
    });
    expect(result.binaryPath).toBeNull();
    expect(result.source).toBe("not-found");
  });
});

describe("expectedModelPath / modelDownloadUrl", () => {
  it("resolves to ~/.swarmvault/models/ggml-<model>.bin", () => {
    const result = expectedModelPath("base.en", "/home/user");
    expect(result).toBe("/home/user/.swarmvault/models/ggml-base.en.bin");
  });

  it("builds the canonical Hugging Face URL", () => {
    expect(modelDownloadUrl("base.en")).toBe("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin");
  });

  it("exposes approximate sizes for user-facing summaries", () => {
    expect(LOCAL_WHISPER_MODEL_SIZES["base.en"]).toBeDefined();
    expect(LOCAL_WHISPER_MODEL_SIZES["small.en"]).toBeDefined();
  });
});

describe("downloadWhisperModel", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await makeTempDir("whisper-download");
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("streams the response body to ~/.swarmvault/models/ggml-<model>.bin", async () => {
    const payload = Buffer.from("this-is-a-fake-ggml-blob");
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-length": String(payload.length) }
        })
    );

    const result = await downloadWhisperModel({
      modelName: "tiny.en",
      homeDir: tmpRoot,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.path).toBe(path.join(tmpRoot, ".swarmvault", "models", "ggml-tiny.en.bin"));
    expect(result.bytes).toBe(payload.length);
    expect(fetchImpl).toHaveBeenCalledWith("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin");
    const written = await fs.readFile(result.path);
    expect(written.equals(payload)).toBe(true);
  });

  it("throws with a clear message when the response is not OK", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" }));

    await expect(
      downloadWhisperModel({
        modelName: "missing",
        homeDir: tmpRoot,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/404.*Not Found/);
  });
});

describe("registerLocalWhisperProvider", () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await makeTempDir("whisper-register");
    await initWorkspace(vaultDir);
  });
  afterEach(async () => {
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  it("adds the provider and sets tasks.audioProvider when no audio provider is configured yet", async () => {
    const result = await registerLocalWhisperProvider({
      rootDir: vaultDir,
      model: "base.en"
    });
    expect(result.providerWasAdded).toBe(true);
    expect(result.audioProviderSet).toBe(true);

    const { config } = await loadVaultConfig(vaultDir);
    expect(config.providers["local-whisper"]).toEqual({ type: "local-whisper", model: "base.en" });
    expect(config.tasks.audioProvider).toBe("local-whisper");
  });

  it("preserves an already-configured audioProvider unless explicitly overridden", async () => {
    // seed a pre-existing audio provider
    const initial = await loadVaultConfig(vaultDir);
    initial.config.providers.openai = { type: "openai", model: "whisper-1" };
    initial.config.tasks.audioProvider = "openai";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(initial.paths.configPath, JSON.stringify(initial.config, null, 2));

    const result = await registerLocalWhisperProvider({
      rootDir: vaultDir,
      model: "base.en"
    });
    expect(result.providerWasAdded).toBe(true);
    expect(result.audioProviderSet).toBe(false);
    expect(result.previousAudioProvider).toBe("openai");

    const { config } = await loadVaultConfig(vaultDir);
    expect(config.tasks.audioProvider).toBe("openai");
    expect(config.providers["local-whisper"].type).toBe("local-whisper");
  });

  it("forces audioProvider assignment when setAsAudioProvider is true", async () => {
    const initial = await loadVaultConfig(vaultDir);
    initial.config.providers.openai = { type: "openai", model: "whisper-1" };
    initial.config.tasks.audioProvider = "openai";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(initial.paths.configPath, JSON.stringify(initial.config, null, 2));

    const result = await registerLocalWhisperProvider({
      rootDir: vaultDir,
      model: "base.en",
      setAsAudioProvider: true
    });
    expect(result.audioProviderSet).toBe(true);
    const { config } = await loadVaultConfig(vaultDir);
    expect(config.tasks.audioProvider).toBe("local-whisper");
  });

  it("records binaryPath, modelPath, and threads when provided", async () => {
    await registerLocalWhisperProvider({
      rootDir: vaultDir,
      model: "small.en",
      binaryPath: "/opt/bin/whisper-cli",
      modelPath: "/opt/models/ggml-small.en.bin",
      threads: 8
    });
    const { config } = await loadVaultConfig(vaultDir);
    expect(config.providers["local-whisper"]).toEqual({
      type: "local-whisper",
      model: "small.en",
      binaryPath: "/opt/bin/whisper-cli",
      modelPath: "/opt/models/ggml-small.en.bin",
      threads: 8
    });
  });

  it("updates an existing local-whisper entry when the config drifts", async () => {
    await registerLocalWhisperProvider({ rootDir: vaultDir, model: "base.en" });
    const second = await registerLocalWhisperProvider({
      rootDir: vaultDir,
      model: "small.en"
    });
    expect(second.providerWasAdded).toBe(false);
    expect(second.providerWasUpdated).toBe(true);
    const { config } = await loadVaultConfig(vaultDir);
    expect(config.providers["local-whisper"].model).toBe("small.en");
  });
});

describe("summarizeLocalWhisperSetup", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await makeTempDir("whisper-summary");
  });
  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("reports binary missing and model missing", async () => {
    const status = await summarizeLocalWhisperSetup({
      modelName: "base.en",
      homeDir: tmpRoot,
      env: { PATH: path.join(tmpRoot, "empty") }
    });
    expect(status.binary.found).toBe(false);
    expect(status.binary.source).toBe("not-found");
    expect(status.model.exists).toBe(false);
    expect(status.model.expectedPath).toContain("ggml-base.en.bin");
    expect(status.model.downloadUrl).toContain("huggingface.co");
    expect(status.model.approximateSize).toBe(LOCAL_WHISPER_MODEL_SIZES["base.en"]);
  });

  it("reports binary found via PATH and model present when the file exists", async () => {
    const binDir = path.join(tmpRoot, "bin");
    const binary = await makeFakeBinary(binDir, "whisper-cli");
    await fs.mkdir(path.join(tmpRoot, ".swarmvault", "models"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, ".swarmvault", "models", "ggml-base.en.bin"), "blob");

    const status = await summarizeLocalWhisperSetup({
      modelName: "base.en",
      homeDir: tmpRoot,
      env: { PATH: binDir }
    });
    expect(status.binary.found).toBe(true);
    expect(status.binary.path).toBe(binary);
    expect(status.binary.source).toBe("path");
    expect(status.model.exists).toBe(true);
  });
});
