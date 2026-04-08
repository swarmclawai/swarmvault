import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadVaultConfig } from "../config.js";
import type { ProviderAdapter, ProviderCapability, ProviderConfig, ResolvedPaths } from "../types.js";
import { AnthropicProviderAdapter } from "./anthropic.js";
import { GeminiProviderAdapter } from "./gemini.js";
import { HeuristicProviderAdapter } from "./heuristic.js";
import { OpenAiCompatibleProviderAdapter } from "./openai-compatible.js";

const customModuleSchema = z.object({
  createAdapter: z.function({
    input: [z.string(), z.custom<ProviderConfig>(), z.string()],
    output: z.promise(z.custom<ProviderAdapter>())
  })
});

function resolveCapabilities(config: ProviderConfig, fallback: ProviderCapability[]): ProviderCapability[] {
  return config.capabilities?.length ? config.capabilities : fallback;
}

function envOrUndefined(name?: string): string | undefined {
  return name ? process.env[name] : undefined;
}

function createOpenAiCompatiblePreset(
  id: string,
  type: ProviderConfig["type"],
  config: ProviderConfig,
  defaults: {
    baseUrl: string;
    apiKeyEnv?: string;
    apiStyle?: "responses" | "chat";
    capabilities: ProviderCapability[];
  }
): ProviderAdapter {
  return new OpenAiCompatibleProviderAdapter(id, type, config.model, {
    baseUrl: config.baseUrl ?? defaults.baseUrl,
    apiKey: envOrUndefined(config.apiKeyEnv ?? defaults.apiKeyEnv),
    headers: config.headers,
    apiStyle: config.apiStyle ?? defaults.apiStyle ?? "chat",
    capabilities: resolveCapabilities(config, defaults.capabilities)
  });
}

export async function createProvider(id: string, config: ProviderConfig, rootDir: string): Promise<ProviderAdapter> {
  switch (config.type) {
    case "heuristic":
      return new HeuristicProviderAdapter(id, config.model);
    case "openai":
      return new OpenAiCompatibleProviderAdapter(id, "openai", config.model, {
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey: envOrUndefined(config.apiKeyEnv),
        headers: config.headers,
        apiStyle: config.apiStyle ?? "responses",
        capabilities: resolveCapabilities(config, [
          "responses",
          "chat",
          "structured",
          "tools",
          "vision",
          "embeddings",
          "streaming",
          "image_generation"
        ])
      });
    case "ollama":
      return new OpenAiCompatibleProviderAdapter(id, "ollama", config.model, {
        baseUrl: config.baseUrl ?? "http://localhost:11434/v1",
        apiKey: envOrUndefined(config.apiKeyEnv) ?? "ollama",
        headers: config.headers,
        apiStyle: config.apiStyle ?? "responses",
        capabilities: resolveCapabilities(config, [
          "responses",
          "chat",
          "structured",
          "tools",
          "vision",
          "embeddings",
          "streaming",
          "local"
        ])
      });
    case "openai-compatible":
      return new OpenAiCompatibleProviderAdapter(id, "openai-compatible", config.model, {
        baseUrl: config.baseUrl ?? "http://localhost:8000/v1",
        apiKey: envOrUndefined(config.apiKeyEnv),
        headers: config.headers,
        apiStyle: config.apiStyle ?? "responses",
        capabilities: resolveCapabilities(config, ["chat", "structured", "embeddings"])
      });
    case "openrouter":
      return createOpenAiCompatiblePreset(id, "openrouter", config, {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "groq":
      return createOpenAiCompatiblePreset(id, "groq", config, {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKeyEnv: "GROQ_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "together":
      return createOpenAiCompatiblePreset(id, "together", config, {
        baseUrl: "https://api.together.xyz/v1",
        apiKeyEnv: "TOGETHER_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "xai":
      return createOpenAiCompatiblePreset(id, "xai", config, {
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "cerebras":
      return createOpenAiCompatiblePreset(id, "cerebras", config, {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKeyEnv: "CEREBRAS_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "anthropic":
      return new AnthropicProviderAdapter(id, config.model, {
        apiKey: envOrUndefined(config.apiKeyEnv),
        headers: config.headers,
        baseUrl: config.baseUrl
      });
    case "gemini":
      return new GeminiProviderAdapter(id, config.model, {
        apiKey: envOrUndefined(config.apiKeyEnv),
        baseUrl: config.baseUrl
      });
    case "custom": {
      if (!config.module) {
        throw new Error(`Provider ${id} is type "custom" but no module path was configured.`);
      }
      const resolvedModule = path.isAbsolute(config.module) ? config.module : path.resolve(rootDir, config.module);
      const loaded = await import(pathToFileURL(resolvedModule).href);
      const parsed = customModuleSchema.parse(loaded);
      return parsed.createAdapter(id, config, rootDir);
    }
    default:
      throw new Error(`Unsupported provider type ${String(config.type)}`);
  }
}

export async function getProviderForTask(
  rootDir: string,
  task: keyof Awaited<ReturnType<typeof loadVaultConfig>>["config"]["tasks"]
): Promise<ProviderAdapter> {
  const { config } = await loadVaultConfig(rootDir);
  const providerId = config.tasks[task];
  if (!providerId) {
    throw new Error(`No provider configured for task "${String(task)}".`);
  }
  const providerConfig = config.providers[providerId];
  if (!providerConfig) {
    throw new Error(`No provider configured with id "${providerId}" for task "${task}".`);
  }
  return createProvider(providerId, providerConfig, rootDir);
}

export function assertProviderCapability(provider: ProviderAdapter, capability: ProviderCapability): void {
  if (!provider.capabilities.has(capability)) {
    throw new Error(`Provider ${provider.id} does not support required capability "${capability}".`);
  }
}

export async function getResolvedPaths(rootDir: string): Promise<ResolvedPaths> {
  return (await loadVaultConfig(rootDir)).paths;
}
