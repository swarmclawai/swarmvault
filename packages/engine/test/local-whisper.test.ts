import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalWhisperProviderAdapter,
  normalizeTranscript,
  type WhisperRunner,
  type WhisperRunResult
} from "../src/providers/local-whisper.js";

type RunnerCall = { binaryPath: string; args: string[] };

function makeRunner(result: Partial<WhisperRunResult> = {}): {
  runner: WhisperRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: WhisperRunner = async ({ binaryPath, args }) => {
    calls.push({ binaryPath, args });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { runner, calls };
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-local-whisper-test-"));
}

async function makeFakeBinary(dir: string, name: string): Promise<string> {
  const full = path.join(dir, name);
  await fs.writeFile(full, "#!/bin/sh\nexit 0\n");
  await fs.chmod(full, 0o755);
  return full;
}

async function makeFakeModel(home: string, modelName: string): Promise<string> {
  const modelDir = path.join(home, ".swarmvault", "models");
  await fs.mkdir(modelDir, { recursive: true });
  const full = path.join(modelDir, `ggml-${modelName}.bin`);
  await fs.writeFile(full, "fake-ggml-bytes");
  return full;
}

describe("LocalWhisperProviderAdapter", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exposes only audio and local capabilities", () => {
    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: "/fake/whisper-cli",
      modelPath: "/fake/model.bin"
    });
    expect(adapter.capabilities.has("audio")).toBe(true);
    expect(adapter.capabilities.has("local")).toBe(true);
    expect(adapter.capabilities.has("chat")).toBe(false);
    expect(adapter.capabilities.has("structured")).toBe(false);
    expect(adapter.capabilities.has("embeddings")).toBe(false);
    expect(adapter.capabilities.has("vision")).toBe(false);
  });

  it("throws when generateText is called (audio-only provider)", async () => {
    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: "/fake/whisper-cli",
      modelPath: "/fake/model.bin"
    });
    await expect(adapter.generateText({ prompt: "hi" })).rejects.toThrow(/only supports audio transcription/);
  });

  it("builds whisper-cli args with model, file, -nt, corpusHint prompt, threads, language, and extraArgs", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    const { runner, calls } = makeRunner({ stdout: "Hello world\n" });

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      modelPath: model,
      threads: 4,
      extraArgs: ["--no-fallback"],
      runner,
      tmpDir: tmpRoot
    });

    const result = await adapter.transcribeAudio({
      mimeType: "audio/wav",
      bytes: Buffer.from("fake-wav-bytes"),
      fileName: "meeting.wav",
      corpusHint: "This audio is likely about ApprovalBundle, ClaimGraph.",
      language: "en"
    });

    expect(result.text).toBe("Hello world");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.binaryPath).toBe(binary);
    const args = call.args;
    const mIndex = args.indexOf("-m");
    expect(args[mIndex + 1]).toBe(model);
    expect(args).toContain("-nt");
    const promptIndex = args.indexOf("--prompt");
    expect(args[promptIndex + 1]).toBe("This audio is likely about ApprovalBundle, ClaimGraph.");
    const tIndex = args.indexOf("-t");
    expect(args[tIndex + 1]).toBe("4");
    const lIndex = args.indexOf("-l");
    expect(args[lIndex + 1]).toBe("en");
    expect(args).toContain("--no-fallback");
    // audio file has correct extension from fileName
    const fIndex = args.indexOf("-f");
    expect(args[fIndex + 1].endsWith(".wav")).toBe(true);
  });

  it("omits --prompt, -t, and -l when not provided", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    const { runner, calls } = makeRunner({ stdout: "hi\n" });

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      modelPath: model,
      runner,
      tmpDir: tmpRoot
    });

    await adapter.transcribeAudio({
      mimeType: "audio/wav",
      bytes: Buffer.from("x")
    });

    const args = calls[0].args;
    expect(args).not.toContain("--prompt");
    expect(args).not.toContain("-t");
    expect(args).not.toContain("-l");
  });

  it("derives temp audio extension from mimeType when fileName is absent", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    const { runner, calls } = makeRunner({ stdout: "hi\n" });

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      modelPath: model,
      runner,
      tmpDir: tmpRoot
    });

    await adapter.transcribeAudio({
      mimeType: "audio/mpeg",
      bytes: Buffer.from("x")
    });

    const fIndex = calls[0].args.indexOf("-f");
    expect(calls[0].args[fIndex + 1].endsWith(".mp3")).toBe(true);
  });

  it("throws and includes stderr tail when whisper-cli exits non-zero", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    const { runner } = makeRunner({
      code: 1,
      stdout: "",
      stderr: "error: unable to load model at /fake/model.bin\n"
    });

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      modelPath: model,
      runner,
      tmpDir: tmpRoot
    });

    await expect(adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("x") })).rejects.toThrow(
      /exited with code 1.*unable to load model/
    );
  });

  it("cleans up the temp audio file after success and failure", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    const tempAudio: string[] = [];
    const runner: WhisperRunner = async ({ args }) => {
      const fIndex = args.indexOf("-f");
      tempAudio.push(args[fIndex + 1]);
      return { code: 0, stdout: "hi\n", stderr: "" };
    };

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      modelPath: model,
      runner,
      tmpDir: tmpRoot
    });

    await adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("ok") });
    expect(tempAudio).toHaveLength(1);
    await expect(fs.access(tempAudio[0])).rejects.toThrow(); // removed

    const failingAdapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      modelPath: model,
      runner: async ({ args }) => {
        const fIndex = args.indexOf("-f");
        tempAudio.push(args[fIndex + 1]);
        return { code: 2, stdout: "", stderr: "boom" };
      },
      tmpDir: tmpRoot
    });
    await expect(failingAdapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("ok") })).rejects.toThrow();
    expect(tempAudio).toHaveLength(2);
    await expect(fs.access(tempAudio[1])).rejects.toThrow();
  });

  it("throws a helpful message when the binary cannot be resolved", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      modelPath: model,
      env: { PATH: path.join(tmpRoot, "empty") },
      tmpDir: tmpRoot
    });
    await expect(adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("x") })).rejects.toThrow(
      /Local whisper binary not found/
    );
  });

  it("prefers SWARMVAULT_WHISPER_BINARY env over PATH search", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const customBinary = await makeFakeBinary(tmpRoot, "my-custom-whisper");
    const { runner, calls } = makeRunner({ stdout: "hi\n" });

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      modelPath: model,
      env: { SWARMVAULT_WHISPER_BINARY: customBinary, PATH: "/tmp/empty" },
      runner,
      tmpDir: tmpRoot
    });

    await adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("x") });
    expect(calls[0].binaryPath).toBe(customBinary);
  });

  it("discovers whisper-cli from PATH when no explicit binary is configured", async () => {
    const model = await makeFakeModel(tmpRoot, "base.en");
    const binDir = path.join(tmpRoot, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const binary = await makeFakeBinary(binDir, "whisper-cli");
    const { runner, calls } = makeRunner({ stdout: "hi\n" });

    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      modelPath: model,
      env: { PATH: binDir },
      runner,
      tmpDir: tmpRoot
    });

    await adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("x") });
    expect(calls[0].binaryPath).toBe(binary);
  });

  it("throws a helpful message when the model file is missing", async () => {
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    const adapter = new LocalWhisperProviderAdapter("whisper", "base.en", {
      binaryPath: binary,
      homeDir: tmpRoot, // no ~/.swarmvault/models here
      tmpDir: tmpRoot
    });
    await expect(adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("x") })).rejects.toThrow(
      /Whisper model "base.en" not found.*provider setup --local-whisper/
    );
  });

  it("resolves model from homeDir + modelName when modelPath is not set", async () => {
    const binary = await makeFakeBinary(tmpRoot, "whisper-cli");
    await makeFakeModel(tmpRoot, "small.en");
    const { runner, calls } = makeRunner({ stdout: "hi\n" });

    const adapter = new LocalWhisperProviderAdapter("whisper", "small.en", {
      binaryPath: binary,
      homeDir: tmpRoot,
      runner,
      tmpDir: tmpRoot
    });

    await adapter.transcribeAudio({ mimeType: "audio/wav", bytes: Buffer.from("x") });
    const mIndex = calls[0].args.indexOf("-m");
    expect(calls[0].args[mIndex + 1]).toBe(path.join(tmpRoot, ".swarmvault", "models", "ggml-small.en.bin"));
  });
});

describe("normalizeTranscript", () => {
  it("trims whitespace, strips blank lines, and collapses interior whitespace", () => {
    const stdout = ["", "  Hello, world.  ", "", "  This is a   test.", ""].join("\n");
    expect(normalizeTranscript(stdout)).toBe("Hello, world. This is a test.");
  });

  it("returns empty string for all-blank input", () => {
    expect(normalizeTranscript("   \n\n  \n")).toBe("");
  });
});
