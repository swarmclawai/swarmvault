import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  agentTypeSchema,
  providerCapabilitySchema,
  providerTypeSchema,
  type ResolvedPaths,
  type VaultConfig,
  webSearchProviderTypeSchema
} from "./types.js";
import { ensureDir, fileExists, readJsonFile, writeJsonFile } from "./utils.js";

const PRIMARY_CONFIG_FILENAME = "swarmvault.config.json";
export const PRIMARY_SCHEMA_FILENAME = "swarmvault.schema.md";
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const viewerDistDir = path.basename(moduleDir) === "src" ? path.resolve(moduleDir, "../../viewer/dist") : path.resolve(moduleDir, "viewer");

const providerConfigSchema = z.object({
  type: providerTypeSchema,
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  module: z.string().min(1).optional(),
  capabilities: z.array(providerCapabilitySchema).optional(),
  apiStyle: z.enum(["responses", "chat"]).optional()
});

const sourceClassSchema = z.enum(["first_party", "third_party", "resource", "generated"]);

const scheduleTriggerSchema = z
  .object({
    cron: z.string().min(1).optional(),
    every: z.string().min(1).optional()
  })
  .refine((value) => Boolean(value.cron || value.every), {
    message: "Schedule triggers require `cron` or `every`."
  });

const scheduledTaskSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("compile"),
    approve: z.boolean().optional()
  }),
  z.object({
    type: z.literal("lint"),
    deep: z.boolean().optional(),
    web: z.boolean().optional()
  }),
  z.object({
    type: z.literal("query"),
    question: z.string().min(1),
    format: z.enum(["markdown", "report", "slides", "chart", "image"]).optional(),
    save: z.boolean().optional()
  }),
  z.object({
    type: z.literal("explore"),
    question: z.string().min(1),
    steps: z.number().int().positive().optional(),
    format: z.enum(["markdown", "report", "slides", "chart", "image"]).optional()
  })
]);

const roleExecutorConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("provider"),
    provider: z.string().min(1)
  }),
  z.object({
    type: z.literal("command"),
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional()
  })
]);

const webSearchProviderConfigSchema = z.object({
  type: webSearchProviderTypeSchema,
  endpoint: z.string().url().optional(),
  method: z.enum(["GET", "POST"]).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  apiKeyHeader: z.string().min(1).optional(),
  apiKeyPrefix: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  queryParam: z.string().min(1).optional(),
  limitParam: z.string().min(1).optional(),
  resultsPath: z.string().min(1).optional(),
  titleField: z.string().min(1).optional(),
  urlField: z.string().min(1).optional(),
  snippetField: z.string().min(1).optional(),
  module: z.string().min(1).optional()
});

const vaultConfigSchema = z.object({
  workspace: z.object({
    rawDir: z.string().min(1),
    wikiDir: z.string().min(1),
    stateDir: z.string().min(1),
    agentDir: z.string().min(1),
    inboxDir: z.string().min(1)
  }),
  providers: z.record(z.string(), providerConfigSchema),
  tasks: z.object({
    compileProvider: z.string().min(1),
    queryProvider: z.string().min(1),
    lintProvider: z.string().min(1),
    visionProvider: z.string().min(1),
    imageProvider: z.string().min(1).optional(),
    embeddingProvider: z.string().min(1).optional()
  }),
  viewer: z.object({
    port: z.number().int().positive()
  }),
  projects: z
    .record(
      z.string(),
      z.object({
        roots: z.array(z.string().min(1)).min(1),
        schemaPath: z.string().min(1).optional()
      })
    )
    .optional(),
  agents: z.array(agentTypeSchema).default(["codex", "claude", "cursor"]),
  schedules: z
    .record(z.string(), z.object({ enabled: z.boolean().optional(), when: scheduleTriggerSchema, task: scheduledTaskSchema }))
    .optional(),
  orchestration: z
    .object({
      maxParallelRoles: z.number().int().positive().optional(),
      compilePostPass: z.boolean().optional(),
      roles: z
        .object({
          research: z.object({ executor: roleExecutorConfigSchema }).optional(),
          audit: z.object({ executor: roleExecutorConfigSchema }).optional(),
          context: z.object({ executor: roleExecutorConfigSchema }).optional(),
          safety: z.object({ executor: roleExecutorConfigSchema }).optional()
        })
        .optional()
    })
    .optional(),
  benchmark: z
    .object({
      enabled: z.boolean().optional(),
      questions: z.array(z.string().min(1)).optional(),
      maxQuestions: z.number().int().positive().optional()
    })
    .optional(),
  repoAnalysis: z
    .object({
      classifyGlobs: z.partialRecord(sourceClassSchema, z.array(z.string().min(1))).optional(),
      extractClasses: z.array(sourceClassSchema).optional()
    })
    .optional(),
  webSearch: z
    .object({
      providers: z.record(z.string(), webSearchProviderConfigSchema),
      tasks: z.object({
        deepLintProvider: z.string().min(1)
      })
    })
    .optional()
});

