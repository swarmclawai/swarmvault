/**
 * Dependency-free graph traversal helpers shared by the live `graph serve` /
 * MCP surface and the standalone exported HTML. Everything in this module is
 * deterministic, free of IO, and operates purely on the minimal graph shape
 * that ships inside the standalone export payload (so the exported HTML can
 * embed an equivalent JS implementation without pulling in provider-backed
 * features like page search or semantic similarity).
 *
 * The richer server-side wrappers live in `graph-tools.ts` and `vault.ts`.
 */

/** Minimal node shape the core helpers depend on. */
export interface CoreGraphNode {
  id: string;
  label: string;
  type: string;
  pageId?: string;
  communityId?: string;
  degree?: number;
  confidence?: number;
  evidenceClass?: string;
  tags?: string[];
}

/** Minimal edge shape the core helpers depend on. */
export interface CoreGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  evidenceClass: string;
  confidence: number;
}

/** Minimal page shape the core helpers depend on. */
export interface CoreGraphPage {
  id: string;
  path: string;
  title: string;
}

/** Minimal hyperedge shape the core helpers depend on. */
export interface CoreGraphHyperedge {
  id: string;
  label: string;
  relation: string;
  nodeIds: string[];
  confidence: number;
  evidenceClass: string;
  why?: string;
}

/** Minimal community shape the core helpers depend on. */
export interface CoreGraphCommunity {
  id: string;
  label: string;
  nodeIds: string[];
}

/**
 * Aggregated read-only graph view consumed by the shared helpers. Matches the
 * subset of `GraphArtifact` fields that travel inside the standalone export.
 */
export interface CoreGraph {
  nodes: CoreGraphNode[];
  edges: CoreGraphEdge[];
  pages?: CoreGraphPage[];
  hyperedges?: CoreGraphHyperedge[];
  communities?: CoreGraphCommunity[];
}

export interface CoreQueryMatch {
  type: "node" | "page" | "hyperedge";
  id: string;
  label: string;
  score: number;
}

export interface CoreQueryResult {
  question: string;
  traversal: "bfs" | "dfs";
  seedNodeIds: string[];
  seedPageIds: string[];
  visitedNodeIds: string[];
  visitedEdgeIds: string[];
  hyperedgeIds: string[];
  pageIds: string[];
  communities: string[];
  matches: CoreQueryMatch[];
  summary: string;
}

export interface CorePathResult {
  from: string;
  to: string;
  resolvedFromNodeId?: string;
  resolvedToNodeId?: string;
  found: boolean;
  nodeIds: string[];
  edgeIds: string[];
  pageIds: string[];
  summary: string;
}

export interface CoreExplainNeighbor {
  nodeId: string;
  label: string;
  type: string;
  pageId?: string;
  relation: string;
  direction: "incoming" | "outgoing";
  confidence: number;
  evidenceClass: string;
}

export interface CoreExplainResult {
  target: string;
  node: CoreGraphNode;
  page?: CoreGraphPage;
  community?: { id: string; label: string };
  neighbors: CoreExplainNeighbor[];
  hyperedges: CoreGraphHyperedge[];
  summary: string;
}

type EdgeNeighbor = {
  edge: CoreGraphEdge;
  nodeId: string;
  direction: "incoming" | "outgoing";
};

const NODE_TYPE_PRIORITY: Record<string, number> = {
  concept: 6,
  entity: 5,
  source: 4,
  module: 3,
  symbol: 2,
  rationale: 1
};

