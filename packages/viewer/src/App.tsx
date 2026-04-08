import cytoscape, { type Core } from "cytoscape";
import { startTransition, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  applyCandidateAction,
  applyReviewAction,
  fetchApprovalDetail,
  fetchApprovals,
  fetchCandidates,
  fetchGraphArtifact,
  fetchGraphExplain,
  fetchGraphPath,
  fetchGraphQuery,
  fetchGraphReport,
  fetchViewerPage,
  fetchWatchStatus,
  searchViewerPages,
  type ViewerApprovalDetail,
  type ViewerApprovalSummary,
  type ViewerCandidateRecord,
  type ViewerGraphArtifact,
  type ViewerGraphExplainResult,
  type ViewerGraphNode,
  type ViewerGraphPathResult,
  type ViewerGraphQueryResult,
  type ViewerGraphReport,
  type ViewerOutputAsset,
  type ViewerPagePayload,
  type ViewerSearchResult,
  type ViewerWatchStatus
} from "./lib";

const COLORS: Record<string, string> = {
  source: "#f59e0b",
  module: "#fb7185",
  symbol: "#8b5cf6",
  rationale: "#14b8a6",
  concept: "#0ea5e9",
  entity: "#22c55e"
};

function snippetFromContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 220);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function emptyGraph(): ViewerGraphArtifact {
  return { generatedAt: "", nodes: [], edges: [], hyperedges: [], communities: [], pages: [] };
}

