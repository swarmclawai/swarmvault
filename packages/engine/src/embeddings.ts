import fs from "node:fs/promises";
import path from "node:path";
import { loadVaultConfig } from "./config.js";
import { createProvider } from "./providers/registry.js";
import type {
  EmbeddingCacheArtifact,
  EmbeddingCacheEntry,
  GraphArtifact,
  GraphEdge,
  GraphNode,
  GraphPage,
  GraphQueryMatch,
  ProviderAdapter,
  SourceClass
} from "./types.js";
import { readJsonFile, sha256, uniqueBy, writeJsonFile } from "./utils.js";

type EmbeddableItem = {
  id: string;
  kind: "node" | "page" | "hyperedge";
  label: string;
  text: string;
  match: GraphQueryMatch;
};

const MAX_EMBEDDING_BATCH = 32;
const MAX_SIMILARITY_NODES = 240;

function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function appendIfMissing(parts: string[], value: string | undefined): void {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }
  if (!parts.includes(normalized)) {
    parts.push(normalized);
  }
}

async function loadPageContents(rootDir: string, graph: GraphArtifact): Promise<Map<string, string>> {
  const { paths } = await loadVaultConfig(rootDir);
  const contents = new Map<string, string>();

  await Promise.all(
    graph.pages.map(async (page) => {
      const absolutePath = path.join(paths.wikiDir, page.path);
      const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
      contents.set(page.id, content);
    })
  );

  return contents;
}

function itemTextForNode(node: GraphNode, graph: GraphArtifact, pageContents: Map<string, string>): string {
  const page = graph.pages.find((candidate) => candidate.id === node.pageId);
  const parts = [`node ${node.type}`, node.label];
  appendIfMissing(parts, node.sourceClass);
  appendIfMissing(parts, node.language);
  appendIfMissing(parts, page?.title);
  appendIfMissing(parts, page?.sourceType);
  appendIfMissing(parts, page?.sourceClass);
  if (page) {
    appendIfMissing(parts, pageContents.get(page.id)?.slice(0, 800));
  }
  return parts.join("\n");
}

function itemTextForPage(page: GraphPage, pageContents: Map<string, string>): string {
  const parts = [`page ${page.kind}`, page.title, page.path];
  appendIfMissing(parts, page.sourceType);
  appendIfMissing(parts, page.sourceClass);
  appendIfMissing(parts, pageContents.get(page.id)?.slice(0, 1200));
  return parts.join("\n");
}

function itemTextForHyperedge(graph: GraphArtifact, hyperedgeId: string): string {
  const hyperedge = graph.hyperedges.find((candidate) => candidate.id === hyperedgeId);
  if (!hyperedge) {
    return "";
  }
  const nodeLabels = hyperedge.nodeIds
    .map((nodeId) => graph.nodes.find((node) => node.id === nodeId)?.label)
    .filter((value): value is string => Boolean(value));
  return [hyperedge.label, hyperedge.relation, hyperedge.why, ...nodeLabels].join("\n");
}

async function buildEmbeddableItems(rootDir: string, graph: GraphArtifact): Promise<EmbeddableItem[]> {
  const pageContents = await loadPageContents(rootDir, graph);
  return uniqueBy(
    [
      ...graph.nodes.map(
        (node) =>
          ({
            id: node.id,
            kind: "node",
            label: node.label,
            text: itemTextForNode(node, graph, pageContents),
            match: {
              type: "node",
              id: node.id,
              label: node.label,
              score: 0
            }
          }) satisfies EmbeddableItem
      ),
      ...graph.pages.map(
        (page) =>
          ({
            id: page.id,
            kind: "page",
            label: page.title,
            text: itemTextForPage(page, pageContents),
            match: {
              type: "page",
              id: page.id,
              label: page.title,
              score: 0
            }
          }) satisfies EmbeddableItem
      ),
      ...(graph.hyperedges ?? []).map(
        (hyperedge) =>
          ({
            id: hyperedge.id,
            kind: "hyperedge",
            label: hyperedge.label,
            text: itemTextForHyperedge(graph, hyperedge.id),
            match: {
              type: "hyperedge",
              id: hyperedge.id,
              label: hyperedge.label,
              score: 0
            }
          }) satisfies EmbeddableItem
      )
    ],
    (item) => `${item.kind}:${item.id}`
  ).filter((item) => item.text.trim().length > 0);
}

async function resolveEmbeddingProvider(rootDir: string): Promise<ProviderAdapter | null> {
  const { config } = await loadVaultConfig(rootDir);
  const explicitProviderId = config.tasks.embeddingProvider;

  if (explicitProviderId) {
    const providerConfig = config.providers[explicitProviderId];
    if (!providerConfig) {
      throw new Error(`No provider configured with id "${explicitProviderId}" for task "embeddingProvider".`);
    }
    const provider = await createProvider(explicitProviderId, providerConfig, rootDir);
    if (!provider.capabilities.has("embeddings") || typeof provider.embedTexts !== "function") {
      throw new Error(`Provider ${provider.id} does not support required capability "embeddings".`);
    }
    return provider;
  }

  const queryProviderId = config.tasks.queryProvider;
  const queryProviderConfig = config.providers[queryProviderId];
  if (!queryProviderConfig) {
    return null;
  }
  const provider = await createProvider(queryProviderId, queryProviderConfig, rootDir);
  return provider.capabilities.has("embeddings") && typeof provider.embedTexts === "function" ? provider : null;
}

