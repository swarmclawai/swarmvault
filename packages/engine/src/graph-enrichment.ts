import type { GraphArtifact, GraphEdge, GraphHyperedge, GraphNode, SourceAnalysis, SourceManifest } from "./types.js";
import { normalizeWhitespace, sha256, uniqueBy } from "./utils.js";

/**
 * Inputs the caller may supply to tune similarity scoring for large repos.
 * Both knobs are optional; defaults match the "small repo" behavior that
 * shipped before the large-repo defaults pass.
 */
export interface EnrichGraphOptions {
  /**
   * Minimum IDF weight a shared feature must carry to contribute to a
   * similarity score. Below this floor the feature is dropped entirely.
   * Defaults to 0.5.
   */
  similarityIdfFloor?: number;
  /**
   * Hard cap on the number of inferred similarity edges emitted. When more
   * candidate edges exist than the cap allows, the lowest-confidence edges
   * are dropped first. Defaults to Infinity (no cap).
   */
  similarityEdgeCap?: number;
}

const DEFAULT_SIMILARITY_IDF_FLOOR = 0.5;

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

/**
 * Base category weight — how much impact a single "supported" feature in
 * each category has before IDF weighting is applied. Category weights match
 * the old hand-tuned values so small-repo behavior stays stable while IDF
 * scaling prevents generic shared tokens from dominating large repos.
 */
const CATEGORY_BASE_WEIGHT: Record<SimilarityReason, number> = {
  shared_concept: 0.46,
  shared_entity: 0.34,
  shared_symbol: 0.24,
  shared_rationale_theme: 0.18,
  shared_source_type: 0.1,
  shared_tag: 0.12
};

/**
 * Build a `(reason, value) -> idf` map from the document-frequency table
 * shared across all nodes. `documentCount` must be the total number of
 * nodes that could, in principle, support any feature (i.e. the full
 * context count). Using `log((N + 1) / (df + 1)) + 1` keeps IDF positive
 * and avoids div-by-zero for rare features.
 */
function buildIdfTable(
  featureDocFrequency: Map<SimilarityReason, Map<string, number>>,
  documentCount: number
): Map<SimilarityReason, Map<string, number>> {
  const idf = new Map<SimilarityReason, Map<string, number>>();
  const safeDocCount = Math.max(1, documentCount);
  for (const [reason, values] of featureDocFrequency.entries()) {
    const inner = new Map<string, number>();
    for (const [value, df] of values.entries()) {
      inner.set(value, Math.log((safeDocCount + 1) / (df + 1)) + 1);
    }
    idf.set(reason, inner);
  }
  return idf;
}

/**
 * Score a pair's shared features using IDF-weighted overlap. Features with
 * IDF below `floor` are ignored so generic tokens (e.g. "javascript" seen
 * in most nodes) do not inflate similarity. Category structure (which
 * categories lit up) still contributes a small bonus to recognize breadth.
 */
function similarityScore(
  reasons: Map<SimilarityReason, Set<string>>,
  idfTable: Map<SimilarityReason, Map<string, number>>,
  floor: number
): number {
  let weighted = 0;
  let activeCategories = 0;
  for (const [reason, values] of reasons.entries()) {
    const idfByValue = idfTable.get(reason);
    let categoryContribution = 0;
    let hitCount = 0;
    for (const value of values) {
      const idfValue = idfByValue?.get(value) ?? 0;
      if (idfValue < floor) {
        continue;
      }
      hitCount++;
      const base = CATEGORY_BASE_WEIGHT[reason] ?? 0.1;
      // First hit in a category gets base weight scaled by IDF so rare
      // tokens contribute more than generic ones. Additional hits add a
      // smaller, IDF-scaled bonus capped at 0.12 to prevent runaway scores
      // from many repeated generic matches.
      if (hitCount === 1) {
        categoryContribution += Math.min(base * 2, base * idfValue);
      } else {
        categoryContribution += Math.min(0.12, 0.04 * idfValue);
      }
    }
    if (categoryContribution > 0) {
      weighted += categoryContribution;
      activeCategories++;
    }
  }
  const categoryBonus = activeCategories >= 3 ? 0.08 : activeCategories === 2 ? 0.04 : 0;
  return Math.min(0.96, weighted + categoryBonus);
}