function assetUrl(asset: ViewerOutputAsset): string {
  return asset.dataUrl ?? `/api/asset?path=${encodeURIComponent(asset.path)}`;
}

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [graph, setGraph] = useState<ViewerGraphArtifact | null>(null);
  const [selected, setSelected] = useState<ViewerGraphNode | null>(null);
  const [edgeStatusFilter, setEdgeStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [pageStatusFilter, setPageStatusFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [communityFilter, setCommunityFilter] = useState<string>("all");
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string>("all");
  const [sourceClassFilter, setSourceClassFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ViewerSearchResult[]>([]);
  const [graphReport, setGraphReport] = useState<ViewerGraphReport | null>(null);
  const [graphQueryInput, setGraphQueryInput] = useState("");
  const [graphQueryResult, setGraphQueryResult] = useState<ViewerGraphQueryResult | null>(null);
  const [pathFrom, setPathFrom] = useState("");
  const [pathTo, setPathTo] = useState("");
  const [pathResult, setPathResult] = useState<ViewerGraphPathResult | null>(null);
  const [graphExplain, setGraphExplain] = useState<ViewerGraphExplainResult | null>(null);
  const [activePage, setActivePage] = useState<ViewerPagePayload | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ViewerApprovalSummary[]>([]);
  const [approvalDetail, setApprovalDetail] = useState<ViewerApprovalDetail | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string>("");
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ViewerCandidateRecord[]>([]);
  const [watchStatus, setWatchStatus] = useState<ViewerWatchStatus | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string>("");
  const deferredQuery = useDeferredValue(query);
  const currentGraphPage =
    activePage && graph
      ? (graph.pages?.find(
          (page) =>
            page.path === activePage.path ||
            page.id === (typeof activePage.frontmatter.page_id === "string" ? activePage.frontmatter.page_id : "")
        ) ?? null)
      : null;
  const projectOptions = uniqueStrings(graph?.pages?.flatMap((page) => page.projectIds ?? []) ?? []).sort((left, right) =>
    left.localeCompare(right)
  );
  const sourceTypeOptions = uniqueStrings(
    graph?.pages
      ?.flatMap((page) => (page.kind === "source" && page.sourceType ? [page.sourceType] : []))
      .sort((left, right) => left.localeCompare(right)) ?? []
  );
  const sourceClassOptions = uniqueStrings(
    graph?.pages?.flatMap((page) => (page.sourceClass ? [page.sourceClass] : [])).sort((left, right) => left.localeCompare(right)) ?? []
  );
  const communityOptions = uniqueStrings((graph?.communities ?? []).map((community) => community.id)).sort((left, right) =>
    left.localeCompare(right)
  );
  const backlinkPages = currentGraphPage
    ? uniqueStrings(currentGraphPage.backlinks)
        .map((pageId) => graph?.pages?.find((page) => page.id === pageId) ?? null)
        .filter((page): page is NonNullable<typeof page> => Boolean(page))
    : [];
  const relatedPages = currentGraphPage
    ? uniqueStrings(currentGraphPage.relatedPageIds)
        .map((pageId) => graph?.pages?.find((page) => page.id === pageId) ?? null)
        .filter((page): page is NonNullable<typeof page> => Boolean(page))
    : [];
  const graphPageLinks = graph?.pages?.filter((page) => page.kind === "graph_report" || page.kind === "community_summary") ?? [];

  const refreshWorkspace = useCallback(async () => {
    let nextApprovalError: string | null = null;
    let nextCandidateError: string | null = null;
    let nextWatchError: string | null = null;
    let nextGraphReport: ViewerGraphReport | null = null;
    const [nextGraph, nextApprovals, nextCandidates, nextWatchStatus] = await Promise.all([
      fetchGraphArtifact().catch(() => emptyGraph()),
      fetchApprovals().catch((error: unknown) => {
        nextApprovalError = error instanceof Error ? error.message : String(error);
        return [];
      }),
      fetchCandidates().catch((error: unknown) => {
        nextCandidateError = error instanceof Error ? error.message : String(error);
        return [];
      }),
      fetchWatchStatus().catch((error: unknown) => {
        nextWatchError = error instanceof Error ? error.message : String(error);
        return {
          generatedAt: "",
          watchedRepoRoots: [],
          pendingSemanticRefresh: []
        } satisfies ViewerWatchStatus;
      })
    ]);
    nextGraphReport = await fetchGraphReport().catch(() => null);

    startTransition(() => {
      setGraph(nextGraph);
      setGraphReport(nextGraphReport);
      setApprovals(nextApprovals);
      setCandidates(nextCandidates);
      setWatchStatus(nextWatchStatus);
      setApprovalError(nextApprovalError);
      setCandidateError(nextCandidateError);
      setWatchError(nextWatchError);
    });
  }, []);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    if (!approvals.length) {
      setSelectedApprovalId("");
      setApprovalDetail(null);
      return;
    }
    if (!selectedApprovalId || !approvals.some((approval) => approval.approvalId === selectedApprovalId)) {
      setSelectedApprovalId(approvals[0]?.approvalId ?? "");
    }
  }, [approvals, selectedApprovalId]);

  useEffect(() => {
    if (!selectedApprovalId) {
      return;
    }
    let cancelled = false;
    void fetchApprovalDetail(selectedApprovalId)
      .then((detail) => {
        if (!cancelled) {
          setApprovalDetail(detail);
          setApprovalError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setApprovalError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedApprovalId]);

  useEffect(() => {
    if (!containerRef.current || !graph) {
      return;
    }

    const allowedNodeIds = new Set(
      graph.nodes
        .filter((node) => communityFilter === "all" || node.communityId === communityFilter)
        .filter((node) => sourceClassFilter === "all" || (node.sourceClass ?? "") === sourceClassFilter)
        .map((node) => node.id)
    );
    const pathNodeSet = new Set(pathResult?.nodeIds ?? []);
    const pathEdgeSet = new Set(pathResult?.edgeIds ?? []);
    cyRef.current?.destroy();
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...graph.nodes
          .filter((node) => allowedNodeIds.has(node.id))
          .map((node) => ({
            data: { ...node, color: COLORS[node.type] ?? "#94a3b8" },
            classes: pathNodeSet.has(node.id) ? "path-node" : ""
          })),
        ...graph.edges
          .filter((edge) => allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target))
          .filter((edge) => edgeStatusFilter === "all" || edge.status === edgeStatusFilter)
          .map((edge) => ({
            data: edge,
            classes:
              `${pathEdgeSet.has(edge.id) ? "path-edge " : ""}${edge.relation === "semantically_similar_to" ? "similarity-edge" : ""}`.trim()
          }))
      ],
      layout: {
        name: "cose",
        animate: false,
        idealEdgeLength: 120,
        nodeRepulsion: 8_000
      },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(color)",
            color: "#f8fafc",
            "text-outline-color": "#020617",
            "text-outline-width": 2,
            "font-family": '"Avenir Next", "Segoe UI", sans-serif',
            "font-size": 11
          }
        },
        {
          selector: "node[?isGodNode]",
          style: {
            width: 56,
            height: 56,
            "border-width": 3,
            "border-color": "#fef08a"
          }
        },
        {
          selector: 'node[type = "module"]',
          style: {
            shape: "round-rectangle",
            width: 48,
            height: 30
          }
        },
        {
          selector: 'node[type = "symbol"]',
          style: {
            shape: "diamond",
            width: 28,
            height: 28,
            "font-size": 9
          }
        },
        {
          selector: 'node[type = "rationale"]',
          style: {
            shape: "hexagon",
            width: 34,
            height: 34
          }
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#64748b",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#64748b",
            "curve-style": "bezier",
            label: "data(relation)",
            "font-size": 9,
            color: "#cbd5e1"
          }
        },
        {
          selector: ".similarity-edge",
          style: {
            "line-style": "dashed",
            "line-color": "#f97316",
            "target-arrow-color": "#f97316"
          }
        },
        {
          selector: ".path-node",
          style: {
            "border-width": 4,
            "border-color": "#38bdf8"
          }
        },
        {
          selector: ".path-edge",
          style: {
            width: 4,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8"
          }
        },
        {
          selector: ":selected",
          style: {
            "border-width": 3,
            "border-color": "#f8fafc"
          }
        }
      ]
    });

    cy.on("select", "node", (event) => {
      setSelected(event.target.data() as ViewerGraphNode);
    });
    cy.on("unselect", "node", () => {
      setSelected(null);
    });

    cyRef.current = cy;
    return () => cy.destroy();
  }, [communityFilter, edgeStatusFilter, graph, pathResult, sourceClassFilter]);

  useEffect(() => {
    if (!selected) {
      setGraphExplain(null);
      return;
    }
    let cancelled = false;
    void fetchGraphExplain(selected.id)
      .then((result) => {
        if (!cancelled) {
          setGraphExplain(result);
          setGraphError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setGraphError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();
    if (normalizedQuery.length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    void searchViewerPages(normalizedQuery, {
      limit: 10,
      kind: kindFilter,
      status: pageStatusFilter,
      project: projectFilter,
      sourceType: sourceTypeFilter,
      sourceClass: sourceClassFilter
    })
      .then((nextResults) => {
        if (!cancelled) {
          startTransition(() => {
            setResults(nextResults);
            setSearchError(null);
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSearchError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deferredQuery, kindFilter, pageStatusFilter, projectFilter, sourceTypeFilter, sourceClassFilter]);

  useEffect(() => {
    if (!selected?.pageId) {
      return;
    }
    const page = graph?.pages?.find((candidate) => candidate.id === selected.pageId);
    if (!page) {
      return;
    }

    let cancelled = false;
    void fetchViewerPage(page.path)
      .then((payload) => {
        if (!cancelled) {
          setActivePage(payload);
          setPageError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [graph, selected]);

  const openPagePath = async (pagePath: string, pageId?: string) => {
    try {
      const payload = await fetchViewerPage(pagePath);
      setActivePage(payload);
      setPageError(null);
      if (graph && cyRef.current) {
        const graphPage = graph.pages?.find((candidate) => candidate.path === pagePath || (pageId ? candidate.id === pageId : false));
        const node =
          (pageId ? graph.nodes.find((candidate) => candidate.pageId === pageId) : undefined) ??
          graph.nodes.find((candidate) => graphPage?.nodeIds?.includes(candidate.id));
        if (node) {
          cyRef.current.elements().unselect();
          cyRef.current.getElementById(node.id).select();
          cyRef.current.center(cyRef.current.getElementById(node.id));
        }
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  };

  const openResult = async (result: ViewerSearchResult) => {
    await openPagePath(result.path, result.pageId);
  };

  const handleReviewAction = async (pageId: string, action: "accept" | "reject") => {
    if (!selectedApprovalId) {
      return;
    }
    setBusyAction(`${action}:${pageId}`);
    setActionError(null);
    try {
      await applyReviewAction(selectedApprovalId, action, [pageId]);
      await refreshWorkspace();
      const detail = await fetchApprovalDetail(selectedApprovalId);
      setApprovalDetail(detail);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleCandidateAction = async (target: string, action: "promote" | "archive", nextPath?: string) => {
    setBusyAction(`${action}:${target}`);
    setActionError(null);
    try {
      const result = await applyCandidateAction(target, action);
      await refreshWorkspace();
      if (action === "promote") {
        await openPagePath(result.path, result.pageId);
      } else if (nextPath) {
        setActivePage(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction("");
    }
  };

  const handleGraphQuery = async () => {
    if (!graphQueryInput.trim()) {
      setGraphQueryResult(null);
      return;
    }
    try {
      const result = await fetchGraphQuery(graphQueryInput, { budget: 12 });
      setGraphQueryResult(result);
      setGraphError(null);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleGraphPath = async () => {
    if (!pathFrom.trim() || !pathTo.trim()) {
      setPathResult(null);
      return;
    }
    try {
      const result = await fetchGraphPath(pathFrom, pathTo);
      setPathResult(result);
      setGraphError(null);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main className="app-shell">
      <section className="app-header">
        <div>
          <p className="eyebrow">SwarmVault Viewer</p>
          <h1>Search, review, and promote the vault locally.</h1>
          <p className="lede">
            The graph, candidate queue, approval queue, and page previews stay in one local workspace instead of splitting review across
            tools.
          </p>
        </div>
        <div className="header-controls">
          <label className="filter">
            Edge status
            <select value={edgeStatusFilter} onChange={(event) => setEdgeStatusFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="extracted">Extracted</option>
              <option value="conflicted">Conflicted</option>
              <option value="inferred">Inferred</option>
              <option value="stale">Stale</option>
            </select>
          </label>
          <label className="filter">
            Page kind
            <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="source">Source</option>
              <option value="module">Module</option>
              <option value="concept">Concept</option>
              <option value="entity">Entity</option>
              <option value="output">Output</option>
              <option value="insight">Insight</option>
              <option value="graph_report">Graph report</option>
              <option value="community_summary">Community summary</option>
              <option value="index">Index</option>
            </select>
          </label>
          <label className="filter">
            Page status
            <select value={pageStatusFilter} onChange={(event) => setPageStatusFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="candidate">Candidate</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="filter">
            Project
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="unassigned">Unassigned</option>
              {projectOptions.map((projectId) => (
                <option key={projectId} value={projectId}>
                  {projectId}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            Source type
            <select value={sourceTypeFilter} onChange={(event) => setSourceTypeFilter(event.target.value)}>
              <option value="all">All</option>
              {sourceTypeOptions.map((sourceType) => (
                <option key={sourceType} value={sourceType}>
                  {sourceType}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            Source class
            <select value={sourceClassFilter} onChange={(event) => setSourceClassFilter(event.target.value)}>
              <option value="all">All</option>
              {sourceClassOptions.map((sourceClass) => (
                <option key={sourceClass} value={sourceClass}>
                  {sourceClass}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            Community
            <select value={communityFilter} onChange={(event) => setCommunityFilter(event.target.value)}>
              <option value="all">All</option>
              {communityOptions.map((communityId) => (
                <option key={communityId} value={communityId}>
                  {communityId}
                </option>
              ))}
            </select>
          </label>
          <label className="filter search">
            Search pages
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search wiki pages, outputs, and candidates"
            />
          </label>
        </div>
      </section>

      <section className="stats">
        <article>
          <span>Generated</span>
          <strong>{graph?.generatedAt ? new Date(graph.generatedAt).toLocaleString() : "Not compiled"}</strong>
        </article>
        <article>
          <span>Nodes</span>
          <strong>{graph?.nodes.length ?? 0}</strong>
        </article>
        <article>
          <span>Approvals</span>
          <strong>{approvals.reduce((total, approval) => total + approval.pendingCount, 0)}</strong>
        </article>
        <article>
          <span>Candidates</span>
          <strong>{candidates.length}</strong>
        </article>
        <article>
          <span>Pending Refresh</span>
          <strong>{watchStatus?.pendingSemanticRefresh.length ?? 0}</strong>
        </article>
        <article>
          <span>Benchmark</span>
          <strong>{graphReport?.benchmark ? `${(graphReport.benchmark.summary.reductionRatio * 100).toFixed(1)}%` : "Not run"}</strong>
        </article>
      </section>

      {watchStatus?.pendingSemanticRefresh.length ? (
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <h2>Pending Semantic Refresh</h2>
          <p>
            Repo watch detected non-code changes under watched repos. These files are flagged for manual ingest/compile instead of being
            auto-semantic-refreshed.
          </p>
          <p>
            Watched roots: {watchStatus.watchedRepoRoots.length ? watchStatus.watchedRepoRoots.join(", ") : "none"}
            {watchStatus.lastRun?.finishedAt ? ` • Last run: ${new Date(watchStatus.lastRun.finishedAt).toLocaleString()}` : ""}
          </p>
          {watchError ? <p>{watchError}</p> : null}
          <div className="review-list">
            {watchStatus.pendingSemanticRefresh.slice(0, 8).map((entry) => (
              <article key={entry.id} className="review-card">
                <span className="panel-label">{entry.changeType}</span>
                <strong>{entry.path}</strong>
                <p>{entry.sourceKind ? `Kind: ${entry.sourceKind}` : "Awaiting semantic refresh."}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {graphReport ? (
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <h2>Graph Report</h2>
          <p>
            Nodes {graphReport.overview.nodes} • Edges {graphReport.overview.edges} • Communities {graphReport.overview.communities}
          </p>
          <p>
            First-party focus {graphReport.firstPartyOverview.nodes} nodes • {graphReport.firstPartyOverview.edges} edges •{" "}
            {graphReport.firstPartyOverview.communities} communities
          </p>
          {graphReport.warnings.length ? (
            <div className="linked-pages">
              <span className="panel-label">Warnings</span>
              <div className="results">
                {graphReport.warnings.map((warning) => (
                  <article key={warning} className="result-card">
                    <p>{warning}</p>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {graphReport.benchmark ? (
            <p>
              Benchmark {graphReport.benchmark.stale ? "stale" : "fresh"} • final context {graphReport.benchmark.summary.finalContextTokens}{" "}
              • naive corpus {graphReport.benchmark.summary.naiveCorpusTokens} • reduction{" "}
              {(graphReport.benchmark.summary.reductionRatio * 100).toFixed(1)}%
            </p>
          ) : (
            <p>No benchmark summary is available yet.</p>
          )}
          {graphReport.surprisingConnections.length ? (
            <div className="linked-pages">
              <span className="panel-label">Surprising Connections</span>
              <div className="action-row">
                {graphReport.surprisingConnections.slice(0, 4).map((connection) => (
                  <button
                    key={connection.id}
                    type="button"
                    className="link-button"
                    onClick={() => {
                      setPathFrom(connection.sourceNodeId);
                      setPathTo(connection.targetNodeId);
                      void (async () => {
                        try {
                          const result = await fetchGraphPath(connection.sourceNodeId, connection.targetNodeId);
                          setPathResult(result);
                          setGraphError(null);
                        } catch (error) {
                          setGraphError(error instanceof Error ? error.message : String(error));
                        }
                      })();
                    }}
                  >
                    {connection.sourceLabel} {"->"} {connection.targetLabel}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {graphReport.groupPatterns.length ? (
            <div className="linked-pages">
              <span className="panel-label">Group Patterns</span>
              <div className="action-row">
                {graphReport.groupPatterns.slice(0, 4).map((hyperedge) => (
                  <button
                    key={hyperedge.id}
                    type="button"
                    className="link-button"
                    onClick={() => {
                      const nextNodeId = hyperedge.nodeIds[0];
                      const element = nextNodeId ? cyRef.current?.getElementById(nextNodeId) : null;
                      if (element) {
                        cyRef.current?.elements().unselect();
                        element.select();
                        cyRef.current?.center(element);
                      }
                    }}
                  >
                    {hyperedge.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {graphReport.recentResearchSources.length ? (
            <div className="linked-pages">
              <span className="panel-label">New Research Sources</span>
              <div className="action-row">
                {graphReport.recentResearchSources.slice(0, 4).map((page) => (
                  <button key={page.pageId} type="button" className="link-button" onClick={() => void openPagePath(page.path, page.pageId)}>
                    {page.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="workspace">
        <div className="canvas" ref={containerRef} />
        <aside className="rail">
          <section className="panel">
            <h2>Graph Tools</h2>
            {graphError ? <p>{graphError}</p> : null}
            <div className="review-list">
              <article className="review-card">
                <span className="panel-label">query</span>
                <input
                  type="search"
                  value={graphQueryInput}
                  onChange={(event) => setGraphQueryInput(event.target.value)}
                  placeholder="Ask the local graph"
                />
                <button type="button" className="action-button" onClick={() => void handleGraphQuery()}>
                  Run
                </button>
                {graphQueryResult ? (
                  <>
                    <p>{graphQueryResult.summary}</p>
                    <div className="action-row">
                      {graphQueryResult.hyperedgeIds
                        .map((hyperedgeId) => graph?.hyperedges?.find((hyperedge) => hyperedge.id === hyperedgeId))
                        .filter((hyperedge): hyperedge is NonNullable<typeof hyperedge> => Boolean(hyperedge))
                        .slice(0, 2)
                        .map((hyperedge) => (
                          <button
                            key={hyperedge.id}
                            type="button"
                            className="link-button"
                            onClick={() => {
                              const nextNodeId = hyperedge.nodeIds[0];
                              const element = nextNodeId ? cyRef.current?.getElementById(nextNodeId) : null;
                              if (element) {
                                cyRef.current?.elements().unselect();
                                element.select();
                                cyRef.current?.center(element);
                              }
                            }}
                          >
                            {hyperedge.label}
                          </button>
                        ))}
                      {graphQueryResult.pageIds
                        .map((pageId) => graph?.pages?.find((page) => page.id === pageId))
                        .filter((page): page is NonNullable<typeof page> => Boolean(page))
                        .slice(0, 4)
                        .map((page) => (
                          <button key={page.id} type="button" className="link-button" onClick={() => void openPagePath(page.path, page.id)}>
                            {page.title}
                          </button>
                        ))}
                    </div>
                  </>
                ) : null}
              </article>
              <article className="review-card">
                <span className="panel-label">path</span>
                <input type="text" value={pathFrom} onChange={(event) => setPathFrom(event.target.value)} placeholder="From" />
                <input type="text" value={pathTo} onChange={(event) => setPathTo(event.target.value)} placeholder="To" />
                <button type="button" className="action-button" onClick={() => void handleGraphPath()}>
                  Highlight
                </button>
                {pathResult ? <p>{pathResult.summary}</p> : null}
              </article>
            </div>
          </section>

          <section className="panel">
            <h2>Search Results</h2>
            {searchError ? <p>{searchError}</p> : null}
            {results.length ? (
              <div className="results">
                {results.map((result) => (
                  <button
                    key={`${result.pageId}:${result.path}`}
                    type="button"
                    className="result-card"
                    onClick={() => void openResult(result)}
                  >
                    <span className="panel-label">
                      {result.kind ?? "page"} / {result.status ?? "active"}
                    </span>
                    <strong>{result.title}</strong>
                    {result.sourceType ? <p>Source type: {result.sourceType}</p> : null}
                    {result.sourceClass ? <p>Source class: {result.sourceClass}</p> : null}
                    <p>{result.projectIds.length ? result.projectIds.join(", ") : "global / unassigned"}</p>
                    <p>{result.snippet}</p>
                  </button>
                ))}
              </div>
            ) : (
              <p>{query.trim().length >= 2 ? "No pages matched this query." : "Search the wiki, outputs, or candidate pages."}</p>
            )}
          </section>

          <section className="panel">
            <h2>Approval Queue</h2>
            {approvalError ? <p>{approvalError}</p> : null}
            {actionError ? <p>{actionError}</p> : null}
            {approvals.length ? (
              <div className="results">
                {approvals.map((approval) => (
                  <button
                    key={approval.approvalId}
                    type="button"
                    className={`result-card ${selectedApprovalId === approval.approvalId ? "is-active" : ""}`}
                    onClick={() => setSelectedApprovalId(approval.approvalId)}
                  >
                    <span className="panel-label">pending {approval.pendingCount}</span>
                    <strong>{approval.approvalId}</strong>
                    <p>
                      accepted {approval.acceptedCount} / rejected {approval.rejectedCount}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <p>No staged approval bundles.</p>
            )}
            {approvalDetail?.entries.length ? (
              <div className="review-list">
                {approvalDetail.entries.map((entry) => (
                  <article key={`${entry.pageId}:${entry.nextPath ?? entry.previousPath ?? entry.changeType}`} className="review-card">
                    <span className="panel-label">
                      {entry.status} / {entry.changeType}
                    </span>
                    <strong>{entry.title}</strong>
                    <p>{entry.nextPath ?? entry.previousPath}</p>
                    {entry.stagedContent ? (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void openPagePath(entry.nextPath ?? entry.previousPath ?? "", entry.pageId)}
                      >
                        Open page
                      </button>
                    ) : null}
                    {entry.status === "pending" ? (
                      <div className="action-row">
                        <button
                          type="button"
                          className="action-button"
                          disabled={busyAction === `accept:${entry.pageId}`}
                          onClick={() => void handleReviewAction(entry.pageId, "accept")}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="action-button danger"
                          disabled={busyAction === `reject:${entry.pageId}`}
                          onClick={() => void handleReviewAction(entry.pageId, "reject")}
                        >
                          Reject
                        </button>
                      </div>
                    ) : (
                      <p>{entry.currentContent ? snippetFromContent(entry.currentContent) : "No current content on disk."}</p>
                    )}
                  </article>
                ))}
              </div>
            ) : null}
          </section>

          <section className="panel">
            <h2>Candidate Queue</h2>
            {candidateError ? <p>{candidateError}</p> : null}
            {candidates.length ? (
              <div className="review-list">
                {candidates.map((candidate) => (
                  <article key={candidate.pageId} className="review-card">
                    <span className="panel-label">{candidate.kind}</span>
                    <strong>{candidate.title}</strong>
                    <p>{candidate.path}</p>
                    <button type="button" className="link-button" onClick={() => void openPagePath(candidate.path, candidate.pageId)}>
                      Open candidate
                    </button>
                    <div className="action-row">
                      <button
                        type="button"
                        className="action-button"
                        disabled={busyAction === `promote:${candidate.pageId}`}
                        onClick={() => void handleCandidateAction(candidate.pageId, "promote", candidate.activePath)}
                      >
                        Promote
                      </button>
                      <button
                        type="button"
                        className="action-button danger"
                        disabled={busyAction === `archive:${candidate.pageId}`}
                        onClick={() => void handleCandidateAction(candidate.pageId, "archive", candidate.path)}
                      >
                        Archive
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p>No candidate pages are waiting for review.</p>
            )}
          </section>

          <section className="panel">
            <h2>Selection</h2>
            {selected ? (
              <>
                <p className="panel-label">{selected.type}</p>
                <h3>{selected.label}</h3>
                <p>
                  Node ID: <code>{selected.id}</code>
                </p>
                {selected.language ? <p>Language: {selected.language}</p> : null}
                {selected.symbolKind ? <p>Symbol kind: {selected.symbolKind}</p> : null}
                {selected.moduleId ? <p>Module ID: {selected.moduleId}</p> : null}
                <p>Sources: {selected.sourceIds.join(", ") || "None"}</p>
                <p>Projects: {selected.projectIds.join(", ") || "Global / unassigned"}</p>
                <p>Community: {selected.communityId ?? "Unassigned"}</p>
                <p>Degree: {selected.degree ?? 0}</p>
                <p>Bridge score: {selected.bridgeScore ?? 0}</p>
                <p>God node: {selected.isGodNode ? "Yes" : "No"}</p>
                {graphExplain?.hyperedges.length ? (
                  <div className="linked-pages">
                    <span className="panel-label">Group Patterns</span>
                    <div className="action-row">
                      {graphExplain.hyperedges.slice(0, 6).map((hyperedge) => (
                        <button
                          key={hyperedge.id}
                          type="button"
                          className="link-button"
                          onClick={() => {
                            const nextNodeId = hyperedge.nodeIds.find((nodeId) => nodeId !== selected.id) ?? hyperedge.nodeIds[0];
                            const element = nextNodeId ? cyRef.current?.getElementById(nextNodeId) : null;
                            if (element) {
                              cyRef.current?.elements().unselect();
                              element.select();
                              cyRef.current?.center(element);
                            }
                          }}
                        >
                          {hyperedge.label}
                        </button>
                      ))}
                    </div>
                    <p>{graphExplain.hyperedges[0]?.why}</p>
                  </div>
                ) : null}
                {graphExplain?.neighbors.length ? (
                  <div className="linked-pages">
                    <span className="panel-label">Neighbors</span>
                    <div className="action-row">
                      {graphExplain.neighbors.slice(0, 8).map((neighbor) => (
                        <button
                          key={`${neighbor.direction}:${neighbor.nodeId}:${neighbor.relation}`}
                          type="button"
                          className="link-button"
                          onClick={() => {
                            const element = cyRef.current?.getElementById(neighbor.nodeId);
                            if (element) {
                              cyRef.current?.elements().unselect();
                              element.select();
                              cyRef.current?.center(element);
                            }
                          }}
                        >
                          {neighbor.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p>Select a node to inspect graph metrics and linked pages.</p>
            )}
          </section>

          <section className="panel page-panel">
            <h2>Page Preview</h2>
            {pageError ? <p>{pageError}</p> : null}
            {activePage ? (
              <>
                <span className="panel-label">{activePage.path}</span>
                <h3>{activePage.title}</h3>
                <p>
                  {typeof activePage.frontmatter.kind === "string" ? activePage.frontmatter.kind : "page"} /{" "}
                  {typeof activePage.frontmatter.status === "string" ? activePage.frontmatter.status : "active"}
                </p>
                {typeof activePage.frontmatter.source_type === "string" ? <p>Source type: {activePage.frontmatter.source_type}</p> : null}
                <p>
                  Projects:{" "}
                  {Array.isArray(activePage.frontmatter.project_ids)
                    ? (activePage.frontmatter.project_ids as string[]).join(", ") || "Global / unassigned"
                    : "Global / unassigned"}
                </p>
                <p>{snippetFromContent(activePage.content)}</p>
                {activePage.assets.length ? (
                  <div className="asset-preview">
                    {activePage.assets.map((asset) =>
                      asset.mimeType.startsWith("image/") ? (
                        <figure key={asset.id} className="asset-card">
                          <img src={assetUrl(asset)} alt={activePage.title} />
                          <figcaption>
                            {asset.role} / {asset.mimeType}
                          </figcaption>
                        </figure>
                      ) : (
                        <a key={asset.id} className="link-button" href={assetUrl(asset)} target="_blank" rel="noreferrer">
                          Open {asset.role}
                        </a>
                      )
                    )}
                  </div>
                ) : null}
                {backlinkPages.length ? (
                  <div className="linked-pages">
                    <span className="panel-label">Backlinks</span>
                    <div className="action-row">
                      {backlinkPages.map((page) => (
                        <button key={page.id} type="button" className="link-button" onClick={() => void openPagePath(page.path, page.id)}>
                          {page.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {relatedPages.length ? (
                  <div className="linked-pages">
                    <span className="panel-label">Related Pages</span>
                    <div className="action-row">
                      {relatedPages.map((page) => (
                        <button key={page.id} type="button" className="link-button" onClick={() => void openPagePath(page.path, page.id)}>
                          {page.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {graphPageLinks.length ? (
                  <div className="linked-pages">
                    <span className="panel-label">Graph Reports</span>
                    <div className="action-row">
                      {graphPageLinks.slice(0, 6).map((page) => (
                        <button key={page.id} type="button" className="link-button" onClick={() => void openPagePath(page.path, page.id)}>
                          {page.title}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                <pre>{activePage.content.slice(0, 1200)}</pre>
              </>
            ) : (
              <p>Open a search result, review entry, candidate, or graph node page.</p>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}
