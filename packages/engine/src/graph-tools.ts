import {
  coreGraphFilterSummaryLines,
  filterCoreGraphForQuery,
  normalizeCoreGraphQueryFilters,
  runCoreGraphExplain,
  runCoreGraphPath
} from "./graph-query-core.js";
import type {
  BlastRadiusResult,
  EvidenceClass,
  GraphArtifact,
  GraphDiffResult,
  GraphEdge,
  GraphExplainNeighbor,
  GraphExplainResult,
  GraphHyperedge,
  GraphNode,
  GraphPage,
  GraphPathResult,
  GraphQueryFilters,
  GraphQueryMatch,
  GraphQueryResult,
  GraphStatsResult,
  GraphValidationIssue,
  GraphValidationResult,
  SearchResult
} from "./types.js";
import { normalizeWhitespace, uniqueBy } from "./utils.js";

function normalizeTarget(value: string): string {
  // NFKD strips diacritics (e.g. "Café" → "Cafe"), then we drop combining marks,
  // so graph query/path/explain can match labels regardless of accent marks.
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase();
}

/** Precomputed diacritic-insensitive label for graph-time lookups. */
export function computeNormLabel(label: string): string {
  return normalizeTarget(label);
}

function nodeById(graph: GraphArtifact): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function pageById(graph: GraphArtifact): Map<string, GraphPage> {
  return new Map(graph.pages.map((page) => [page.id, page]));
}

function hyperedgesForNode(graph: GraphArtifact, nodeId: string): GraphHyperedge[] {
  return (graph.hyperedges ?? [])
    .filter((hyperedge) => hyperedge.nodeIds.includes(nodeId))
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
}

function scoreMatch(query: string, candidate: string): number {
  const normalizedQuery = normalizeTarget(query);
  const normalizedCandidate = normalizeTarget(candidate);
  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }
  if (normalizedCandidate === normalizedQuery) {
    return 100;
  }
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 80;
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    return 60;
  }
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const candidateTokens = new Set(normalizedCandidate.split(/\s+/).filter(Boolean));
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
  return overlap ? overlap * 10 : 0;
}

function primaryNodeForPage(graph: GraphArtifact, page: GraphPage): GraphNode | undefined {
  const byId = nodeById(graph);
  return page.nodeIds.map((nodeId) => byId.get(nodeId)).find((node): node is GraphNode => Boolean(node));
}

function pageSearchMatches(graph: GraphArtifact, question: string, searchResults: SearchResult[]): GraphQueryMatch[] {
  const pages = pageById(graph);
  return searchResults
    .map((result) => {
      const page = pages.get(result.pageId);
      const score = Math.max(scoreMatch(question, result.title), scoreMatch(question, result.path));
      if (!page || score <= 0) {
        return null;
      }
      return {
        type: "page" as const,
        id: page.id,
        label: page.title,
        score
      };
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match));
}