async function readEmbeddingCache(rootDir: string): Promise<{ artifact: EmbeddingCacheArtifact | null; provider: ProviderAdapter | null }> {
  const { paths } = await loadVaultConfig(rootDir);
  const provider = await resolveEmbeddingProvider(rootDir);
  if (!provider) {
    return { artifact: null, provider: null };
  }

  const cache = await readJsonFile<EmbeddingCacheArtifact>(paths.embeddingsPath);
  if (!cache || cache.providerId !== provider.id || cache.providerModel !== provider.model) {
    return { artifact: null, provider };
  }
  return { artifact: cache, provider };
}

async function writeEmbeddingCache(
  rootDir: string,
  provider: ProviderAdapter,
  graphHash: string,
  entries: EmbeddingCacheEntry[]
): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  await writeJsonFile(paths.embeddingsPath, {
    generatedAt: new Date().toISOString(),
    providerId: provider.id,
    providerModel: provider.model,
    graphHash,
    entries: entries.sort((left, right) => `${left.kind}:${left.itemId}`.localeCompare(`${right.kind}:${right.itemId}`))
  } satisfies EmbeddingCacheArtifact);
}

async function embedTexts(provider: ProviderAdapter, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let index = 0; index < texts.length; index += MAX_EMBEDDING_BATCH) {
    const batch = texts.slice(index, index + MAX_EMBEDDING_BATCH);
    const nextVectors = await provider.embedTexts!(batch);
    vectors.push(...nextVectors);
  }
  return vectors;
}

async function resolveVectorsForItems(
  rootDir: string,
  graphHash: string,
  items: EmbeddableItem[]
): Promise<{ provider: ProviderAdapter | null; vectors: Map<string, number[]> }> {
  const { artifact, provider } = await readEmbeddingCache(rootDir);
  if (!provider) {
    return { provider: null, vectors: new Map() };
  }

  const cachedByKey = new Map(
    (artifact?.entries ?? []).map((entry) => [`${entry.kind}:${entry.itemId}:${entry.contentHash}`, entry.values] as const)
  );
  const vectors = new Map<string, number[]>();
  const missing: EmbeddableItem[] = [];

  for (const item of items) {
    const contentHash = sha256(item.text);
    const cached = cachedByKey.get(`${item.kind}:${item.id}:${contentHash}`);
    if (cached?.length) {
      vectors.set(`${item.kind}:${item.id}`, cached);
    } else {
      missing.push(item);
    }
  }

  if (missing.length) {
    const nextVectors = await embedTexts(
      provider,
      missing.map((item) => item.text)
    );
    for (let index = 0; index < missing.length; index += 1) {
      vectors.set(`${missing[index].kind}:${missing[index].id}`, nextVectors[index] ?? []);
    }
  }

  await writeEmbeddingCache(
    rootDir,
    provider,
    graphHash,
    items.map((item) => ({
      itemId: item.id,
      kind: item.kind,
      label: item.label,
      contentHash: sha256(item.text),
      values: vectors.get(`${item.kind}:${item.id}`) ?? []
    }))
  );

  return { provider, vectors };
}

export async function semanticGraphMatches(
  rootDir: string,
  graph: GraphArtifact,
  question: string,
  limit = 12
): Promise<GraphQueryMatch[]> {
  const items = await buildEmbeddableItems(rootDir, graph);
  const { provider, vectors } = await resolveVectorsForItems(rootDir, graph.generatedAt, items);
  if (!provider) {
    return [];
  }

  const [queryVector] = await provider.embedTexts!([question]);
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
    return [];
  }

  return items
    .map((item) => ({
      ...item.match,
      score: Math.max(0, Number((cosineSimilarity(queryVector, vectors.get(`${item.kind}:${item.id}`) ?? []) * 100).toFixed(2)))
    }))
    .filter((match) => match.score >= 18)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function distinctScope(left: GraphNode, right: GraphNode): boolean {
  const leftSources = new Set(left.sourceIds);
  const rightSources = new Set(right.sourceIds);
  return (
    [...leftSources].some((sourceId) => !rightSources.has(sourceId)) || [...rightSources].some((sourceId) => !leftSources.has(sourceId))
  );
}

function nodePairKey(left: string, right: string): string {
  return [left, right].sort((a, b) => a.localeCompare(b)).join("|");
}

