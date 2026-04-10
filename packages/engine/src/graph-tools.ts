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
  GraphQueryMatch,
  GraphQueryResult,
  SearchResult
} from "./types.js";
import { normalizeWhitespace, uniqueBy } from "./utils.js";

function normalizeTarget(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
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

function communityLabel(graph: GraphArtifact, communityId: string | undefined): { id: string; label: string } | undefined {
  if (!communityId) {
    return undefined;
  }
  const community = graph.communities?.find((item) => item.id === communityId);
  return community ? { id: community.id, label: community.label } : undefined;
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
  }
): GraphQueryResult {
  const traversal = options?.traversal ?? "bfs";
  const budget = Math.max(3, Math.min(options?.budget ?? 12, 50));
  const matches = uniqueBy(
    [
      ...(options?.semanticMatches ?? []),
      ...pageSearchMatches(graph, question, searchResults),
      ...nodeMatches(graph, question),
      ...hyperedgeMatches(graph, question)
    ],
    (match) => `${match.type}:${match.id}`
  )
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 12);
  const pages = pageById(graph);
  const seeds = uniqueBy(
    [
      ...searchResults.flatMap((result) => pages.get(result.pageId)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "page").flatMap((match) => pages.get(match.id)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "node").map((match) => match.id),
      ...matches
        .filter((match) => match.type === "hyperedge")
        .flatMap((match) => graph.hyperedges.find((hyperedge) => hyperedge.id === match.id)?.nodeIds ?? [])
    ],
    (item) => item
  ).filter(Boolean);

  const adjacency = graphAdjacency(graph);
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

  const nodes = nodeById(graph);
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
    (graph.hyperedges ?? [])
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
      `Touched group patterns: ${hyperedgeIds.length}`,
      `Communities: ${communities.join(", ") || "none"}`,
      `Pages: ${pageIds.join(", ") || "none"}`
    ].join("\n")
  };
}

export function shortestGraphPath(graph: GraphArtifact, from: string, to: string): GraphPathResult {
  const start = resolveNode(graph, from);
  const end = resolveNode(graph, to);
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

  const adjacency = graphAdjacency(graph);
  const queue = [start.id];
  const visited = new Set<string>([start.id]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();

  while (queue.length) {
    const current = queue.shift() as string;
    if (current === end.id) {
      break;
    }
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor.nodeId)) {
        continue;
      }
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
    if (!prev) {
      break;
    }
    edgeIds.push(prev.edgeId);
    current = prev.nodeId;
  }
  nodeIds.push(start.id);
  nodeIds.reverse();
  edgeIds.reverse();

  const nodes = nodeById(graph);
  const pageIds = uniqueBy(
    nodeIds.flatMap((nodeId) => {
      const node = nodes.get(nodeId);
      return node?.pageId ? [node.pageId] : [];
    }),
    (item) => item
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
    summary: nodeIds.map((nodeId) => nodes.get(nodeId)?.label ?? nodeId).join(" -> ")
  };
}

export function explainGraphTarget(graph: GraphArtifact, target: string): GraphExplainResult {
  const node = resolveNode(graph, target);
  if (!node) {
    throw new Error(`Could not resolve graph target: ${target}`);
  }

  const pages = pageById(graph);
  const page = node.pageId ? pages.get(node.pageId) : undefined;
  const neighbors: GraphExplainNeighbor[] = [];
  const nodes = nodeById(graph);
  for (const neighbor of graphAdjacency(graph).get(node.id) ?? []) {
    const targetNode = nodes.get(neighbor.nodeId);
    if (!targetNode) {
      continue;
    }
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

  return {
    target,
    node,
    page,
    community: communityLabel(graph, node.communityId),
    neighbors,
    hyperedges: hyperedgesForNode(graph, node.id),
    summary: [
      `Node: ${node.label}`,
      `Type: ${node.type}`,
      `Community: ${node.communityId ?? "none"}`,
      `Neighbors: ${neighbors.length}`,
      `Group patterns: ${hyperedgesForNode(graph, node.id).length}`,
      `Page: ${page?.path ?? "none"}`
    ].join("\n")
  };
}

export function topGodNodes(graph: GraphArtifact, limit = 10): GraphNode[] {
  return graph.nodes
    .filter((node) => node.isGodNode)
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0))
    .slice(0, limit);
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
