export type ViewerOutputAsset = {
  id: string;
  role: string;
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  dataPath?: string;
  dataUrl?: string;
};

export type ViewerGraphNode = {
  id: string;
  type: string;
  label: string;
  sourceIds: string[];
  projectIds: string[];
  sourceClass?: string;
  pageId?: string;
  language?: string;
  moduleId?: string;
  symbolKind?: string;
  communityId?: string;
  degree?: number;
  bridgeScore?: number;
  isGodNode?: boolean;
};

export type ViewerGraphEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  status: string;
  evidenceClass?: string;
  confidence?: number;
  similarityReasons?: string[];
};

export type ViewerGraphHyperedge = {
  id: string;
  label: string;
  relation: string;
  nodeIds: string[];
  evidenceClass: string;
  confidence: number;
  sourcePageIds: string[];
  why: string;
};

export type ViewerGraphPage = {
  pageId: string;
  path: string;
  title: string;
  kind: string;
  status: string;
  sourceType?: string;
  sourceClass?: string;
  projectIds: string[];
  content: string;
  assets: ViewerOutputAsset[];
};

export type ViewerGraphArtifact = {
  generatedAt: string;
  nodes: ViewerGraphNode[];
  edges: ViewerGraphEdge[];
  hyperedges: ViewerGraphHyperedge[];
  presentation?: {
    mode: "full" | "overview";
    threshold: number;
    nodeBudget: number;
    totalNodes: number;
    displayedNodes: number;
    totalEdges: number;
    displayedEdges: number;
    totalCommunities: number;
    displayedCommunities: number;
  };
  communities?: Array<{
    id: string;
    label: string;
    nodeIds: string[];
  }>;
  pages?: Array<{
    id: string;
    path: string;
    title: string;
    kind: string;
    status: string;
    sourceType?: string;
    sourceClass?: string;
    projectIds: string[];
    nodeIds: string[];
    backlinks: string[];
    relatedPageIds: string[];
  }>;
};

export type ViewerSearchResult = {
  pageId: string;
  path: string;
  title: string;
  snippet: string;
  rank: number;
  kind?: string;
  status?: string;
  projectIds: string[];
  sourceType?: string;
  sourceClass?: string;
};

export type ViewerPagePayload = {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  content: string;
  assets: ViewerOutputAsset[];
};

export type ViewerGraphQueryResult = {
  question: string;
  traversal: "bfs" | "dfs";
  seedNodeIds: string[];
  seedPageIds: string[];
  visitedNodeIds: string[];
  visitedEdgeIds: string[];
  hyperedgeIds: string[];
  pageIds: string[];
  communities: string[];
  summary: string;
  matches: Array<{
    type: "node" | "page" | "hyperedge";
    id: string;
    label: string;
    score: number;
  }>;
};

export type ViewerGraphPathResult = {
  from: string;
  to: string;
  resolvedFromNodeId?: string;
  resolvedToNodeId?: string;
  found: boolean;
  nodeIds: string[];
  edgeIds: string[];
  pageIds: string[];
  summary: string;
};

export type ViewerGraphExplainResult = {
  target: string;
  node: ViewerGraphNode;
  page?: {
    id: string;
    path: string;
    title: string;
  };
  community?: {
    id: string;
    label: string;
  };
  neighbors: Array<{
    nodeId: string;
    label: string;
    type: string;
    pageId?: string;
    relation: string;
    direction: "incoming" | "outgoing";
    confidence: number;
    evidenceClass: string;
  }>;
  hyperedges: ViewerGraphHyperedge[];
  summary: string;
};

export type ViewerApprovalSummary = {
  approvalId: string;
  createdAt: string;
  entryCount: number;
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
};

export type ViewerApprovalDiffLine = {
  type: "add" | "remove" | "context";
  value: string;
};

export type ViewerApprovalDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ViewerApprovalDiffLine[];
};

export type ViewerApprovalFrontmatterChange = {
  key: string;
  before?: unknown;
  after?: unknown;
  protected: boolean;
};

export type ViewerApprovalStructuredDiff = {
  hunks: ViewerApprovalDiffHunk[];
  addedLines: number;
  removedLines: number;
  frontmatterChanges: ViewerApprovalFrontmatterChange[];
};