export function defaultVaultConfig(): VaultConfig {
  return {
    workspace: {
      rawDir: "raw",
      wikiDir: "wiki",
      stateDir: "state",
      agentDir: "agent",
      inboxDir: "inbox"
    },
    providers: {
      local: {
        type: "heuristic",
        model: "heuristic-v1",
        capabilities: ["chat", "structured", "vision", "local"]
      }
    },
    tasks: {
      compileProvider: "local",
      queryProvider: "local",
      lintProvider: "local",
      visionProvider: "local",
      imageProvider: "local"
    },
    viewer: {
      port: 4123
    },
    projects: {},
    agents: ["codex", "claude", "cursor"],
    schedules: {},
    orchestration: {
      maxParallelRoles: 2,
      compilePostPass: false,
      roles: {}
    },
    benchmark: {
      enabled: true,
      questions: [],
      maxQuestions: 3
    },
    repoAnalysis: {
      classifyGlobs: {},
      extractClasses: ["first_party"]
    }
  };
}

export function defaultVaultSchema(): string {
  return [
    "# SwarmVault Schema",
    "",
    "Edit this file to teach SwarmVault how this vault should be organized and maintained.",
    "",
    "## Vault Purpose",
    "",
    "- Describe the domain this vault covers.",
    "- Note the intended audience and the kinds of questions the vault should answer well.",
    "",
    "## Naming Conventions",
    "",
    "- Prefer stable, descriptive page titles.",
    "- Keep concept and entity names specific to the domain.",
    "",
    "## Page Structure Rules",
    "",
    "- Source pages should stay grounded in the original material.",
    "- Concept and entity pages should aggregate source-backed claims instead of inventing new ones.",
    "- Preserve contradictions instead of smoothing them away.",
    "",
    "## Categories",
    "",
    "- List domain-specific concept categories here.",
    "- List important entity types here.",
    "",
    "## Relationship Types",
    "",
    "- Mentions",
    "- Supports",
    "- Contradicts",
    "- Depends on",
    "",
    "## Grounding Rules",
    "",
    "- Prefer raw sources over summaries.",
    "- Cite source ids whenever claims are stated.",
    "- Do not treat the wiki as a source of truth when the raw material disagrees.",
    "",
    "## Exclusions",
    "",
    "- List topics, claims, or page types the compiler should avoid generating.",
    ""
  ].join("\n");
}

async function findConfigPath(rootDir: string): Promise<string> {
  const primaryPath = path.join(rootDir, PRIMARY_CONFIG_FILENAME);
  return primaryPath;
}

async function findSchemaPath(rootDir: string): Promise<string> {
  const primaryPath = path.join(rootDir, PRIMARY_SCHEMA_FILENAME);
  return primaryPath;
}

