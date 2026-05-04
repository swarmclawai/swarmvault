import path from "node:path";
import { loadVaultConfig } from "./config.js";
import { rebuildSearchIndex } from "./search.js";
import type { GraphArtifact, RetrievalConfig, RetrievalDoctorResult, RetrievalManifest, RetrievalStatus, VaultConfig } from "./types.js";
import { fileExists, readJsonFile, sha256, toPosix, writeJsonFile } from "./utils.js";

const DEFAULT_RETRIEVAL_SHARD_SIZE = 25000;

export function resolveRetrievalConfig(config: VaultConfig): RetrievalConfig {
  return {
    backend: "sqlite",
    shardSize: config.retrieval?.shardSize ?? DEFAULT_RETRIEVAL_SHARD_SIZE,
    hybrid: config.retrieval?.hybrid ?? config.search?.hybrid ?? true,
    rerank: config.retrieval?.rerank ?? config.search?.rerank ?? false,
    embeddingProvider: config.retrieval?.embeddingProvider ?? config.tasks.embeddingProvider,
    maxIndexedRows: config.retrieval?.maxIndexedRows
  };
}

function graphHash(graph: GraphArtifact): string {
  return sha256(
    JSON.stringify({
      generatedAt: graph.generatedAt,
      pages: graph.pages
        .map((page) => [page.id, page.path, page.kind, page.status, page.updatedAt, page.sourceIds, page.sourceHashes])
        .sort((left, right) => {
          return String(left[0]).localeCompare(String(right[0]));
        })
    })
  );
}

export async function writeRetrievalManifest(rootDir: string, graph: GraphArtifact): Promise<RetrievalManifest> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifest: RetrievalManifest = {
    version: 1,
    backend: "sqlite",
    generatedAt: new Date().toISOString(),
    graphGeneratedAt: graph.generatedAt,
    graphHash: graphHash(graph),
    shardCount: 1,
    shards: [
      {
        id: "fts-000",
        path: toPosix(path.relative(paths.stateDir, paths.searchDbPath)),
        pageCount: graph.pages.length
      }
    ]
  };
  await writeJsonFile(paths.retrievalManifestPath, manifest);
  return manifest;
}

export async function rebuildRetrievalIndex(rootDir: string): Promise<RetrievalStatus> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` before rebuilding retrieval.");
  }
  await rebuildSearchIndex(paths.searchDbPath, graph.pages, paths.wikiDir, { rootDir, stateDir: paths.stateDir });
  await writeRetrievalManifest(rootDir, graph);
  return getRetrievalStatus(rootDir);
}

export async function getRetrievalStatus(rootDir: string): Promise<RetrievalStatus> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const configured = resolveRetrievalConfig(config);
  const [manifest, graph, manifestExists, indexExists, graphExists] = await Promise.all([
    readJsonFile<RetrievalManifest>(paths.retrievalManifestPath).catch(() => null),
    readJsonFile<GraphArtifact>(paths.graphPath).catch(() => null),
    fileExists(paths.retrievalManifestPath),
    fileExists(paths.searchDbPath),
    fileExists(paths.graphPath)
  ]);
  const warnings: string[] = [];
  if (!graphExists) {
    warnings.push("Graph artifact is missing. Run `swarmvault compile`.");
  }
  if (!indexExists) {
    warnings.push("Retrieval index is missing. Run `swarmvault retrieval rebuild`.");
  }
  if (!manifestExists) {
    warnings.push("Retrieval manifest is missing. Run `swarmvault retrieval rebuild`.");
  }
  if (manifest && graph && manifest.graphHash !== graphHash(graph)) {
    warnings.push("Retrieval index is stale relative to the current graph.");
  }
  return {
    configured,
    manifestPath: paths.retrievalManifestPath,
    indexPath: paths.searchDbPath,
    manifestExists,
    indexExists,
    graphExists,
    stale: Boolean(manifest && graph && manifest.graphHash !== graphHash(graph)) || !manifestExists || !indexExists,
    pageCount: manifest?.shards.reduce((total, shard) => total + shard.pageCount, 0) ?? graph?.pages.length ?? 0,
    shardCount: manifest?.shardCount ?? 0,
    warnings
  };
}

export async function doctorRetrieval(rootDir: string, options: { repair?: boolean } = {}): Promise<RetrievalDoctorResult> {
  let status = await getRetrievalStatus(rootDir);
  const actions: string[] = [];
  let repaired = false;
  if (status.stale) {
    actions.push("rebuild");
    if (options.repair) {
      status = await rebuildRetrievalIndex(rootDir);
      repaired = true;
    }
  }
  return {
    status,
    ok: !status.stale && status.warnings.length === 0,
    repaired,
    actions
  };
}