export type ViewerApprovalEntry = {
  pageId: string;
  title: string;
  kind: string;
  changeType: string;
  status: string;
  sourceIds: string[];
  nextPath?: string;
  previousPath?: string;
  currentContent?: string;
  stagedContent?: string;
  diff?: string;
  structuredDiff?: ViewerApprovalStructuredDiff;
  warnings?: string[];
};

export type ViewerApprovalDetail = ViewerApprovalSummary & {
  entries: ViewerApprovalEntry[];
};

export type ViewerReviewActionResult = ViewerApprovalSummary & {
  updatedEntries: string[];
};

export type ViewerCandidateRecord = {
  pageId: string;
  title: string;
  kind: "concept" | "entity";
  path: string;
  activePath: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  score?: number;
  scoreBreakdown?: Record<string, number>;
};

export type ViewerLintFinding = {
  id: string;
  severity: "error" | "warning" | "info";
  category: string;
  message: string;
  pageId?: string;
  pagePath?: string;
  nodeId?: string;
  detectedAt?: string;
};

export type ViewerWorkspaceBundle = {
  graph: ViewerGraphArtifact;
  approvals: ViewerApprovalSummary[];
  candidates: ViewerCandidateRecord[];
  watchStatus: ViewerWatchStatus;
  graphReport: ViewerGraphReport | null;
  lintFindings: ViewerLintFinding[];
};

export type ViewerWatchStatus = {
  generatedAt: string;
  watchedRepoRoots: string[];
  lastRun?: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    inputDir: string;
    reasons: string[];
    importedCount: number;
    scannedCount: number;
    attachmentCount: number;
    changedPages: string[];
    repoImportedCount?: number;
    repoUpdatedCount?: number;
    repoRemovedCount?: number;
    repoScannedCount?: number;
    pendingSemanticRefreshCount?: number;
    pendingSemanticRefreshPaths?: string[];
    lintFindingCount?: number;
    success: boolean;
    error?: string;
  };
  pendingSemanticRefresh: Array<{
    id: string;
    repoRoot: string;
    path: string;
    changeType: "added" | "modified" | "removed";
    detectedAt: string;
    sourceId?: string;
    sourceKind?: string;
  }>;
};

export type ViewerGraphReport = {
  generatedAt: string;
  graphHash: string;
  overview: {
    nodes: number;
    edges: number;
    pages: number;
    communities: number;
  };
  firstPartyOverview: {
    nodes: number;
    edges: number;
    pages: number;
    communities: number;
  };
  sourceClassBreakdown: Record<string, { sources: number; pages: number; nodes: number }>;
  warnings: string[];
  benchmark?: {
    generatedAt: string;
    stale: boolean;
    summary: {
      questionCount: number;
      uniqueVisitedNodes: number;
      finalContextTokens: number;
      naiveCorpusTokens: number;
      avgReduction: number;
      reductionRatio: number;
    };
    questionCount: number;
  };
  surprisingConnections: Array<{
    id: string;
    sourceNodeId: string;
    sourceLabel: string;
    targetNodeId: string;
    targetLabel: string;
    relation: string;
    evidenceClass: string;
    confidence: number;
    pathNodeIds: string[];
    pathEdgeIds: string[];
    pathRelations: string[];
    pathEvidenceClasses: string[];
    pathSummary: string;
    why: string;
    explanation: string;
  }>;
  groupPatterns: ViewerGraphHyperedge[];
  suggestedQuestions: string[];
  recentResearchSources: Array<{
    pageId: string;
    path: string;
    title: string;
    sourceType: string;
    updatedAt: string;
  }>;
};

declare global {
  interface Window {
    __SWARMVAULT_EMBEDDED_DATA__?: {
      graph: ViewerGraphArtifact;
      pages: ViewerGraphPage[];
      report?: ViewerGraphReport;
    };
  }
}

function embeddedData() {
  return typeof window !== "undefined" ? window.__SWARMVAULT_EMBEDDED_DATA__ : undefined;
}

function normalizeGraphTarget(value: string): string {
  return value.trim().toLowerCase();
}

type EmbeddedGraphPage = NonNullable<ViewerGraphArtifact["pages"]>[number];

function embeddedNodeById(graph: ViewerGraphArtifact): Map<string, ViewerGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function embeddedPageById(graph: ViewerGraphArtifact): Map<string, EmbeddedGraphPage> {
  return new Map((graph.pages ?? []).map((page) => [page.id, page]));
}

