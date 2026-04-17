import { createWriteStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadVaultConfig } from "../config.js";
import type { VaultConfig } from "../types.js";
import { ensureDir, fileExists, writeJsonFile } from "../utils.js";

const BINARY_CANDIDATES = ["whisper-cli", "whisper-cpp", "whisper"];
const HUGGINGFACE_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/**
 * Approximate download sizes for the shipped ggml models. Used only for
 * user-facing "this will download ~X MB" summaries — no correctness depends on
 * these being exact.
 */
export const LOCAL_WHISPER_MODEL_SIZES: Readonly<Record<string, string>> = Object.freeze({
  "tiny.en": "78 MB",
  tiny: "78 MB",
  "base.en": "147 MB",
  base: "147 MB",
  "small.en": "488 MB",
  small: "488 MB",
  "medium.en": "1.5 GB",
  medium: "1.5 GB",
  "large-v3": "3.1 GB",
  "large-v3-turbo": "1.6 GB"
});

export interface LocalWhisperDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
}

export interface LocalWhisperBinaryDiscovery {
  binaryPath: string | null;
  candidates: string[];
  source: "config" | "env" | "path" | "not-found";
}

export async function discoverLocalWhisperBinary(options: LocalWhisperDiscoveryOptions = {}): Promise<LocalWhisperBinaryDiscovery> {
  const env = options.env ?? process.env;
  if (env.SWARMVAULT_WHISPER_BINARY) {
    return {
      binaryPath: env.SWARMVAULT_WHISPER_BINARY,
      candidates: [env.SWARMVAULT_WHISPER_BINARY],
      source: "env"
    };
  }
  const pathValue = env.PATH ?? "";
  const candidates: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of BINARY_CANDIDATES) {
      const full = path.join(dir, name);
      candidates.push(full);
      if (await isExecutable(full)) {
        return { binaryPath: full, candidates, source: "path" };
      }
    }
  }
  return { binaryPath: null, candidates, source: "not-found" };
}

export function expectedModelPath(modelName: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  return path.join(home, ".swarmvault", "models", `ggml-${modelName}.bin`);
}

export function modelDownloadUrl(modelName: string): string {
  return `${HUGGINGFACE_BASE}/ggml-${modelName}.bin`;
}

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface DownloadOptions {
  modelName: string;
  homeDir?: string;
  onProgress?: (progress: DownloadProgress) => void;
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  path: string;
  bytes: number;
}

export async function downloadWhisperModel(options: DownloadOptions): Promise<DownloadResult> {
  const destPath = expectedModelPath(options.modelName, options.homeDir);
  await ensureDir(path.dirname(destPath));

  const doFetch = options.fetchImpl ?? fetch;
  const url = modelDownloadUrl(options.modelName);
  const response = await doFetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`Response body missing for ${url}`);
  }

  const totalHeader = response.headers.get("content-length");
  const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : undefined;

  let downloadedBytes = 0;
  const webStream = response.body as ReadableStream<Uint8Array>;
  const source = Readable.fromWeb(webStream as unknown as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    options.onProgress?.({ downloadedBytes, totalBytes });
  });
  const tmpPath = `${destPath}.part`;
  await pipeline(source, createWriteStream(tmpPath));
  await fs.rename(tmpPath, destPath);

  const stat = await fs.stat(destPath);
  return { path: destPath, bytes: stat.size };
}

export interface ProviderRegistrationOptions {
  rootDir: string;
  providerId?: string;
  model: string;
  setAsAudioProvider?: boolean;
  binaryPath?: string;
  modelPath?: string;
  threads?: number;
}

export interface ProviderRegistrationResult {
  providerId: string;
  configPath: string;
  providerWasAdded: boolean;
  providerWasUpdated: boolean;
  audioProviderSet: boolean;
  previousAudioProvider?: string;
}

export async function registerLocalWhisperProvider(options: ProviderRegistrationOptions): Promise<ProviderRegistrationResult> {
  const { config, paths } = await loadVaultConfig(options.rootDir);
  const providerId = options.providerId ?? "local-whisper";
  const desired = buildProviderEntry(options);

  const existing = config.providers[providerId];
  const providerWasAdded = !existing;
  const providerWasUpdated = !providerWasAdded && !providerEntryMatches(existing, desired);
  const previousAudioProvider = config.tasks.audioProvider;
  const shouldSetAudio = options.setAsAudioProvider !== false && (options.setAsAudioProvider === true || !previousAudioProvider);

  const next: VaultConfig = {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: desired
    },
    tasks: {
      ...config.tasks,
      audioProvider: shouldSetAudio ? providerId : previousAudioProvider
    }
  };

  await writeJsonFile(paths.configPath, next);

  return {
    providerId,
    configPath: paths.configPath,
    providerWasAdded,
    providerWasUpdated,
    audioProviderSet: shouldSetAudio && previousAudioProvider !== providerId,
    previousAudioProvider
  };
}

function buildProviderEntry(options: ProviderRegistrationOptions): VaultConfig["providers"][string] {
  const entry: VaultConfig["providers"][string] = {
    type: "local-whisper",
    model: options.model
  };
  if (options.binaryPath) entry.binaryPath = options.binaryPath;
  if (options.modelPath) entry.modelPath = options.modelPath;
  if (options.threads !== undefined) entry.threads = options.threads;
  return entry;
}

function providerEntryMatches(existing: VaultConfig["providers"][string], desired: VaultConfig["providers"][string]): boolean {
  return (
    existing.type === desired.type &&
    existing.model === desired.model &&
    existing.binaryPath === desired.binaryPath &&
    existing.modelPath === desired.modelPath &&
    existing.threads === desired.threads
  );
}

export interface LocalWhisperSetupStatus {
  binary: {
    found: boolean;
    path: string | null;
    source: LocalWhisperBinaryDiscovery["source"];
    installHint: string;
  };
  model: {
    name: string;
    expectedPath: string;
    exists: boolean;
    downloadUrl: string;
    approximateSize: string | undefined;
  };
}

export interface SummarizeSetupOptions extends LocalWhisperDiscoveryOptions {
  modelName: string;
  homeDir?: string;
}

export async function summarizeLocalWhisperSetup(options: SummarizeSetupOptions): Promise<LocalWhisperSetupStatus> {
  const discovery = await discoverLocalWhisperBinary({ env: options.env });
  const modelPath = expectedModelPath(options.modelName, options.homeDir);
  return {
    binary: {
      found: discovery.binaryPath !== null,
      path: discovery.binaryPath,
      source: discovery.source,
      installHint:
        'Install whisper.cpp — macOS: "brew install whisper-cpp"; Debian/Ubuntu: "sudo apt install whisper.cpp" (or build from https://github.com/ggerganov/whisper.cpp).'
    },
    model: {
      name: options.modelName,
      expectedPath: modelPath,
      exists: await fileExists(modelPath),
      downloadUrl: modelDownloadUrl(options.modelName),
      approximateSize: LOCAL_WHISPER_MODEL_SIZES[options.modelName]
    }
  };
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
