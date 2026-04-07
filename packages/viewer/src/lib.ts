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
};

export type ViewerGraphPage = {
  pageId: string;
  path: string;
  title: string;
  kind: string;
  status: string;
  projectIds: string[];
  content: string;
  assets: ViewerOutputAsset[];
};

export type ViewerGraphArtifact = {
  generatedAt: string;
  nodes: ViewerGraphNode[];
  edges: ViewerGraphEdge[];
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
  pageIds: string[];
  communities: string[];
  summary: string;
  matches: Array<{
    type: "node" | "page";
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
};

declare global {
  interface Window {
    __SWARMVAULT_EMBEDDED_DATA__?: {
      graph: ViewerGraphArtifact;
      pages: ViewerGraphPage[];
    };
  }
}

function embeddedData() {
  return typeof window !== "undefined" ? window.__SWARMVAULT_EMBEDDED_DATA__ : undefined;
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
          projectIds: page.projectIds
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
    project
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
        project_ids: page.projectIds
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

export async function fetchGraphPath(from: string, to: string): Promise<ViewerGraphPathResult> {
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
