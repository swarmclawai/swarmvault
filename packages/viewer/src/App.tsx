import type { Core } from "cytoscape";
import { startTransition, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { ApprovalQueue } from "./components/ApprovalQueue";
import { CandidateList } from "./components/CandidateList";
import { FilterSidebar } from "./components/FilterSidebar";
import { GraphCanvas } from "./components/GraphCanvas";
import { GraphTools } from "./components/GraphTools";
import { PagePreview } from "./components/PagePreview";
import { PendingRefresh } from "./components/PendingRefresh";
import { ReportTabs } from "./components/ReportTabs";
import { SearchResults } from "./components/SearchResults";
import { SelectionPanel } from "./components/SelectionPanel";
import { StatsBar } from "./components/StatsBar";
import { Tabs } from "./components/Tabs";
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
  type ViewerPagePayload,
  type ViewerSearchResult,
  type ViewerWatchStatus
} from "./lib";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function emptyGraph(): ViewerGraphArtifact {
  return { generatedAt: "", nodes: [], edges: [], hyperedges: [], communities: [], pages: [] };
}

export function App() {
  const cyRef = useRef<Core | null>(null);

  // --- State ---
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
  const [workflowTab, setWorkflowTab] = useState("approvals");

  const deferredQuery = useDeferredValue(query);

  // --- Derived state ---
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

  // --- Data fetching ---
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
        return { generatedAt: "", watchedRepoRoots: [], pendingSemanticRefresh: [] } satisfies ViewerWatchStatus;
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
    if (!selectedApprovalId) return;
    let cancelled = false;
    void fetchApprovalDetail(selectedApprovalId)
      .then((detail) => {
        if (!cancelled) {
          setApprovalDetail(detail);
          setApprovalError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setApprovalError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedApprovalId]);

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
        if (!cancelled) setGraphError(error instanceof Error ? error.message : String(error));
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
        if (!cancelled)
          startTransition(() => {
            setResults(nextResults);
            setSearchError(null);
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) setSearchError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [deferredQuery, kindFilter, pageStatusFilter, projectFilter, sourceTypeFilter, sourceClassFilter]);

  useEffect(() => {
    if (!selected?.pageId) return;
    const page = graph?.pages?.find((candidate) => candidate.id === selected.pageId);
    if (!page) return;
    let cancelled = false;
    void fetchViewerPage(page.path)
      .then((payload) => {
        if (!cancelled) {
          setActivePage(payload);
          setPageError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setPageError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [graph, selected]);

  // --- Handlers ---
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
    if (!selectedApprovalId) return;
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

  const navigateNode = useCallback((nodeId: string) => {
    const element = cyRef.current?.getElementById(nodeId);
    if (element) {
      cyRef.current?.elements().unselect();
      element.select();
      cyRef.current?.center(element);
    }
  }, []);

  const highlightSurprise = useCallback(async (sourceNodeId: string, targetNodeId: string) => {
    setPathFrom(sourceNodeId);
    setPathTo(targetNodeId);
    try {
      const result = await fetchGraphPath(sourceNodeId, targetNodeId);
      setPathResult(result);
      setGraphError(null);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // --- Render ---
  return (
    <div className="app-shell">
      <header className="app-bar">
        <span className="app-bar-title">SwarmVault</span>
        <span className="app-bar-subtitle">Graph Viewer</span>
      </header>

      <FilterSidebar
        edgeStatusFilter={edgeStatusFilter}
        onEdgeStatusChange={setEdgeStatusFilter}
        kindFilter={kindFilter}
        onKindChange={setKindFilter}
        pageStatusFilter={pageStatusFilter}
        onPageStatusChange={setPageStatusFilter}
        projectFilter={projectFilter}
        onProjectChange={setProjectFilter}
        projectOptions={projectOptions}
        sourceTypeFilter={sourceTypeFilter}
        onSourceTypeChange={setSourceTypeFilter}
        sourceTypeOptions={sourceTypeOptions}
        sourceClassFilter={sourceClassFilter}
        onSourceClassChange={setSourceClassFilter}
        sourceClassOptions={sourceClassOptions}
        communityFilter={communityFilter}
        onCommunityChange={setCommunityFilter}
        communityOptions={communityOptions}
        query={query}
        onQueryChange={setQuery}
      />

      <div className="center-area">
        <StatsBar
          generatedAt={graph?.generatedAt ?? null}
          nodeCount={graph?.nodes.length ?? 0}
          edgeCount={graph?.edges.length ?? 0}
          communityCount={graph?.communities?.length ?? 0}
          approvalCount={approvals.reduce((total, approval) => total + approval.pendingCount, 0)}
          candidateCount={candidates.length}
          pendingRefreshCount={watchStatus?.pendingSemanticRefresh.length ?? 0}
          benchmarkRatio={graphReport?.benchmark?.summary.reductionRatio ?? null}
        />
        <GraphCanvas
          graph={graph}
          edgeStatusFilter={edgeStatusFilter}
          communityFilter={communityFilter}
          sourceClassFilter={sourceClassFilter}
          pathResult={pathResult}
          onNodeSelect={setSelected}
          cyRef={cyRef}
        />
        <ReportTabs
          graphReport={graphReport}
          onOpenPage={openPagePath}
          onNavigateNode={navigateNode}
          onHighlightSurprise={highlightSurprise}
        />
      </div>

      <aside className="detail-rail">
        <GraphTools
          graphQueryInput={graphQueryInput}
          onGraphQueryInputChange={setGraphQueryInput}
          onRunQuery={() => void handleGraphQuery()}
          graphQueryResult={graphQueryResult}
          pathFrom={pathFrom}
          onPathFromChange={setPathFrom}
          pathTo={pathTo}
          onPathToChange={setPathTo}
          onHighlightPath={() => void handleGraphPath()}
          pathResult={pathResult}
          graphError={graphError}
          graph={graph}
          onOpenPage={openPagePath}
          onNavigateNode={navigateNode}
        />
        <SelectionPanel selected={selected} graphExplain={graphExplain} graphError={graphError} onNavigateNode={navigateNode} />
        <SearchResults results={results} searchError={searchError} query={query} onOpenResult={openResult} />
        <Tabs
          tabs={[
            { id: "approvals", label: "Approvals", count: approvals.reduce((t, a) => t + a.pendingCount, 0) },
            { id: "candidates", label: "Candidates", count: candidates.length },
            { id: "refresh", label: "Refresh", count: watchStatus?.pendingSemanticRefresh.length ?? 0 }
          ]}
          activeTab={workflowTab}
          onTabChange={setWorkflowTab}
        >
          {workflowTab === "approvals" && (
            <ApprovalQueue
              approvals={approvals}
              selectedApprovalId={selectedApprovalId}
              onSelectApproval={setSelectedApprovalId}
              approvalDetail={approvalDetail}
              approvalError={approvalError}
              actionError={actionError}
              busyAction={busyAction}
              onReviewAction={(pageId, action) => void handleReviewAction(pageId, action)}
              onOpenPage={openPagePath}
            />
          )}
          {workflowTab === "candidates" && (
            <CandidateList
              candidates={candidates}
              candidateError={candidateError}
              busyAction={busyAction}
              onCandidateAction={(target, action, nextPath) => void handleCandidateAction(target, action, nextPath)}
              onOpenPage={openPagePath}
            />
          )}
          {workflowTab === "refresh" && <PendingRefresh watchStatus={watchStatus} watchError={watchError} />}
        </Tabs>
        <PagePreview
          activePage={activePage}
          pageError={pageError}
          backlinkPages={backlinkPages}
          relatedPages={relatedPages}
          graphPageLinks={graphPageLinks}
          onOpenPage={openPagePath}
        />
      </aside>
    </div>
  );
}
