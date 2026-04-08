import type { GraphArtifact, GraphEdge, GraphHyperedge, GraphNode, SourceAnalysis, SourceManifest } from "./types.js";
import { normalizeWhitespace, sha256, uniqueBy } from "./utils.js";

type SimilarityReason = NonNullable<GraphEdge["similarityReasons"]>[number];

type NodeContext = {
  node: GraphNode;
  featureValues: Map<SimilarityReason, Set<string>>;
};

const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "among",
  "and",
  "around",
  "because",
  "been",
  "being",
  "between",
  "both",
  "does",
  "from",
  "into",
  "just",
  "like",
  "many",
  "more",
  "most",
  "much",
  "note",
  "only",
  "other",
  "over",
  "same",
  "such",
  "than",
  "that",
  "their",
  "them",
  "there",
  "these",
  "this",
  "through",
  "under",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your"
]);

function normalizeValue(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function addFeature(bucket: Map<SimilarityReason, Set<string>>, reason: SimilarityReason, value: string | undefined): void {
  if (!value) {
    return;
  }
  const normalized = normalizeValue(value);
  if (!normalized) {
    return;
  }
  if (!bucket.has(reason)) {
    bucket.set(reason, new Set());
  }
  bucket.get(reason)?.add(normalized);
}

function themeTokens(value: string): string[] {
  return uniqueBy(
    normalizeValue(value)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 4 && !STOPWORDS.has(token)),
    (token) => token
  ).slice(0, 6);
}

function pairKey(left: string, right: string): string {
  return [left, right].sort((a, b) => a.localeCompare(b)).join("|");
}

function hasDistinctScope(left: GraphNode, right: GraphNode): boolean {
  if (left.pageId && right.pageId && left.pageId !== right.pageId) {
    return true;
  }
  const leftSources = new Set(left.sourceIds);
  const rightSources = new Set(right.sourceIds);
  const leftOnly = [...leftSources].some((sourceId) => !rightSources.has(sourceId));
  const rightOnly = [...rightSources].some((sourceId) => !leftSources.has(sourceId));
  return leftOnly || rightOnly;
}

function supportCount(values: Set<string> | undefined): number {
  return values?.size ?? 0;
}

function similarityScore(reasons: Map<SimilarityReason, Set<string>>): number {
  const concept = supportCount(reasons.get("shared_concept"));
  const entity = supportCount(reasons.get("shared_entity"));
  const symbol = supportCount(reasons.get("shared_symbol"));
  const rationale = supportCount(reasons.get("shared_rationale_theme"));
  const sourceType = supportCount(reasons.get("shared_source_type"));
  const tag = supportCount(reasons.get("shared_tag"));
  const categoryCount = [...reasons.keys()].length;
  const weighted =
    (concept ? 0.46 + Math.min(0.12, (concept - 1) * 0.04) : 0) +
    (entity ? 0.34 + Math.min(0.1, (entity - 1) * 0.03) : 0) +
    (symbol ? 0.24 + Math.min(0.08, (symbol - 1) * 0.02) : 0) +
    (rationale ? 0.18 + Math.min(0.08, (rationale - 1) * 0.03) : 0) +
    (sourceType ? 0.1 : 0) +
    (tag ? 0.12 + Math.min(0.04, (tag - 1) * 0.02) : 0);
  const categoryBonus = categoryCount >= 3 ? 0.08 : categoryCount === 2 ? 0.04 : 0;
  return Math.min(0.96, weighted + categoryBonus);
}

export function describeSimilarityReasons(reasons: SimilarityReason[] | undefined): string {
  if (!reasons?.length) {
    return "This link is inferred from multiple shared graph features.";
  }
  const labels = reasons.map((reason) =>
    reason === "shared_concept"
      ? "shared concepts"
      : reason === "shared_entity"
        ? "shared entities"
        : reason === "shared_symbol"
          ? "shared symbols"
          : reason === "shared_rationale_theme"
            ? "shared rationale themes"
            : reason === "shared_source_type"
              ? "shared source type"
              : "shared tags"
  );
  return `This link is inferred from ${labels.join(", ")}.`;
}