function nodeMatches(graph: GraphArtifact, query: string): GraphQueryMatch[] {
  return graph.nodes
    .map((node) => ({
      type: "node" as const,
      id: node.id,
      label: node.label,
      score: Math.max(scoreMatch(query, node.label), scoreMatch(query, node.id))
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

function hyperedgeMatches(graph: GraphArtifact, query: string): GraphQueryMatch[] {
  return (graph.hyperedges ?? [])
    .map((hyperedge) => ({
      type: "hyperedge" as const,
      id: hyperedge.id,
      label: hyperedge.label,
      score: Math.max(scoreMatch(query, hyperedge.label), scoreMatch(query, hyperedge.why), scoreMatch(query, hyperedge.relation))
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

type EdgeNeighbor = {
  edge: GraphEdge;
  nodeId: string;
  direction: "incoming" | "outgoing";
};

function graphAdjacency(graph: GraphArtifact): Map<string, EdgeNeighbor[]> {
  const adjacency = new Map<string, EdgeNeighbor[]>();
  const push = (nodeId: string, item: EdgeNeighbor) => {
    if (!adjacency.has(nodeId)) {
      adjacency.set(nodeId, []);
    }
    adjacency.get(nodeId)?.push(item);
  };

  for (const edge of graph.edges) {
    push(edge.source, { edge, nodeId: edge.target, direction: "outgoing" });
    push(edge.target, { edge, nodeId: edge.source, direction: "incoming" });
  }

  for (const [nodeId, items] of adjacency.entries()) {
    items.sort((left, right) => right.edge.confidence - left.edge.confidence || left.edge.relation.localeCompare(right.edge.relation));
    adjacency.set(nodeId, items);
  }
  return adjacency;
}

const NODE_TYPE_PRIORITY: Record<string, number> = {
  concept: 6,
  entity: 5,
  source: 4,
  module: 3,
  symbol: 2,
  rationale: 1
};

function nodeTypePriority(type: string): number {
  return NODE_TYPE_PRIORITY[type] ?? 0;
}

function compareLabelCandidates(left: GraphNode, right: GraphNode): number {
  const priorityDelta = nodeTypePriority(right.type) - nodeTypePriority(left.type);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const degreeDelta = (right.degree ?? 0) - (left.degree ?? 0);
  if (degreeDelta !== 0) {
    return degreeDelta;
  }
  return left.id.localeCompare(right.id);
}

function resolveNode(graph: GraphArtifact, target: string): GraphNode | undefined {
  const normalized = normalizeTarget(target);
  const byId = nodeById(graph);
  if (byId.has(target)) {
    return byId.get(target);
  }

  // Prefer the most central node when multiple share a label. Previously the
  // resolver returned the first match, which silently picked leaf nodes over
  // hub concepts and broke graph path/explain on ambiguous labels.
  const labelMatches = graph.nodes.filter((node) => normalizeTarget(node.label) === normalized || normalizeTarget(node.id) === normalized);
  if (labelMatches.length) {
    return labelMatches.sort(compareLabelCandidates)[0];
  }

  const pages = graph.pages
    .map((page) => ({
      page,
      score: Math.max(scoreMatch(target, page.title), scoreMatch(target, page.path))
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.title.localeCompare(right.page.title));
  if (pages[0]) {
    return primaryNodeForPage(graph, pages[0].page);
  }

  return graph.nodes
    .map((node) => ({ node, score: Math.max(scoreMatch(target, node.label), scoreMatch(target, node.id)) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareLabelCandidates(left.node, right.node))[0]?.node;
}

export function evidenceClassForStatus(status: GraphEdge["status"]): EvidenceClass {
  if (status === "conflicted") {
    return "ambiguous";
  }
  if (status === "inferred" || status === "stale") {
    return "inferred";
  }
  return "extracted";
}

export function queryGraph(
  graph: GraphArtifact,
  question: string,
  searchResults: SearchResult[],
  options?: {
    traversal?: "bfs" | "dfs";
    budget?: number;
    semanticMatches?: GraphQueryMatch[];
    filters?: GraphQueryFilters;
  }
): GraphQueryResult {
  const traversal = options?.traversal ?? "bfs";
  const budget = Math.max(3, Math.min(options?.budget ?? 12, 50));
  const normalizedFilters = normalizeCoreGraphQueryFilters(options?.filters) as GraphQueryFilters | undefined;
  const filtered = filterCoreGraphForQuery(graph, normalizedFilters);
  const queryGraph = filtered.graph as GraphArtifact;
  const filteredNodeIds = new Set(queryGraph.nodes.map((node) => node.id));
  const filteredPageIds = new Set(queryGraph.pages.map((page) => page.id));
  const filteredHyperedgeIds = new Set((queryGraph.hyperedges ?? []).map((hyperedge) => hyperedge.id));
  const semanticMatches = (options?.semanticMatches ?? []).filter((match) => {
    if (match.type === "node") return filteredNodeIds.has(match.id);
    if (match.type === "page") return filteredPageIds.has(match.id);
    return filteredHyperedgeIds.has(match.id);
  });
  const matches = uniqueBy(
    [
      ...semanticMatches,
      ...pageSearchMatches(queryGraph, question, searchResults),
      ...nodeMatches(queryGraph, question),
      ...hyperedgeMatches(queryGraph, question)
    ],
    (match) => `${match.type}:${match.id}`
  )
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 12);
  const pages = pageById(queryGraph);
  const seeds = uniqueBy(
    [
      ...searchResults.flatMap((result) => pages.get(result.pageId)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "page").flatMap((match) => pages.get(match.id)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "node").map((match) => match.id),
      ...matches
        .filter((match) => match.type === "hyperedge")
        .flatMap((match) => queryGraph.hyperedges.find((hyperedge) => hyperedge.id === match.id)?.nodeIds ?? [])
    ],
    (item) => item
  ).filter(Boolean);

  const adjacency = graphAdjacency(queryGraph);
  const visitedNodeIds: string[] = [];
  const visitedEdgeIds = new Set<string>();
  const seen = new Set<string>();
  const frontier = [...seeds];

  while (frontier.length && visitedNodeIds.length < budget) {
    const current = traversal === "dfs" ? frontier.pop() : frontier.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    visitedNodeIds.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      visitedEdgeIds.add(neighbor.edge.id);
      if (!seen.has(neighbor.nodeId)) {
        frontier.push(neighbor.nodeId);
      }
      if (visitedNodeIds.length + frontier.length >= budget * 2) {
        break;
      }
    }
  }

  const nodes = nodeById(queryGraph);
  const pageIds = uniqueBy(
    [
      ...searchResults.map((result) => result.pageId),
      ...matches.filter((match) => match.type === "page").map((match) => match.id),
      ...visitedNodeIds.flatMap((nodeId) => {
        const node = nodes.get(nodeId);
        return node?.pageId ? [node.pageId] : [];
      })
    ],
    (item) => item
  );
  const communities = uniqueBy(
    visitedNodeIds.map((nodeId) => nodes.get(nodeId)?.communityId).filter((communityId): communityId is string => Boolean(communityId)),
    (item) => item
  );
  const hyperedgeIds = uniqueBy(
    (queryGraph.hyperedges ?? [])
      .filter((hyperedge) => hyperedge.nodeIds.some((nodeId) => visitedNodeIds.includes(nodeId)))
      .map((hyperedge) => hyperedge.id),
    (item) => item
  );

  return {
    question,
    traversal,
    seedNodeIds: seeds,
    seedPageIds: uniqueBy(
      [...searchResults.map((result) => result.pageId), ...matches.filter((match) => match.type === "page").map((match) => match.id)],
      (item) => item
    ),
    visitedNodeIds,
    visitedEdgeIds: [...visitedEdgeIds],
    hyperedgeIds,
    pageIds,
    communities,
    matches,
    summary: [
      `Seeds: ${seeds.join(", ") || "none"}`,
      `Visited nodes: ${visitedNodeIds.length}`,
      `Visited edges: ${visitedEdgeIds.size}`,
      ...coreGraphFilterSummaryLines(normalizedFilters, filtered.stats),
      `Touched group patterns: ${hyperedgeIds.length}`,
      `Communities: ${communities.join(", ") || "none"}`,
      `Pages: ${pageIds.join(", ") || "none"}`
    ].join("\n"),
    filters: normalizedFilters,
    filterStats: filtered.stats
  };
}

export function shortestGraphPath(graph: GraphArtifact, from: string, to: string): GraphPathResult {
  // The path walker is pure adjacency BFS, so we delegate to the shared core
  // module. The standalone exported HTML embeds an equivalent JS copy of
  // `runCoreGraphPath` so offline users see the same traversal.
  return runCoreGraphPath(graph, from, to);
}

export function explainGraphTarget(graph: GraphArtifact, target: string): GraphExplainResult {
  // The explain walker is pure adjacency traversal plus community/hyperedge
  // lookups, so we delegate to the shared core module. The standalone export
  // embeds an equivalent JS copy of `runCoreGraphExplain`.
  const result = runCoreGraphExplain(graph, target);
  if (!result) {
    throw new Error(`Could not resolve graph target: ${target}`);
  }
  // The core helper returns a minimal shape typed against `CoreGraph`. Up at
  // the server/MCP surface we hand back the richer `GraphExplainResult` which
  // re-uses the full `GraphNode`/`GraphPage` values already present in the
  // vault graph — the core result is structurally compatible because the
  // core types are subsets of the public graph types.
  const nodes = nodeById(graph);
  const node = nodes.get(result.node.id) ?? (result.node as GraphNode);
  const page = node.pageId ? pageById(graph).get(node.pageId) : undefined;
  const neighbors: GraphExplainNeighbor[] = result.neighbors.map((neighbor) => ({
    ...neighbor,
    type: (nodes.get(neighbor.nodeId)?.type ?? neighbor.type) as GraphNode["type"],
    evidenceClass: neighbor.evidenceClass as EvidenceClass
  }));
  return {
    target,
    node,
    page,
    community: result.community,
    neighbors,
    hyperedges: hyperedgesForNode(graph, node.id),
    summary: result.summary
  };
}

export function topGodNodes(graph: GraphArtifact, limit = 10): GraphNode[] {
  return graph.nodes
    .filter((node) => node.isGodNode)
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0))
    .slice(0, limit);
}

function incrementCount(record: Record<string, number>, key: string | undefined): void {
  if (!key) {
    return;
  }
  record[key] = (record[key] ?? 0) + 1;
}

export function graphStats(graph: GraphArtifact): GraphStatsResult {
  const sourceClasses = {
    first_party: { sources: 0, pages: 0, nodes: 0 },
    third_party: { sources: 0, pages: 0, nodes: 0 },
    resource: { sources: 0, pages: 0, nodes: 0 },
    generated: { sources: 0, pages: 0, nodes: 0 }
  } satisfies GraphStatsResult["sourceClasses"];
  const nodeTypes: GraphStatsResult["nodeTypes"] = {};
  const evidenceClasses: GraphStatsResult["evidenceClasses"] = {};
  const edgeRelations: Record<string, number> = {};
  const hyperedgeRelations: Record<string, number> = {};

  for (const source of graph.sources) {
    sourceClasses[source.sourceClass ?? "first_party"].sources += 1;
  }
  for (const page of graph.pages) {
    sourceClasses[page.sourceClass ?? "first_party"].pages += 1;
  }
  for (const node of graph.nodes) {
    nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
    sourceClasses[node.sourceClass ?? "first_party"].nodes += 1;
  }
  for (const edge of graph.edges) {
    incrementCount(edgeRelations, edge.relation);
    evidenceClasses[edge.evidenceClass] = (evidenceClasses[edge.evidenceClass] ?? 0) + 1;
  }
  for (const hyperedge of graph.hyperedges ?? []) {
    incrementCount(hyperedgeRelations, hyperedge.relation);
    evidenceClasses[hyperedge.evidenceClass] = (evidenceClasses[hyperedge.evidenceClass] ?? 0) + 1;
  }

  return {
    generatedAt: graph.generatedAt,
    counts: {
      sources: graph.sources.length,
      pages: graph.pages.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      hyperedges: (graph.hyperedges ?? []).length,
      communities: graph.communities?.length ?? 0
    },
    nodeTypes,
    evidenceClasses,
    sourceClasses,
    edgeRelations,
    hyperedgeRelations
  };
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function pushIssue(issues: GraphValidationIssue[], issue: GraphValidationIssue): void {
  issues.push(issue);
}

function validateDuplicateIds(issues: GraphValidationIssue[], label: string, ids: string[], pathPrefix: string): void {
  for (const id of duplicateValues(ids)) {
    pushIssue(issues, {
      severity: "error",
      code: "duplicate_id",
      message: `Duplicate ${label} id: ${id}`,
      path: pathPrefix,
      id
    });
  }
}

function validateConfidence(issues: GraphValidationIssue[], confidence: number | undefined, path: string, id: string, label: string): void {
  if (confidence === undefined) {
    return;
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    pushIssue(issues, {
      severity: "error",
      code: "invalid_confidence",
      message: `${label} confidence must be between 0 and 1.`,
      path,
      id
    });
  }
}

function summarizeValidation(ok: boolean, errorCount: number, warningCount: number, counts: GraphStatsResult["counts"]): string {
  const issueText = `${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
  const graphText = `${counts.nodes} nodes, ${counts.edges} edges, ${counts.pages} pages`;
  return ok ? `Graph valid (${graphText}; ${issueText}).` : `Graph invalid (${graphText}; ${issueText}).`;
}

export function validateGraphArtifact(graph: GraphArtifact, options: { strict?: boolean } = {}): GraphValidationResult {
  const strict = options.strict === true;
  const issues: GraphValidationIssue[] = [];
  const stats = graphStats(graph);
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const pageIds = new Set(graph.pages.map((page) => page.id));
  const sourceIds = new Set(graph.sources.map((source) => source.sourceId));

  validateDuplicateIds(
    issues,
    "source",
    graph.sources.map((source) => source.sourceId),
    "sources"
  );
  validateDuplicateIds(
    issues,
    "page",
    graph.pages.map((page) => page.id),
    "pages"
  );
  validateDuplicateIds(
    issues,
    "node",
    graph.nodes.map((node) => node.id),
    "nodes"
  );
  validateDuplicateIds(
    issues,
    "edge",
    graph.edges.map((edge) => edge.id),
    "edges"
  );
  validateDuplicateIds(
    issues,
    "hyperedge",
    (graph.hyperedges ?? []).map((hyperedge) => hyperedge.id),
    "hyperedges"
  );
  validateDuplicateIds(
    issues,
    "community",
    (graph.communities ?? []).map((community) => community.id),
    "communities"
  );

  for (const node of graph.nodes) {
    const nodePath = `nodes.${node.id}`;
    validateConfidence(issues, node.confidence, nodePath, node.id, "Node");
    if (!node.label.trim()) {
      pushIssue(issues, {
        severity: "warning",
        code: "empty_node_label",
        message: "Node label is empty.",
        path: nodePath,
        id: node.id
      });
    }
    if (node.pageId && !pageIds.has(node.pageId)) {
      pushIssue(issues, {
        severity: "error",
        code: "dangling_node_page",
        message: `Node references missing page ${node.pageId}.`,
        path: nodePath,
        id: node.id,
        refs: [node.pageId]
      });
    }
    for (const sourceId of node.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        pushIssue(issues, {
          severity: "warning",
          code: "dangling_node_source",
          message: `Node references source ${sourceId}, but the source is not present in graph.sources.`,
          path: nodePath,
          id: node.id,
          refs: [sourceId]
        });
      }
    }
  }

  for (const page of graph.pages) {
    const pagePath = `pages.${page.id}`;
    validateConfidence(issues, page.confidence, pagePath, page.id, "Page");
    if (!page.path.trim()) {
      pushIssue(issues, {
        severity: "error",
        code: "empty_page_path",
        message: "Page path is empty.",
        path: pagePath,
        id: page.id
      });
    }
    for (const nodeId of page.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        pushIssue(issues, {
          severity: "error",
          code: "dangling_page_node",
          message: `Page references missing node ${nodeId}.`,
          path: pagePath,
          id: page.id,
          refs: [nodeId]
        });
      }
    }
    for (const relatedNodeId of page.relatedNodeIds) {
      if (!nodeIds.has(relatedNodeId)) {
        pushIssue(issues, {
          severity: "warning",
          code: "dangling_related_node",
          message: `Page relatedNodeIds includes missing node ${relatedNodeId}.`,
          path: pagePath,
          id: page.id,
          refs: [relatedNodeId]
        });
      }
    }
    for (const relatedPageId of page.relatedPageIds) {
      if (!pageIds.has(relatedPageId)) {
        pushIssue(issues, {
          severity: "warning",
          code: "dangling_related_page",
          message: `Page relatedPageIds includes missing page ${relatedPageId}.`,
          path: pagePath,
          id: page.id,
          refs: [relatedPageId]
        });
      }
    }
  }

  for (const edge of graph.edges) {
    const edgePath = `edges.${edge.id}`;
    validateConfidence(issues, edge.confidence, edgePath, edge.id, "Edge");
    if (!edge.relation.trim()) {
      pushIssue(issues, {
        severity: "error",
        code: "empty_edge_relation",
        message: "Edge relation is empty.",
        path: edgePath,
        id: edge.id
      });
    }
    const missingRefs = [edge.source, edge.target].filter((nodeId) => !nodeIds.has(nodeId));
    if (missingRefs.length) {
      pushIssue(issues, {
        severity: "error",
        code: "dangling_edge_node",
        message: `Edge references missing node${missingRefs.length === 1 ? "" : "s"} ${missingRefs.join(", ")}.`,
        path: edgePath,
        id: edge.id,
        refs: missingRefs
      });
    }
    if (edge.status === "conflicted" && edge.evidenceClass !== "ambiguous") {
      pushIssue(issues, {
        severity: "warning",
        code: "conflicted_edge_evidence",
        message: "Conflicted edges should use ambiguous evidence class.",
        path: edgePath,
        id: edge.id
      });
    }
  }

  for (const hyperedge of graph.hyperedges ?? []) {
    const hyperedgePath = `hyperedges.${hyperedge.id}`;
    validateConfidence(issues, hyperedge.confidence, hyperedgePath, hyperedge.id, "Hyperedge");
    const missingNodeIds = hyperedge.nodeIds.filter((nodeId) => !nodeIds.has(nodeId));
    if (missingNodeIds.length) {
      pushIssue(issues, {
        severity: "error",
        code: "dangling_hyperedge_node",
        message: `Hyperedge references missing node${missingNodeIds.length === 1 ? "" : "s"} ${missingNodeIds.join(", ")}.`,
        path: hyperedgePath,
        id: hyperedge.id,
        refs: missingNodeIds
      });
    }
    const missingPageIds = hyperedge.sourcePageIds.filter((pageId) => !pageIds.has(pageId));
    if (missingPageIds.length) {
      pushIssue(issues, {
        severity: "error",
        code: "dangling_hyperedge_page",
        message: `Hyperedge references missing source page${missingPageIds.length === 1 ? "" : "s"} ${missingPageIds.join(", ")}.`,
        path: hyperedgePath,
        id: hyperedge.id,
        refs: missingPageIds
      });
    }
  }

  for (const community of graph.communities ?? []) {
    const missingNodeIds = community.nodeIds.filter((nodeId) => !nodeIds.has(nodeId));
    if (missingNodeIds.length) {
      pushIssue(issues, {
        severity: "error",
        code: "dangling_community_node",
        message: `Community references missing node${missingNodeIds.length === 1 ? "" : "s"} ${missingNodeIds.join(", ")}.`,
        path: `communities.${community.id}`,
        id: community.id,
        refs: missingNodeIds
      });
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.length - errorCount;
  const ok = strict ? errorCount === 0 && warningCount === 0 : errorCount === 0;

  return {
    ok,
    strict,
    generatedAt: graph.generatedAt,
    counts: stats.counts,
    errorCount,
    warningCount,
    issues,
    summary: summarizeValidation(ok, errorCount, warningCount, stats.counts)
  };
}

export function listHyperedges(graph: GraphArtifact, target?: string, limit = 25): GraphHyperedge[] {
  if (!target) {
    return [...(graph.hyperedges ?? [])]
      .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label))
      .slice(0, limit);
  }

  const node = resolveNode(graph, target);
  if (node) {
    return hyperedgesForNode(graph, node.id).slice(0, limit);
  }

  const page = graph.pages.find((candidate) => normalizeTarget(candidate.path) === normalizeTarget(target) || candidate.id === target);
  if (!page) {
    return [];
  }
  return (graph.hyperedges ?? [])
    .filter((hyperedge) => hyperedge.sourcePageIds.includes(page.id) || page.nodeIds.some((nodeId) => hyperedge.nodeIds.includes(nodeId)))
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label))
    .slice(0, limit);
}

export function graphDiff(oldGraph: GraphArtifact, newGraph: GraphArtifact): GraphDiffResult {
  const oldNodeIds = new Set(oldGraph.nodes.map((node) => node.id));
  const newNodeIds = new Set(newGraph.nodes.map((node) => node.id));

  const addedNodes = newGraph.nodes
    .filter((node) => !oldNodeIds.has(node.id))
    .map((node) => ({ id: node.id, label: node.label, type: node.type }));
  const removedNodes = oldGraph.nodes
    .filter((node) => !newNodeIds.has(node.id))
    .map((node) => ({ id: node.id, label: node.label, type: node.type }));

  const oldEdgeIds = new Set(oldGraph.edges.map((edge) => edge.id));
  const newEdgeIds = new Set(newGraph.edges.map((edge) => edge.id));

  const addedEdges = newGraph.edges
    .filter((edge) => !oldEdgeIds.has(edge.id))
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation, evidenceClass: edge.evidenceClass }));
  const removedEdges = oldGraph.edges
    .filter((edge) => !newEdgeIds.has(edge.id))
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation, evidenceClass: edge.evidenceClass }));

  const oldPageIds = new Set(oldGraph.pages.map((page) => page.id));
  const newPageIds = new Set(newGraph.pages.map((page) => page.id));

  const addedPages = newGraph.pages
    .filter((page) => !oldPageIds.has(page.id))
    .map((page) => ({ id: page.id, path: page.path, title: page.title, kind: page.kind }));
  const removedPages = oldGraph.pages
    .filter((page) => !newPageIds.has(page.id))
    .map((page) => ({ id: page.id, path: page.path, title: page.title, kind: page.kind }));

  const parts: string[] = [];
  if (addedNodes.length || removedNodes.length) {
    const segments = [];
    if (addedNodes.length) segments.push(`${addedNodes.length} added`);
    if (removedNodes.length) segments.push(`${removedNodes.length} removed`);
    parts.push(`${segments.join(", ")} nodes`);
  }
  if (addedEdges.length || removedEdges.length) {
    const segments = [];
    if (addedEdges.length) segments.push(`${addedEdges.length} added`);
    if (removedEdges.length) segments.push(`${removedEdges.length} removed`);
    parts.push(`${segments.join(", ")} edges`);
  }
  if (addedPages.length || removedPages.length) {
    const segments = [];
    if (addedPages.length) segments.push(`${addedPages.length} added`);
    if (removedPages.length) segments.push(`${removedPages.length} removed`);
    parts.push(`${segments.join(", ")} pages`);
  }
  const summary = parts.length ? parts.join("; ") : "No changes";

  return { addedNodes, removedNodes, addedEdges, removedEdges, addedPages, removedPages, summary };
}

/**
 * Compute the blast radius of changing a file/module by tracing reverse import
 * edges via BFS. Returns all modules that transitively depend on the target.
 */
export function blastRadius(graph: GraphArtifact, target: string, options?: { maxDepth?: number }): BlastRadiusResult {
  const maxDepth = Math.max(1, Math.min(options?.maxDepth ?? 3, 10));

  // Resolve target to a module node
  const resolved = resolveNode(graph, target);
  const moduleNode =
    resolved?.type === "module" ? resolved : resolved?.moduleId ? graph.nodes.find((n) => n.id === resolved.moduleId) : undefined;

  if (!moduleNode) {
    // Try matching module nodes by label substring (file path matching)
    const normalizedTarget = normalizeTarget(target);
    const candidate = graph.nodes
      .filter((n) => n.type === "module")
      .find((n) => normalizeTarget(n.label).includes(normalizedTarget) || normalizeTarget(n.id).includes(normalizedTarget));
    if (!candidate) {
      return {
        target,
        totalAffected: 0,
        maxDepth,
        affectedModules: [],
        summary: `No module found matching "${target}".`
      };
    }
    return blastRadius(graph, candidate.id, options);
  }

  // Build reverse adjacency: for "imports" edges, track who imports whom.
  // If module A imports module B, then changing B affects A.
  const reverseImports = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.relation === "imports") {
      const dependents = reverseImports.get(edge.target) ?? [];
      dependents.push(edge.source);
      reverseImports.set(edge.target, dependents);
    }
  }

  // BFS from the target module following reverse import edges
  const affected: Array<{ moduleId: string; label: string; depth: number }> = [];
  const seen = new Set<string>([moduleNode.id]);
  const frontier: Array<{ id: string; depth: number }> = [{ id: moduleNode.id, depth: 0 }];
  const nodes = nodeById(graph);

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    if (current.depth >= maxDepth) {
      continue;
    }
    for (const dependentId of reverseImports.get(current.id) ?? []) {
      if (seen.has(dependentId)) {
        continue;
      }
      seen.add(dependentId);
      const dependentNode = nodes.get(dependentId);
      const nextDepth = current.depth + 1;
      affected.push({
        moduleId: dependentId,
        label: dependentNode?.label ?? dependentId,
        depth: nextDepth
      });
      frontier.push({ id: dependentId, depth: nextDepth });
    }
  }

  affected.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));

  const summary = affected.length
    ? `Changing "${moduleNode.label}" affects ${affected.length} module${affected.length === 1 ? "" : "s"} (max depth ${maxDepth}).`
    : `No modules depend on "${moduleNode.label}".`;

  return {
    target,
    resolvedModuleId: moduleNode.id,
    affectedModules: affected,
    totalAffected: affected.length,
    maxDepth,
    summary
  };
}