function embeddedResolveNode(graph: ViewerGraphArtifact, target: string): ViewerGraphNode | null {
  const normalized = normalizeGraphTarget(target);
  return (
    graph.nodes.find((node) => node.id === target || normalizeGraphTarget(node.label) === normalized || node.pageId === target) ?? null
  );
}

function embeddedGraphAdjacency(graph: ViewerGraphArtifact) {
  const adjacency = new Map<string, Array<{ nodeId: string; edge: ViewerGraphEdge; direction: "incoming" | "outgoing" }>>();

  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.push({
      nodeId: edge.target,
      edge,
      direction: "outgoing"
    });
    adjacency.get(edge.target)?.push({
      nodeId: edge.source,
      edge,
      direction: "incoming"
    });
  }

  return adjacency;
}

function shortestEmbeddedGraphPath(graph: ViewerGraphArtifact, from: string, to: string): ViewerGraphPathResult {
  const start = embeddedResolveNode(graph, from);
  const end = embeddedResolveNode(graph, to);
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

  const adjacency = embeddedGraphAdjacency(graph);
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
      previous.set(neighbor.nodeId, {
        nodeId: current,
        edgeId: neighbor.edge.id
      });
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

  const nodes = embeddedNodeById(graph);
  const pageIds = [
    ...new Set(
      nodeIds.flatMap((nodeId) => {
        const pageId = nodes.get(nodeId)?.pageId;
        return pageId ? [pageId] : [];
      })
    )
  ];

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

function explainEmbeddedGraphTarget(graph: ViewerGraphArtifact, target: string): ViewerGraphExplainResult {
  const node = embeddedResolveNode(graph, target);
  if (!node) {
    throw new Error(`Could not resolve graph target: ${target}`);
  }

  const pages = embeddedPageById(graph);
  const page = node.pageId ? pages.get(node.pageId) : undefined;
  const nodes = embeddedNodeById(graph);
  const neighbors: ViewerGraphExplainResult["neighbors"] = [];
  for (const neighbor of embeddedGraphAdjacency(graph).get(node.id) ?? []) {
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
      confidence: neighbor.edge.confidence ?? 0,
      evidenceClass: neighbor.edge.evidenceClass ?? "unknown"
    });
  }
  neighbors.sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));

  const hyperedges = (graph.hyperedges ?? []).filter((hyperedge) => hyperedge.nodeIds.includes(node.id));
  const community = graph.communities?.find((candidate) => candidate.id === node.communityId);

  return {
    target,
    node,
    page: page
      ? {
          id: page.id,
          path: page.path,
          title: page.title
        }
      : undefined,
    community: community
      ? {
          id: community.id,
          label: community.label
        }
      : undefined,
    neighbors,
    hyperedges,
    summary: [
      `Node: ${node.label}`,
      `Type: ${node.type}`,
      `Community: ${node.communityId ?? "none"}`,
      `Neighbors: ${neighbors.length}`,
      `Group patterns: ${hyperedges.length}`,
      `Page: ${page?.path ?? "none"}`
    ].join("\n")
  };
}

type GraphQueryMatch = ViewerGraphQueryResult["matches"][number];

const _NODE_TYPE_PRIORITY: Record<string, number> = {
  concept: 6,
  entity: 5,
  source: 4,
  module: 3,
  symbol: 2,
  rationale: 1
};

function uniqueByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(item);
  }
  return result;
}

function embeddedScoreMatch(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!q || !c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80;
  if (c.includes(q)) return 60;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const cTokens = new Set(c.split(/\s+/).filter(Boolean));
  const overlap = qTokens.filter((token) => cTokens.has(token)).length;
  return overlap ? overlap * 10 : 0;
}