function nodeContexts(nodes: GraphNode[], manifests: SourceManifest[], analyses: SourceAnalysis[]): NodeContext[] {
  const manifestsBySourceId = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  const analysesBySourceId = new Map(analyses.map((analysis) => [analysis.sourceId, analysis]));

  return nodes
    .filter((node) => node.type !== "symbol" && node.type !== "concept" && node.type !== "entity")
    .map((node) => {
      const features = new Map<SimilarityReason, Set<string>>();

      if (node.type === "source" || node.type === "module") {
        for (const sourceId of node.sourceIds) {
          const analysis = analysesBySourceId.get(sourceId);
          const manifest = manifestsBySourceId.get(sourceId);
          if (!analysis) {
            continue;
          }
          for (const concept of analysis.concepts) {
            addFeature(features, "shared_concept", concept.name);
          }
          for (const entity of analysis.entities) {
            addFeature(features, "shared_entity", entity.name);
          }
          if (manifest?.sourceType) {
            addFeature(features, "shared_source_type", manifest.sourceType);
          }
          if (analysis.code) {
            const exportedSymbols = analysis.code.symbols.filter((symbol) => symbol.exported);
            for (const symbol of (exportedSymbols.length ? exportedSymbols : analysis.code.symbols).slice(0, 12)) {
              addFeature(features, "shared_symbol", symbol.name);
            }
          }
          for (const rationale of analysis.rationales) {
            for (const token of themeTokens(rationale.text)) {
              addFeature(features, "shared_rationale_theme", token);
            }
          }
        }
      } else if (node.type === "rationale") {
        for (const sourceId of node.sourceIds) {
          const analysis = analysesBySourceId.get(sourceId);
          const manifest = manifestsBySourceId.get(sourceId);
          if (manifest?.sourceType) {
            addFeature(features, "shared_source_type", manifest.sourceType);
          }
          const rationale = analysis?.rationales.find((item) => item.id === node.id);
          for (const token of themeTokens(rationale?.text ?? node.label)) {
            addFeature(features, "shared_rationale_theme", token);
          }
        }
      }

      return { node, featureValues: features };
    })
    .filter((context) => context.featureValues.size > 0);
}

function buildSemanticSimilarityEdges(
  nodes: GraphNode[],
  edges: GraphEdge[],
  manifests: SourceManifest[],
  analyses: SourceAnalysis[]
): GraphEdge[] {
  const contexts = nodeContexts(nodes, manifests, analyses);
  const contextsById = new Map(contexts.map((context) => [context.node.id, context]));
  const directPairs = new Set(edges.map((edge) => pairKey(edge.source, edge.target)));
  const pairReasons = new Map<string, Map<SimilarityReason, Set<string>>>();

  for (const reason of ["shared_concept", "shared_entity", "shared_symbol", "shared_rationale_theme", "shared_source_type"] as const) {
    const buckets = new Map<string, string[]>();
    for (const context of contexts) {
      for (const value of context.featureValues.get(reason) ?? []) {
        const bucketId = `${context.node.type}:${reason}:${value}`;
        if (!buckets.has(bucketId)) {
          buckets.set(bucketId, []);
        }
        buckets.get(bucketId)?.push(context.node.id);
      }
    }

    for (const [bucketId, nodeIds] of buckets.entries()) {
      if (nodeIds.length < 2) {
        continue;
      }
      const value = bucketId.slice(bucketId.indexOf(`${reason}:`) + `${reason}:`.length);
      const uniqueNodeIds = uniqueBy(nodeIds, (nodeId) => nodeId).sort((left, right) => left.localeCompare(right));
      for (let index = 0; index < uniqueNodeIds.length; index++) {
        const left = contextsById.get(uniqueNodeIds[index]);
        if (!left) {
          continue;
        }
        for (let cursor = index + 1; cursor < uniqueNodeIds.length; cursor++) {
          const right = contextsById.get(uniqueNodeIds[cursor]);
          if (!right || !hasDistinctScope(left.node, right.node)) {
            continue;
          }
          const key = pairKey(left.node.id, right.node.id);
          if (directPairs.has(key)) {
            continue;
          }
          if (!pairReasons.has(key)) {
            pairReasons.set(key, new Map());
          }
          if (!pairReasons.get(key)?.has(reason)) {
            pairReasons.get(key)?.set(reason, new Set());
          }
          pairReasons.get(key)?.get(reason)?.add(value);
        }
      }
    }
  }

  return [...pairReasons.entries()]
    .flatMap(([key, reasons]) => {
      const [leftId, rightId] = key.split("|");
      const left = contextsById.get(leftId)?.node;
      const right = contextsById.get(rightId)?.node;
      if (!left || !right) {
        return [];
      }
      const confidence = similarityScore(reasons);
      if (confidence < 0.5) {
        return [];
      }
      return [
        {
          id: `similar:${sha256(`${left.id}|${right.id}|${[...reasons.keys()].sort().join(",")}`).slice(0, 16)}`,
          source: left.id,
          target: right.id,
          relation: "semantically_similar_to",
          status: "inferred" as const,
          evidenceClass: "inferred" as const,
          confidence,
          provenance: uniqueBy(
            [...left.sourceIds, ...right.sourceIds].sort((a, b) => a.localeCompare(b)),
            (value) => value
          ),
          similarityReasons: [...reasons.keys()].sort((a, b) => a.localeCompare(b)),
          similarityBasis: "feature_overlap" as const
        }
      ];
    })
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

function buildTopicHyperedges(graph: GraphArtifact): GraphHyperedge[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const connectedSources = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.relation !== "mentions" || edge.evidenceClass !== "extracted") {
      continue;
    }
    const sourceNode = nodesById.get(edge.source);
    const targetNode = nodesById.get(edge.target);
    if (sourceNode?.type !== "source" || !(targetNode?.type === "concept" || targetNode?.type === "entity")) {
      continue;
    }
    if (!connectedSources.has(targetNode.id)) {
      connectedSources.set(targetNode.id, []);
    }
    connectedSources.get(targetNode.id)?.push(sourceNode.id);
  }

  return [...connectedSources.entries()].flatMap(([anchorId, members]) => {
    const anchor = nodesById.get(anchorId);
    const uniqueMembers = uniqueBy(members, (member) => member).sort((left, right) => left.localeCompare(right));
    if (!anchor || uniqueMembers.length < 3) {
      return [];
    }
    const nodeIds = [anchor.id, ...uniqueMembers];
    const sourcePageIds = uniqueBy(nodeIds.map((nodeId) => nodesById.get(nodeId)?.pageId ?? "").filter(Boolean), (value) => value);
    return [
      {
        id: `hyper:${sha256(`participate_in|${anchor.id}|${uniqueMembers.join("|")}`).slice(0, 16)}`,
        label: anchor.label,
        relation: "participate_in" as const,
        nodeIds,
        evidenceClass: "extracted" as const,
        confidence: Math.min(0.96, 0.72 + uniqueMembers.length * 0.06),
        sourcePageIds,
        why: `${uniqueMembers.length} source nodes converge on ${anchor.label} through extracted mention edges.`
      }
    ];
  });
}

