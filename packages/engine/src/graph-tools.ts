import type {
  EvidenceClass,
  GraphArtifact,
  GraphEdge,
  GraphExplainNeighbor,
  GraphExplainResult,
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

function resolveNode(graph: GraphArtifact, target: string): GraphNode | undefined {
  const normalized = normalizeTarget(target);
  const byId = nodeById(graph);
  if (byId.has(target)) {
    return byId.get(target);
  }

  const exact = graph.nodes.find((node) => normalizeTarget(node.label) === normalized || normalizeTarget(node.id) === normalized);
  if (exact) {
    return exact;
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
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label))[0]?.node;
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
  }
): GraphQueryResult {
  const traversal = options?.traversal ?? "bfs";
  const budget = Math.max(3, Math.min(options?.budget ?? 12, 50));
  const matches = uniqueBy(
    [...pageSearchMatches(graph, question, searchResults), ...nodeMatches(graph, question)],
    (match) => `${match.type}:${match.id}`
  )
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 12);
  const pages = pageById(graph);
  const seeds = uniqueBy(
    [
      ...searchResults.flatMap((result) => pages.get(result.pageId)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "node").map((match) => match.id)
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

  return {
    question,
    traversal,
    seedNodeIds: seeds,
    seedPageIds: uniqueBy(
      searchResults.map((result) => result.pageId),
      (item) => item
    ),
    visitedNodeIds,
    visitedEdgeIds: [...visitedEdgeIds],
    pageIds,
    communities,
    matches,
    summary: [
      `Seeds: ${seeds.join(", ") || "none"}`,
      `Visited nodes: ${visitedNodeIds.length}`,
      `Visited edges: ${visitedEdgeIds.size}`,
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
    summary: [
      `Node: ${node.label}`,
      `Type: ${node.type}`,
      `Community: ${node.communityId ?? "none"}`,
      `Neighbors: ${neighbors.length}`,
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