/**
 * Filter a reasons map in place-style (returns a new map) so it only keeps
 * feature values whose IDF is at or above the floor. The pruned map drives
 * downstream serialization of `similarityReasons` on the emitted edge.
 */
function pruneReasonsByIdf(
  reasons: Map<SimilarityReason, Set<string>>,
  idfTable: Map<SimilarityReason, Map<string, number>>,
  floor: number
): Map<SimilarityReason, Set<string>> {
  const pruned = new Map<SimilarityReason, Set<string>>();
  for (const [reason, values] of reasons.entries()) {
    const idfByValue = idfTable.get(reason);
    const keep = new Set<string>();
    for (const value of values) {
      if ((idfByValue?.get(value) ?? 0) >= floor) {
        keep.add(value);
      }
    }
    if (keep.size > 0) {
      pruned.set(reason, keep);
    }
  }
  return pruned;
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
  analyses: SourceAnalysis[],
  options?: EnrichGraphOptions
): GraphEdge[] {
  const idfFloor = options?.similarityIdfFloor ?? DEFAULT_SIMILARITY_IDF_FLOOR;
  const similarityEdgeCap = Math.max(0, options?.similarityEdgeCap ?? Number.POSITIVE_INFINITY);
  const contexts = nodeContexts(nodes, manifests, analyses);
  const contextsById = new Map(contexts.map((context) => [context.node.id, context]));
  const directPairs = new Set(edges.map((edge) => pairKey(edge.source, edge.target)));
  const pairReasons = new Map<string, Map<SimilarityReason, Set<string>>>();

  /**
   * Document frequency: how many contexts contain each (reason, value)
   * feature. Used to derive IDF weights so generic tokens contribute less
   * than rare ones. Counting per-context matches the "documents" analogy
   * used in classic TF-IDF.
   */
  const featureDocFrequency = new Map<SimilarityReason, Map<string, number>>();
  for (const context of contexts) {
    for (const [reason, values] of context.featureValues.entries()) {
      let inner = featureDocFrequency.get(reason);
      if (!inner) {
        inner = new Map<string, number>();
        featureDocFrequency.set(reason, inner);
      }
      for (const value of values) {
        inner.set(value, (inner.get(value) ?? 0) + 1);
      }
    }
  }
  const idfTable = buildIdfTable(featureDocFrequency, contexts.length);

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

  const candidates = [...pairReasons.entries()]
    .flatMap(([key, reasons]) => {
      const [leftId, rightId] = key.split("|");
      const left = contextsById.get(leftId)?.node;
      const right = contextsById.get(rightId)?.node;
      if (!left || !right) {
        return [];
      }
      // Prune below-floor features before we score so the reasons list
      // that ships on the edge matches the features that actually
      // contributed to the confidence number.
      const prunedReasons = pruneReasonsByIdf(reasons, idfTable, idfFloor);
      if (prunedReasons.size === 0) {
        return [];
      }
      const confidence = similarityScore(prunedReasons, idfTable, idfFloor);
      if (confidence < 0.5) {
        return [];
      }
      return [
        {
          id: `similar:${sha256(`${left.id}|${right.id}|${[...prunedReasons.keys()].sort().join(",")}`).slice(0, 16)}`,
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
          similarityReasons: [...prunedReasons.keys()].sort((a, b) => a.localeCompare(b)),
          similarityBasis: "feature_overlap" as const
        }
      ];
    })
    .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));

  if (candidates.length > similarityEdgeCap) {
    return candidates.slice(0, similarityEdgeCap);
  }
  return candidates;
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
  extraSimilarityEdges: GraphEdge[] = [],
  options?: EnrichGraphOptions
): Pick<GraphArtifact, "edges" | "hyperedges"> {
  const similarityEdges = buildSemanticSimilarityEdges(graph.nodes, graph.edges, manifests, analyses, options);
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