function buildModuleFormHyperedges(graph: GraphArtifact): GraphHyperedge[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const definedSymbols = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.relation !== "defines" || edge.evidenceClass !== "extracted") {
      continue;
    }
    const moduleNode = nodesById.get(edge.source);
    const symbolNode = nodesById.get(edge.target);
    if (moduleNode?.type !== "module" || symbolNode?.type !== "symbol") {
      continue;
    }
    if (!definedSymbols.has(moduleNode.id)) {
      definedSymbols.set(moduleNode.id, []);
    }
    definedSymbols.get(moduleNode.id)?.push(symbolNode.id);
  }

  return [...definedSymbols.entries()].flatMap(([moduleId, members]) => {
    const moduleNode = nodesById.get(moduleId);
    const uniqueMembers = uniqueBy(members, (member) => member).sort((left, right) => left.localeCompare(right));
    if (!moduleNode || uniqueMembers.length < 3) {
      return [];
    }
    const nodeIds = [moduleNode.id, ...uniqueMembers];
    const sourcePageIds = uniqueBy(nodeIds.map((nodeId) => nodesById.get(nodeId)?.pageId ?? "").filter(Boolean), (value) => value);
    return [
      {
        id: `hyper:${sha256(`form|${moduleNode.id}|${uniqueMembers.join("|")}`).slice(0, 16)}`,
        label: `${moduleNode.label} API`,
        relation: "form" as const,
        nodeIds,
        evidenceClass: "extracted" as const,
        confidence: Math.min(0.98, 0.78 + uniqueMembers.length * 0.04),
        sourcePageIds,
        why: `${moduleNode.label} and ${uniqueMembers.length} defined symbols form one local module surface.`
      }
    ];
  });
}

export function enrichGraph(
  graph: Omit<GraphArtifact, "hyperedges">,
  manifests: SourceManifest[],
  analyses: SourceAnalysis[],
  extraSimilarityEdges: GraphEdge[] = []
): Pick<GraphArtifact, "edges" | "hyperedges"> {
  const similarityEdges = buildSemanticSimilarityEdges(graph.nodes, graph.edges, manifests, analyses);
  const enrichedEdges = uniqueBy([...graph.edges, ...similarityEdges, ...extraSimilarityEdges], (edge) => edge.id).sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const hyperedges = uniqueBy(
    [
      ...buildTopicHyperedges({ ...graph, edges: enrichedEdges, hyperedges: [] }),
      ...buildModuleFormHyperedges({ ...graph, edges: enrichedEdges, hyperedges: [] })
    ].sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label)),
    (hyperedge) => hyperedge.id
  );

  return {
    edges: enrichedEdges,
    hyperedges
  };
}