function similarityReasonsForNodes(left: GraphNode, right: GraphNode): GraphEdge["similarityReasons"] {
  const reasons = new Set<NonNullable<GraphEdge["similarityReasons"]>[number]>();
  if (left.sourceClass && right.sourceClass && left.sourceClass === right.sourceClass) {
    reasons.add("shared_tag");
  }
  if (left.language && right.language && left.language === right.language) {
    reasons.add("shared_symbol");
  }
  return [...reasons].sort((a, b) => a.localeCompare(b));
}

export async function embeddingSimilarityEdges(rootDir: string, graph: GraphArtifact): Promise<GraphEdge[]> {
  const candidateNodes = graph.nodes.filter(
    (node) => (node.type === "source" || node.type === "module" || node.type === "rationale") && node.sourceClass !== "generated"
  );
  if (candidateNodes.length < 2 || candidateNodes.length > MAX_SIMILARITY_NODES) {
    return [];
  }

  const items = candidateNodes.map(
    (node) =>
      ({
        id: node.id,
        kind: "node",
        label: node.label,
        text: [
          node.label,
          node.type,
          node.sourceClass ?? "",
          node.language ?? "",
          graph.pages.find((page) => page.id === node.pageId)?.title ?? ""
        ]
          .filter(Boolean)
          .join("\n"),
        match: { type: "node", id: node.id, label: node.label, score: 0 }
      }) satisfies EmbeddableItem
  );
  const { provider, vectors } = await resolveVectorsForItems(rootDir, graph.generatedAt, items);
  if (!provider) {
    return [];
  }

  const directPairs = new Set(graph.edges.map((edge) => nodePairKey(edge.source, edge.target)));
  const edges: GraphEdge[] = [];

  for (let leftIndex = 0; leftIndex < candidateNodes.length; leftIndex += 1) {
    const left = candidateNodes[leftIndex];
    const leftVector = vectors.get(`node:${left.id}`) ?? [];
    const candidates = candidateNodes
      .slice(leftIndex + 1)
      .filter((right) => distinctScope(left, right) && !directPairs.has(nodePairKey(left.id, right.id)))
      .map((right) => ({
        right,
        score: cosineSimilarity(leftVector, vectors.get(`node:${right.id}`) ?? [])
      }))
      .filter((candidate) => candidate.score >= 0.82)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    for (const candidate of candidates) {
      const right = candidate.right;
      const reasons = similarityReasonsForNodes(left, right) ?? [];
      edges.push({
        id: `similar-embed:${sha256(`${left.id}|${right.id}|${provider.id}`).slice(0, 16)}`,
        source: left.id,
        target: right.id,
        relation: "semantically_similar_to",
        status: "inferred",
        evidenceClass: "inferred",
        confidence: Number(candidate.score.toFixed(3)),
        provenance: uniqueBy(
          [...left.sourceIds, ...right.sourceIds].sort((a, b) => a.localeCompare(b)),
          (value) => value
        ),
        similarityReasons: reasons.length ? reasons : ["shared_tag"],
        similarityBasis: "embeddings"
      });
    }
  }

  return uniqueBy(edges, (edge) => edge.id).sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

export function sourceClassBreakdown(graph: GraphArtifact): Record<SourceClass, { sources: number; pages: number; nodes: number }> {
  return {
    first_party: {
      sources: graph.sources.filter((source) => source.sourceClass === "first_party").length,
      pages: graph.pages.filter((page) => page.sourceClass === "first_party").length,
      nodes: graph.nodes.filter((node) => node.sourceClass === "first_party").length
    },
    third_party: {
      sources: graph.sources.filter((source) => source.sourceClass === "third_party").length,
      pages: graph.pages.filter((page) => page.sourceClass === "third_party").length,
      nodes: graph.nodes.filter((node) => node.sourceClass === "third_party").length
    },
    resource: {
      sources: graph.sources.filter((source) => source.sourceClass === "resource").length,
      pages: graph.pages.filter((page) => page.sourceClass === "resource").length,
      nodes: graph.nodes.filter((node) => node.sourceClass === "resource").length
    },
    generated: {
      sources: graph.sources.filter((source) => source.sourceClass === "generated").length,
      pages: graph.pages.filter((page) => page.sourceClass === "generated").length,
      nodes: graph.nodes.filter((node) => node.sourceClass === "generated").length
    }
  };
}

export function filterGraphBySourceClass(graph: GraphArtifact, sourceClass: SourceClass): GraphArtifact {
  const nodeIds = new Set(graph.nodes.filter((node) => node.sourceClass === sourceClass).map((node) => node.id));
  const pageIds = new Set(graph.pages.filter((page) => page.sourceClass === sourceClass).map((page) => page.id));
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    hyperedges: graph.hyperedges.filter((hyperedge) => hyperedge.nodeIds.every((nodeId) => nodeIds.has(nodeId))),
    communities: (graph.communities ?? [])
      .map((community) => ({
        ...community,
        nodeIds: community.nodeIds.filter((nodeId) => nodeIds.has(nodeId))
      }))
      .filter((community) => community.nodeIds.length > 0),
    sources: graph.sources.filter((source) => source.sourceClass === sourceClass),
    pages: graph.pages.filter((page) => pageIds.has(page.id))
  };
}