export function resolvePaths(
  rootDir: string,
  config?: VaultConfig,
  configPath = path.join(rootDir, PRIMARY_CONFIG_FILENAME),
  schemaPath = path.join(rootDir, PRIMARY_SCHEMA_FILENAME)
): ResolvedPaths {
  const effective = config ?? defaultVaultConfig();
  const rawDir = path.resolve(rootDir, effective.workspace.rawDir);
  const rawSourcesDir = path.join(rawDir, "sources");
  const rawAssetsDir = path.join(rawDir, "assets");
  const wikiDir = path.resolve(rootDir, effective.workspace.wikiDir);
  const outputsAssetsDir = path.join(wikiDir, "outputs", "assets");
  const projectsDir = path.join(wikiDir, "projects");
  const candidatesDir = path.join(wikiDir, "candidates");
  const stateDir = path.resolve(rootDir, effective.workspace.stateDir);
  const schedulesDir = path.join(stateDir, "schedules");
  const watchDir = path.join(stateDir, "watch");
  const agentDir = path.resolve(rootDir, effective.workspace.agentDir);
  const inboxDir = path.resolve(rootDir, effective.workspace.inboxDir);

  return {
    rootDir,
    schemaPath,
    rawDir,
    rawSourcesDir,
    rawAssetsDir,
    wikiDir,
    outputsAssetsDir,
    projectsDir,
    candidatesDir,
    candidateConceptsDir: path.join(candidatesDir, "concepts"),
    candidateEntitiesDir: path.join(candidatesDir, "entities"),
    stateDir,
    schedulesDir,
    agentDir,
    inboxDir,
    manifestsDir: path.join(stateDir, "manifests"),
    extractsDir: path.join(stateDir, "extracts"),
    analysesDir: path.join(stateDir, "analyses"),
    viewerDistDir,
    graphPath: path.join(stateDir, "graph.json"),
    searchDbPath: path.join(stateDir, "search.sqlite"),
    compileStatePath: path.join(stateDir, "compile-state.json"),
    codeIndexPath: path.join(stateDir, "code-index.json"),
    embeddingsPath: path.join(stateDir, "embeddings.json"),
    benchmarkPath: path.join(stateDir, "benchmark.json"),
    jobsLogPath: path.join(stateDir, "jobs.ndjson"),
    sessionsDir: path.join(stateDir, "sessions"),
    approvalsDir: path.join(stateDir, "approvals"),
    watchDir,
    watchStatusPath: path.join(watchDir, "status.json"),
    pendingSemanticRefreshPath: path.join(watchDir, "pending-semantic-refresh.json"),
    configPath
  };
}

export async function loadVaultConfig(rootDir: string): Promise<{ config: VaultConfig; paths: ResolvedPaths }> {
  const configPath = await findConfigPath(rootDir);
  const schemaPath = await findSchemaPath(rootDir);
  const raw = await readJsonFile<unknown>(configPath);
  const parsed = vaultConfigSchema.parse(raw ?? defaultVaultConfig());
  return {
    config: parsed,
    paths: resolvePaths(rootDir, parsed, configPath, schemaPath)
  };
}

export async function initWorkspace(rootDir: string): Promise<{ config: VaultConfig; paths: ResolvedPaths }> {
  const configPath = await findConfigPath(rootDir);
  const schemaPath = await findSchemaPath(rootDir);
  const config = (await fileExists(configPath)) ? (await loadVaultConfig(rootDir)).config : defaultVaultConfig();
  const paths = resolvePaths(rootDir, config, configPath, schemaPath);
  const primarySchemaPath = path.join(rootDir, PRIMARY_SCHEMA_FILENAME);

  await Promise.all([
    ensureDir(paths.rawDir),
    ensureDir(paths.wikiDir),
    ensureDir(paths.outputsAssetsDir),
    ensureDir(paths.projectsDir),
    ensureDir(paths.candidatesDir),
    ensureDir(paths.candidateConceptsDir),
    ensureDir(paths.candidateEntitiesDir),
    ensureDir(paths.stateDir),
    ensureDir(paths.schedulesDir),
    ensureDir(paths.watchDir),
    ensureDir(paths.sessionsDir),
    ensureDir(paths.approvalsDir),
    ensureDir(paths.agentDir),
    ensureDir(paths.inboxDir),
    ensureDir(paths.manifestsDir),
    ensureDir(paths.extractsDir),
    ensureDir(paths.analysesDir),
    ensureDir(paths.rawSourcesDir),
    ensureDir(paths.rawAssetsDir)
  ]);

  if (!(await fileExists(configPath))) {
    await writeJsonFile(configPath, config);
  }

  if (!(await fileExists(primarySchemaPath))) {
    await ensureDir(path.dirname(primarySchemaPath));
    await fs.writeFile(primarySchemaPath, defaultVaultSchema(), "utf8");
  }

  return { config, paths };
}
