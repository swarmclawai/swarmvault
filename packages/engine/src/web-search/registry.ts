import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadVaultConfig } from "../config.js";
import type { WebSearchAdapter, WebSearchProviderConfig } from "../types.js";
import { HttpJsonWebSearchAdapter } from "./http-json.js";

const customWebSearchModuleSchema = z.object({
  createAdapter: z.function({
    input: [z.string(), z.custom<WebSearchProviderConfig>(), z.string()],
    output: z.promise(z.custom<WebSearchAdapter>())
  })
});

export async function createWebSearchAdapter(id: string, config: WebSearchProviderConfig, rootDir: string): Promise<WebSearchAdapter> {
  switch (config.type) {
    case "http-json":
      return new HttpJsonWebSearchAdapter(id, config);
    case "custom": {
      if (!config.module) {
        throw new Error(`Web search provider ${id} is type "custom" but no module path was configured.`);
      }
      const resolvedModule = path.isAbsolute(config.module) ? config.module : path.resolve(rootDir, config.module);
      const loaded = await import(pathToFileURL(resolvedModule).href);
      const parsed = customWebSearchModuleSchema.parse(loaded);
      return parsed.createAdapter(id, config, rootDir);
    }
    default:
      throw new Error(`Unsupported web search provider type ${String(config.type)}`);
  }
}

export type WebSearchTaskId = "deepLintProvider" | "queryProvider" | "exploreProvider";

export async function getWebSearchAdapterForTask(rootDir: string, task: WebSearchTaskId): Promise<WebSearchAdapter> {
  const { config } = await loadVaultConfig(rootDir);
  const webSearchConfig = config.webSearch;
  if (!webSearchConfig) {
    throw new Error("No web search providers are configured. Add a webSearch block to swarmvault.config.json.");
  }

  const providerId = webSearchConfig.tasks[task];
  if (!providerId) {
    throw new Error(`No web search provider is configured for task "${task}". Add webSearch.tasks.${task} to swarmvault.config.json.`);
  }
  const providerConfig = webSearchConfig.providers[providerId];
  if (!providerConfig) {
    throw new Error(`No web search provider configured with id "${providerId}" for task "${task}".`);
  }

  return createWebSearchAdapter(providerId, providerConfig, rootDir);
}