function normalizeTarget(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueMatches(matches: CoreQueryMatch[]): CoreQueryMatch[] {
  const seen = new Set<string>();
  const out: CoreQueryMatch[] = [];
  for (const match of matches) {
    const key = `${match.type}:${match.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

function scoreMatch(query: string, candidate: string): number {
  const q = normalizeTarget(query);
  const c = normalizeTarget(candidate);
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.includes(q)) return 60;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const cTokens = new Set(c.split(/\s+/).filter(Boolean));
  const overlap = qTokens.filter((token) => cTokens.has(token)).length;
  return overlap ? overlap * 10 : 0;
}

function buildAdjacency(graph: CoreGraph): Map<string, EdgeNeighbor[]> {
  const adjacency = new Map<string, EdgeNeighbor[]>();
  const push = (nodeId: string, item: EdgeNeighbor) => {
    const list = adjacency.get(nodeId);
    if (list) {
      list.push(item);
    } else {
      adjacency.set(nodeId, [item]);
    }
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

function compareLabelCandidates(left: CoreGraphNode, right: CoreGraphNode): number {
  const priorityDelta = (NODE_TYPE_PRIORITY[right.type] ?? 0) - (NODE_TYPE_PRIORITY[left.type] ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  const degreeDelta = (right.degree ?? 0) - (left.degree ?? 0);
  if (degreeDelta !== 0) return degreeDelta;
  return left.id.localeCompare(right.id);
}

/**
 * Resolve a free-text target (node id, label, or fuzzy page title) to the most
 * central matching node. Prefers exact ids, then label matches ranked by
 * node-type priority / degree, then fuzzy page fallbacks.
 */
export function resolveCoreNode(graph: CoreGraph, target: string): CoreGraphNode | undefined {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  if (byId.has(target)) return byId.get(target);
  const normalized = normalizeTarget(target);
  const labelMatches = graph.nodes.filter((node) => normalizeTarget(node.label) === normalized || normalizeTarget(node.id) === normalized);
  if (labelMatches.length) {
    return labelMatches.slice().sort(compareLabelCandidates)[0];
  }
  const pages = graph.pages ?? [];
  const pageHit = pages
    .map((page) => ({
      page,
      score: Math.max(scoreMatch(target, page.title), scoreMatch(target, page.path))
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.title.localeCompare(right.page.title))[0];
  if (pageHit) {
    const primary = graph.nodes.find((node) => node.pageId === pageHit.page.id);
    if (primary) return primary;
  }
  const fuzzy = graph.nodes
    .map((node) => ({ node, score: Math.max(scoreMatch(target, node.label), scoreMatch(target, node.id)) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareLabelCandidates(left.node, right.node))[0];
  return fuzzy?.node;
}

function coreNodeMatches(graph: CoreGraph, query: string): CoreQueryMatch[] {
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

function corePageMatches(graph: CoreGraph, query: string): CoreQueryMatch[] {
  return (graph.pages ?? [])
    .map((page) => ({
      type: "page" as const,
      id: page.id,
      label: page.title,
      score: Math.max(scoreMatch(query, page.title), scoreMatch(query, page.path))
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

function coreHyperedgeMatches(graph: CoreGraph, query: string): CoreQueryMatch[] {
  return (graph.hyperedges ?? [])
    .map((hyperedge) => ({
      type: "hyperedge" as const,
      id: hyperedge.id,
      label: hyperedge.label,
      score: Math.max(scoreMatch(query, hyperedge.label), scoreMatch(query, hyperedge.why ?? ""), scoreMatch(query, hyperedge.relation))
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

/**
 * Deterministic BFS/DFS traversal that seeds from label/page/hyperedge matches
 * for `question` and walks outward until `budget` nodes have been visited.
 * Matches the behaviour of the server-side `queryGraph` when no external page
 * search or semantic matches are provided — which is the offline case the
 * standalone HTML runs in.
 */
export function runCoreGraphQuery(
  graph: CoreGraph,
  question: string,
  options?: { traversal?: "bfs" | "dfs"; budget?: number }
): CoreQueryResult {
  const traversal = options?.traversal ?? "bfs";
  const budget = Math.max(3, Math.min(options?.budget ?? 12, 50));

  const matches = uniqueMatches([
    ...corePageMatches(graph, question),
    ...coreNodeMatches(graph, question),
    ...coreHyperedgeMatches(graph, question)
  ])
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 12);

  const pagesById = new Map((graph.pages ?? []).map((page) => [page.id, page] as const));
  const nodesByPageId = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (!node.pageId) continue;
    const list = nodesByPageId.get(node.pageId);
    if (list) list.push(node.id);
    else nodesByPageId.set(node.pageId, [node.id]);
  }

  const seeds = uniqueStrings([
    ...matches.filter((match) => match.type === "page").flatMap((match) => nodesByPageId.get(match.id) ?? []),
    ...matches.filter((match) => match.type === "node").map((match) => match.id),
    ...matches
      .filter((match) => match.type === "hyperedge")
      .flatMap((match) => (graph.hyperedges ?? []).find((hyperedge) => hyperedge.id === match.id)?.nodeIds ?? [])
  ]);

  const adjacency = buildAdjacency(graph);
  const visitedNodeIds: string[] = [];
  const visitedEdgeIds = new Set<string>();
  const seen = new Set<string>();
  const frontier: string[] = [...seeds];

  while (frontier.length && visitedNodeIds.length < budget) {
    const current = traversal === "dfs" ? frontier.pop() : frontier.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    visitedNodeIds.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      visitedEdgeIds.add(neighbor.edge.id);
      if (!seen.has(neighbor.nodeId)) {
        frontier.push(neighbor.nodeId);
      }
      if (visitedNodeIds.length + frontier.length >= budget * 2) break;
    }
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pageIds = uniqueStrings([
    ...matches.filter((match) => match.type === "page").map((match) => match.id),
    ...visitedNodeIds.flatMap((nodeId) => {
      const node = nodeById.get(nodeId);
      return node?.pageId ? [node.pageId] : [];
    })
  ]);
  const communities = uniqueStrings(
    visitedNodeIds.map((nodeId) => nodeById.get(nodeId)?.communityId).filter((value): value is string => Boolean(value))
  );
  const hyperedgeIds = uniqueStrings(
    (graph.hyperedges ?? [])
      .filter((hyperedge) => hyperedge.nodeIds.some((nodeId) => visitedNodeIds.includes(nodeId)))
      .map((hyperedge) => hyperedge.id)
  );

  const seedPageIds = uniqueStrings(matches.filter((match) => match.type === "page").map((match) => match.id));

  // Keep the summary shape aligned with the server-side `queryGraph` so the
  // standalone HTML and MCP/serve surfaces describe results the same way.
  const summary = [
    `Seeds: ${seeds.join(", ") || "none"}`,
    `Visited nodes: ${visitedNodeIds.length}`,
    `Visited edges: ${visitedEdgeIds.size}`,
    `Touched group patterns: ${hyperedgeIds.length}`,
    `Communities: ${communities.join(", ") || "none"}`,
    `Pages: ${pageIds.join(", ") || "none"}`
  ].join("\n");

  // Silence unused-locals lint when pagesById is not referenced by the
  // consumer; keeping the lookup as a seam for future preview features.
  void pagesById;

  return {
    question,
    traversal,
    seedNodeIds: seeds,
    seedPageIds,
    visitedNodeIds,
    visitedEdgeIds: [...visitedEdgeIds],
    hyperedgeIds,
    pageIds,
    communities,
    matches,
    summary
  };
}

/**
 * Unweighted BFS that returns the shortest path between two nodes, or an empty
 * result when either endpoint cannot be resolved or the endpoints live in
 * disconnected components.
 */
export function runCoreGraphPath(graph: CoreGraph, from: string, to: string): CorePathResult {
  const start = resolveCoreNode(graph, from);
  const end = resolveCoreNode(graph, to);
  if (!start || !end) {
    return {
      from,
      to,
      resolvedFromNodeId: start?.id,
      resolvedToNodeId: end?.id,
      found: false,
      nodeIds: [],
      edgeIds: [],
      pageIds: [],
      summary: "Could not resolve one or both graph targets."
    };
  }

  const adjacency = buildAdjacency(graph);
  const queue: string[] = [start.id];
  const visited = new Set<string>([start.id]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();

  while (queue.length) {
    const current = queue.shift() as string;
    if (current === end.id) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor.nodeId)) continue;
      visited.add(neighbor.nodeId);
      previous.set(neighbor.nodeId, { nodeId: current, edgeId: neighbor.edge.id });
      queue.push(neighbor.nodeId);
    }
  }

  if (!visited.has(end.id)) {
    return {
      from,
      to,
      resolvedFromNodeId: start.id,
      resolvedToNodeId: end.id,
      found: false,
      nodeIds: [],
      edgeIds: [],
      pageIds: [],
      summary: `No path found between ${start.label} and ${end.label}.`
    };
  }

  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  let current = end.id;
  while (current !== start.id) {
    nodeIds.push(current);
    const prev = previous.get(current);
    if (!prev) break;
    edgeIds.push(prev.edgeId);
    current = prev.nodeId;
  }
  nodeIds.push(start.id);
  nodeIds.reverse();
  edgeIds.reverse();

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pageIds = uniqueStrings(
    nodeIds.flatMap((nodeId) => {
      const node = nodeById.get(nodeId);
      return node?.pageId ? [node.pageId] : [];
    })
  );

  return {
    from,
    to,
    resolvedFromNodeId: start.id,
    resolvedToNodeId: end.id,
    found: true,
    nodeIds,
    edgeIds,
    pageIds,
    summary: nodeIds.map((nodeId) => nodeById.get(nodeId)?.label ?? nodeId).join(" -> ")
  };
}

/**
 * Resolve a target node and describe its neighborhood: direct neighbors
 * grouped with their relation/direction, community assignment, and any
 * group-pattern hyperedges it participates in.
 */
export function runCoreGraphExplain(graph: CoreGraph, target: string): CoreExplainResult | undefined {
  const node = resolveCoreNode(graph, target);
  if (!node) return undefined;

  const adjacency = buildAdjacency(graph);
  const nodeById = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  const neighbors: CoreExplainNeighbor[] = [];
  for (const neighbor of adjacency.get(node.id) ?? []) {
    const targetNode = nodeById.get(neighbor.nodeId);
    if (!targetNode) continue;
    neighbors.push({
      nodeId: targetNode.id,
      label: targetNode.label,
      type: targetNode.type,
      pageId: targetNode.pageId,
      relation: neighbor.edge.relation,
      direction: neighbor.direction,
      confidence: neighbor.edge.confidence,
      evidenceClass: neighbor.edge.evidenceClass
    });
  }
  neighbors.sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));

  const pagesById = new Map((graph.pages ?? []).map((page) => [page.id, page] as const));
  const page = node.pageId ? pagesById.get(node.pageId) : undefined;

  const community = node.communityId ? graph.communities?.find((candidate) => candidate.id === node.communityId) : undefined;

  const hyperedges = (graph.hyperedges ?? [])
    .filter((hyperedge) => hyperedge.nodeIds.includes(node.id))
    .slice()
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));

  const summary = [
    `Node: ${node.label}`,
    `Type: ${node.type}`,
    `Community: ${node.communityId ?? "none"}`,
    `Neighbors: ${neighbors.length}`,
    `Group patterns: ${hyperedges.length}`,
    `Page: ${page?.path ?? "none"}`
  ].join("\n");

  return {
    target,
    node,
    page,
    community: community ? { id: community.id, label: community.label } : undefined,
    neighbors,
    hyperedges,
    summary
  };
}
