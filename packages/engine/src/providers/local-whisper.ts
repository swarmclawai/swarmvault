import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AudioTranscriptionRequest, AudioTranscriptionResponse, GenerationRequest, GenerationResponse } from "../types.js";
import { BaseProviderAdapter } from "./base.js";

const DEFAULT_MODEL = "base.en";
const BINARY_CANDIDATES = ["whisper-cli", "whisper-cpp", "whisper"];
const MIME_TO_EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "webm"
};

export interface LocalWhisperAdapterOptions {
  binaryPath?: string;
  model?: string;
  modelPath?: string;
  extraArgs?: string[];
  threads?: number;
  /**
   * Replaces the default `child_process.spawn`-based runner. Exposed so unit
   * tests can exercise the adapter without requiring a real whisper.cpp binary
   * on `$PATH`.
   */
  runner?: WhisperRunner;
  /** Overrides the directory used for temp audio files. */
  tmpDir?: string;
  /** Overrides environment variable lookup. */
  env?: NodeJS.ProcessEnv;
  /** Overrides `$HOME` used to resolve the default models directory. */
  homeDir?: string;
}

export type WhisperRunner = (input: { binaryPath: string; args: string[] }) => Promise<WhisperRunResult>;

export interface WhisperRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class LocalWhisperProviderAdapter extends BaseProviderAdapter {
  private readonly options: LocalWhisperAdapterOptions;

  public constructor(id: string, model: string, options: LocalWhisperAdapterOptions = {}) {
    super(id, "local-whisper", model, ["audio", "local"]);
    this.options = options;
  }

  public async generateText(_request: GenerationRequest): Promise<GenerationResponse> {
    throw new Error(`Provider ${this.id} (local-whisper) only supports audio transcription.`);
  }

  public async transcribeAudio(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse> {
    const binaryPath = await this.resolveBinaryPath();
    const modelPath = await this.resolveModelPath();

    const tmpDir = this.options.tmpDir ?? os.tmpdir();
    const extension = this.extensionForRequest(request);
    const stem = `swarmvault-whisper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const audioPath = path.join(tmpDir, `${stem}.${extension}`);
    await fs.writeFile(audioPath, request.bytes);

    const args: string[] = ["-m", modelPath, "-f", audioPath, "-nt"];
    if (request.corpusHint) {
      args.push("--prompt", request.corpusHint);
    }
    if (this.options.threads !== undefined) {
      args.push("-t", String(this.options.threads));
    }
    if (request.language) {
      args.push("-l", request.language);
    }
    if (this.options.extraArgs?.length) {
      args.push(...this.options.extraArgs);
    }

    const runner = this.options.runner ?? defaultWhisperRunner;
    try {
      const result = await runner({ binaryPath, args });
      if (result.code !== 0) {
        const tail = truncate(result.stderr.trim() || result.stdout.trim(), 240);
        throw new Error(`whisper.cpp exited with code ${result.code}: ${tail}`);
      }
      return { text: normalizeTranscript(result.stdout) };
    } finally {
      await fs.unlink(audioPath).catch(() => undefined);
    }
  }

  private extensionForRequest(request: AudioTranscriptionRequest): string {
    const fromFile = request.fileName ? path.extname(request.fileName).slice(1).toLowerCase() : "";
    if (fromFile) return fromFile;
    return MIME_TO_EXT[request.mimeType.toLowerCase()] ?? "wav";
  }

  private async resolveBinaryPath(): Promise<string> {
    if (this.options.binaryPath) return this.options.binaryPath;
    const env = this.options.env ?? process.env;
    if (env.SWARMVAULT_WHISPER_BINARY) return env.SWARMVAULT_WHISPER_BINARY;
    const pathValue = env.PATH ?? "";
    for (const dir of pathValue.split(path.delimiter)) {
      if (!dir) continue;
      for (const candidate of BINARY_CANDIDATES) {
        const full = path.join(dir, candidate);
        if (await isExecutable(full)) return full;
      }
    }
    throw new Error(
      'Local whisper binary not found. Install whisper.cpp (e.g. "brew install whisper-cpp" or "apt install whisper.cpp") or set "localWhisper.binaryPath" in swarmvault.config.json.'
    );
  }

  private async resolveModelPath(): Promise<string> {
    if (this.options.modelPath) return this.options.modelPath;
    const home = this.options.homeDir ?? (this.options.env ?? process.env).HOME ?? os.homedir();
    const modelName = this.options.model ?? this.model ?? DEFAULT_MODEL;
    const candidate = path.join(home, ".swarmvault", "models", `ggml-${modelName}.bin`);
    if (await fileExists(candidate)) return candidate;
    throw new Error(
      `Whisper model "${modelName}" not found at ${candidate}. Run "swarmvault provider setup --local-whisper" to download it.`
    );
  }
}

export const defaultWhisperRunner: WhisperRunner = ({ binaryPath, args }) =>
  new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

export function normalizeTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}