function embeddedGraphQuery(
  graph: ViewerGraphArtifact,
  question: string,
  searchResults: ViewerSearchResult[],
  options?: { traversal?: "bfs" | "dfs"; budget?: number }
): ViewerGraphQueryResult {
  const traversal = options?.traversal ?? "bfs";
  const budget = Math.max(3, Math.min(options?.budget ?? 12, 50));
  const pagesById = new Map((graph.pages ?? []).map((page) => [page.id, page]));

  const pageMatchesRaw = searchResults.map((result) => {
    const page = pagesById.get(result.pageId);
    const score = Math.max(embeddedScoreMatch(question, result.title), embeddedScoreMatch(question, result.path));
    if (!page || score <= 0) return null;
    return { type: "page" as const, id: page.id, label: page.title, score };
  });
  const pageMatches: GraphQueryMatch[] = pageMatchesRaw.filter(
    (match): match is { type: "page"; id: string; label: string; score: number } => match !== null
  );

  const nodeMatches: GraphQueryMatch[] = graph.nodes
    .map((node) => ({
      type: "node" as const,
      id: node.id,
      label: node.label,
      score: Math.max(embeddedScoreMatch(question, node.label), embeddedScoreMatch(question, node.id))
    }))
    .filter((match) => match.score > 0);

  const hyperedgeMatches: GraphQueryMatch[] = (graph.hyperedges ?? [])
    .map((hyperedge) => ({
      type: "hyperedge" as const,
      id: hyperedge.id,
      label: hyperedge.label,
      score: Math.max(
        embeddedScoreMatch(question, hyperedge.label),
        embeddedScoreMatch(question, hyperedge.why),
        embeddedScoreMatch(question, hyperedge.relation)
      )
    }))
    .filter((match) => match.score > 0);

  const matches = uniqueByKey([...pageMatches, ...nodeMatches, ...hyperedgeMatches], (match) => `${match.type}:${match.id}`)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 12);

  const seeds = uniqueByKey(
    [
      ...searchResults.flatMap((result) => pagesById.get(result.pageId)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "page").flatMap((match) => pagesById.get(match.id)?.nodeIds ?? []),
      ...matches.filter((match) => match.type === "node").map((match) => match.id),
      ...matches
        .filter((match) => match.type === "hyperedge")
        .flatMap((match) => (graph.hyperedges ?? []).find((hyperedge) => hyperedge.id === match.id)?.nodeIds ?? [])
    ],
    (item) => item
  ).filter(Boolean);

  type EdgeNeighbor = { edge: ViewerGraphEdge; nodeId: string; direction: "incoming" | "outgoing" };
  const adjacency = new Map<string, EdgeNeighbor[]>();
  const pushNeighbor = (nodeId: string, neighbor: EdgeNeighbor) => {
    if (!adjacency.has(nodeId)) adjacency.set(nodeId, []);
    adjacency.get(nodeId)?.push(neighbor);
  };
  for (const edge of graph.edges) {
    pushNeighbor(edge.source, { edge, nodeId: edge.target, direction: "outgoing" });
    pushNeighbor(edge.target, { edge, nodeId: edge.source, direction: "incoming" });
  }
  for (const [nodeId, items] of adjacency.entries()) {
    items.sort(
      (left, right) => (right.edge.confidence ?? 0) - (left.edge.confidence ?? 0) || left.edge.relation.localeCompare(right.edge.relation)
    );
    adjacency.set(nodeId, items);
  }

  const visitedNodeIds: string[] = [];
  const visitedEdgeIds = new Set<string>();
  const seen = new Set<string>();
  const frontier = [...seeds];

  while (frontier.length && visitedNodeIds.length < budget) {
    const current = traversal === "dfs" ? frontier.pop() : frontier.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    visitedNodeIds.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      visitedEdgeIds.add(neighbor.edge.id);
      if (!seen.has(neighbor.nodeId)) frontier.push(neighbor.nodeId);
      if (visitedNodeIds.length + frontier.length >= budget * 2) break;
    }
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const pageIds = uniqueByKey(
    [
      ...searchResults.map((result) => result.pageId),
      ...matches.filter((match) => match.type === "page").map((match) => match.id),
      ...visitedNodeIds.flatMap((nodeId) => {
        const node = nodesById.get(nodeId);
        return node?.pageId ? [node.pageId] : [];
      })
    ],
    (item) => item
  );
  const communities = uniqueByKey(
    visitedNodeIds.map((nodeId) => nodesById.get(nodeId)?.communityId).filter((communityId): communityId is string => Boolean(communityId)),
    (item) => item
  );
  const hyperedgeIds = uniqueByKey(
    (graph.hyperedges ?? [])
      .filter((hyperedge) => hyperedge.nodeIds.some((nodeId) => visitedNodeIds.includes(nodeId)))
      .map((hyperedge) => hyperedge.id),
    (item) => item
  );

  return {
    question,
    traversal,
    seedNodeIds: seeds,
    seedPageIds: uniqueByKey(
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

function normalizeSnippet(content: string, query: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!query) {
    return normalized.slice(0, 160);
  }
  const index = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) {
    return normalized.slice(0, 160);
  }
  const start = Math.max(0, index - 50);
  const end = Math.min(normalized.length, index + Math.max(query.length, 40));
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

export type ViewerSearchOptions = {
  limit?: number;
  kind?: string;
  status?: string;
  project?: string;
  sourceType?: string;
  sourceClass?: string;
};

export async function fetchGraphArtifact(input = "/api/graph", init?: RequestInit): Promise<ViewerGraphArtifact> {
  const embedded = embeddedData();
  if (embedded) {
    return embedded.graph;
  }

  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Failed to load graph artifact: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<ViewerGraphArtifact>;
}

export async function searchViewerPages(query: string, options: ViewerSearchOptions = {}): Promise<ViewerSearchResult[]> {
  const embedded = embeddedData();
  const limit = options.limit ?? 10;
  const kind = options.kind ?? "all";
  const status = options.status ?? "all";
  const project = options.project ?? "all";
  const sourceType = options.sourceType ?? "all";
  const sourceClass = options.sourceClass ?? "all";
  if (embedded) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }
    return embedded.pages
      .filter((page) => (kind === "all" ? true : page.kind === kind))
      .filter((page) => (status === "all" ? true : page.status === status))
      .filter((page) =>
        project === "all" ? true : project === "unassigned" ? page.projectIds.length === 0 : page.projectIds.includes(project)
      )
      .filter((page) => (sourceType === "all" ? true : (page.sourceType ?? "") === sourceType))
      .filter((page) => (sourceClass === "all" ? true : (page.sourceClass ?? "") === sourceClass))
      .map((page) => {
        const haystack = `${page.title}\n${page.content}`.toLowerCase();
        const score = haystack.includes(normalizedQuery) ? haystack.indexOf(normalizedQuery) : Number.POSITIVE_INFINITY;
        return {
          pageId: page.pageId,
          path: page.path,
          title: page.title,
          snippet: normalizeSnippet(page.content, query),
          rank: score,
          kind: page.kind,
          status: page.status,
          projectIds: page.projectIds,
          sourceType: page.sourceType,
          sourceClass: page.sourceClass
        };
      })
      .filter((page) => Number.isFinite(page.rank))
      .sort((left, right) => left.rank - right.rank || left.title.localeCompare(right.title))
      .slice(0, limit);
  }

  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    kind,
    status,
    project,
    sourceType,
    sourceClass
  });
  const response = await fetch(`/api/search?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to search pages: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerSearchResult[]>;
}

export async function fetchViewerPage(path: string): Promise<ViewerPagePayload> {
  const embedded = embeddedData();
  if (embedded) {
    const page = embedded.pages.find((candidate) => candidate.path === path);
    if (!page) {
      throw new Error(`Page not found: ${path}`);
    }
    return {
      path: page.path,
      title: page.title,
      frontmatter: {
        page_id: page.pageId,
        kind: page.kind,
        status: page.status,
        project_ids: page.projectIds,
        source_type: page.sourceType,
        source_class: page.sourceClass
      },
      content: page.content,
      assets: page.assets ?? []
    };
  }

  const response = await fetch(`/api/page?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error(`Failed to load page: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerPagePayload>;
}

export async function fetchGraphQuery(
  question: string,
  options: {
    traversal?: "bfs" | "dfs";
    budget?: number;
  } = {}
): Promise<ViewerGraphQueryResult> {
  const embedded = embeddedData();
  if (embedded) {
    const searchResults = await searchViewerPages(question, { limit: 10 });
    return embeddedGraphQuery(embedded.graph, question, searchResults, options);
  }
  const params = new URLSearchParams({
    q: question,
    traversal: options.traversal ?? "bfs",
    budget: String(options.budget ?? 12)
  });
  const response = await fetch(`/api/graph/query?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to query graph: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerGraphQueryResult>;
}

export async function fetchGraphReport(): Promise<ViewerGraphReport | null> {
  const embedded = embeddedData();
  if (embedded) {
    return embedded.report ?? null;
  }
  const response = await fetch("/api/graph-report");
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to load graph report: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerGraphReport>;
}

export async function fetchGraphPath(from: string, to: string): Promise<ViewerGraphPathResult> {
  const embedded = embeddedData();
  if (embedded) {
    return shortestEmbeddedGraphPath(embedded.graph, from, to);
  }
  const params = new URLSearchParams({
    from,
    to
  });
  const response = await fetch(`/api/graph/path?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to find graph path: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerGraphPathResult>;
}

export async function fetchGraphExplain(target: string): Promise<ViewerGraphExplainResult> {
  const embedded = embeddedData();
  if (embedded) {
    return explainEmbeddedGraphTarget(embedded.graph, target);
  }
  const response = await fetch(`/api/graph/explain?target=${encodeURIComponent(target)}`);
  if (!response.ok) {
    throw new Error(`Failed to explain graph target: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerGraphExplainResult>;
}

export async function fetchApprovals(): Promise<ViewerApprovalSummary[]> {
  if (embeddedData()) {
    return [];
  }
  const response = await fetch("/api/reviews");
  if (!response.ok) {
    throw new Error(`Failed to load approvals: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerApprovalSummary[]>;
}

export async function fetchApprovalDetail(approvalId: string): Promise<ViewerApprovalDetail> {
  if (embeddedData()) {
    throw new Error("Review actions are unavailable in standalone exports.");
  }
  const response = await fetch(`/api/review?id=${encodeURIComponent(approvalId)}`);
  if (!response.ok) {
    throw new Error(`Failed to load approval detail: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerApprovalDetail>;
}

export async function applyReviewAction(
  approvalId: string,
  action: "accept" | "reject",
  targets: string[] = []
): Promise<ViewerReviewActionResult> {
  if (embeddedData()) {
    throw new Error("Review actions are unavailable in standalone exports.");
  }
  const response = await fetch(`/api/review?action=${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approvalId, targets })
  });
  if (!response.ok) {
    throw new Error(`Failed to ${action} review entries: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerReviewActionResult>;
}

export async function fetchCandidates(): Promise<ViewerCandidateRecord[]> {
  if (embeddedData()) {
    return [];
  }
  const response = await fetch("/api/candidates");
  if (!response.ok) {
    throw new Error(`Failed to load candidates: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerCandidateRecord[]>;
}

export async function applyCandidateAction(target: string, action: "promote" | "archive"): Promise<ViewerCandidateRecord> {
  if (embeddedData()) {
    throw new Error("Candidate actions are unavailable in standalone exports.");
  }
  const response = await fetch(`/api/candidate?action=${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target })
  });
  if (!response.ok) {
    throw new Error(`Failed to ${action} candidate: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerCandidateRecord>;
}

export async function fetchWatchStatus(): Promise<ViewerWatchStatus> {
  if (embeddedData()) {
    return {
      generatedAt: "",
      watchedRepoRoots: [],
      pendingSemanticRefresh: []
    };
  }
  const response = await fetch("/api/watch-status");
  if (!response.ok) {
    throw new Error(`Failed to load watch status: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerWatchStatus>;
}

export async function fetchLintFindings(): Promise<ViewerLintFinding[]> {
  if (embeddedData()) {
    return [];
  }
  const response = await fetch("/api/lint");
  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`Failed to load lint findings: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerLintFinding[]>;
}

export async function fetchWorkspaceBundle(): Promise<ViewerWorkspaceBundle | null> {
  if (embeddedData()) {
    return null;
  }
  const response = await fetch("/api/workspace");
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load workspace bundle: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<ViewerWorkspaceBundle>;
}

export type SubgraphExportPayload = {
  generatedAt: string;
  rootNodeId?: string;
  nodes: ViewerGraphNode[];
  edges: ViewerGraphEdge[];
};

export function buildSubgraphExport(graph: ViewerGraphArtifact, nodeIds: string[]): SubgraphExportPayload {
  const nodeSet = new Set(nodeIds);
  const nodes = graph.nodes.filter((node) => nodeSet.has(node.id));
  const edges = graph.edges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target));
  return {
    generatedAt: new Date().toISOString(),
    rootNodeId: nodeIds[0],
    nodes,
    edges
  };
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  if (typeof document === "undefined") return;
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  downloadDataUrl(filename, url);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
