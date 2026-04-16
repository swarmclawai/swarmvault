import type { Core } from "cytoscape";
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { ApprovalQueue } from "./components/ApprovalQueue";
import { CandidateList } from "./components/CandidateList";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette";
import { ExportMenu } from "./components/ExportMenu";
import { FilterSidebar } from "./components/FilterSidebar";
import { GraphCanvas } from "./components/GraphCanvas";
import { GraphTools } from "./components/GraphTools";
import { LintFindings } from "./components/LintFindings";
import { PagePreview } from "./components/PagePreview";
import { PendingRefresh } from "./components/PendingRefresh";
import { ReportTabs } from "./components/ReportTabs";
import { SearchResults, type SearchSort } from "./components/SearchResults";
import { SelectionPanel } from "./components/SelectionPanel";
import { StatsBar } from "./components/StatsBar";
import { Tabs } from "./components/Tabs";
import { ThemeToggle } from "./components/ThemeToggle";
import { UndoToast } from "./components/UndoToast";
import { useEventStream } from "./hooks/useEventStream";
import { useHashRoute } from "./hooks/useHashRoute";
import { type Shortcut, useShortcuts } from "./hooks/useShortcuts";
import { useTheme } from "./hooks/useTheme";
import { useUndoBuffer } from "./hooks/useUndoBuffer";
import { useWorkspaceStore } from "./hooks/workspaceStore";
import {
  applyCandidateAction,
  applyReviewAction,
  fetchGraphExplain,
  fetchGraphPath,
  fetchGraphQuery,
  fetchViewerPage,
  searchViewerPages,
  type ViewerGraphExplainResult,
  type ViewerGraphNode,
  type ViewerGraphPathResult,
  type ViewerGraphQueryResult,
  type ViewerPagePayload,
  type ViewerSearchResult
} from "./lib";

const RECENT_SEARCH_KEY = "swarmvault.viewer.recentSearches";
const MAX_RECENT_SEARCHES = 6;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function readRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function persistRecentSearches(values: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(values));
  } catch {
    /* ignore */
  }
}

export function App() {
  const cyRef = useRef<Core | null>(null);
  const { state, refresh, loadApprovalDetail } = useWorkspaceStore();
  const { graph, graphReport, approvals, approvalDetail, candidates, watchStatus, lintFindings, loading, errors } = state;
  const { theme, setTheme } = useTheme();
  const { route, navigate } = useHashRoute();
  const undo = useUndoBuffer();
  const eventStream = useEventStream();

  // --- View state ---
  const [selected, setSelected] = useState<ViewerGraphNode | null>(null);
  const [edgeStatusFilter, setEdgeStatusFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [pageStatusFilter, setPageStatusFilter] = useState<string>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [communityFilter, setCommunityFilter] = useState<string>("all");
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string>("all");
  const [sourceClassFilter, setSourceClassFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ViewerSearchResult[]>([]);
  const [searchSort, setSearchSort] = useState<SearchSort>("relevance");
  const [recentQueries, setRecentQueries] = useState<string[]>(() => readRecentSearches());
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string>("");
  const [workflowTab, setWorkflowTab] = useState("approvals");
  const [selectedApprovalId, setSelectedApprovalId] = useState<string>("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [drawer, setDrawer] = useState<"none" | "sidebar" | "rail">("none");
  const [fitTrigger, setFitTrigger] = useState(0);

  const deferredQuery = useDeferredValue(query);

  // --- Derived ---
  const currentGraphPage = useMemo(() => {
    if (!activePage || !graph) return null;
    return (
      graph.pages?.find(
        (page) =>
          page.path === activePage.path ||
          page.id === (typeof activePage.frontmatter.page_id === "string" ? activePage.frontmatter.page_id : "")
      ) ?? null
    );
  }, [activePage, graph]);

  const projectOptions = useMemo(
    () => uniqueStrings(graph?.pages?.flatMap((page) => page.projectIds ?? []) ?? []).sort((a, b) => a.localeCompare(b)),
    [graph]
  );
  const sourceTypeOptions = useMemo(
    () =>
      uniqueStrings(
        graph?.pages
          ?.flatMap((page) => (page.kind === "source" && page.sourceType ? [page.sourceType] : []))
          .sort((a, b) => a.localeCompare(b)) ?? []
      ),
    [graph]
  );
  const sourceClassOptions = useMemo(
    () =>
      uniqueStrings(graph?.pages?.flatMap((page) => (page.sourceClass ? [page.sourceClass] : [])).sort((a, b) => a.localeCompare(b)) ?? []),
    [graph]
  );
  const communityOptions = useMemo(
    () => uniqueStrings((graph?.communities ?? []).map((community) => community.id)).sort((a, b) => a.localeCompare(b)),
    [graph]
  );

  // Page-id → tags map (used to filter graph nodes by tag)
  const pageTags = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const page of graph?.pages ?? []) {
      const tagsField =
        ((page as unknown as { tags?: unknown }).tags as unknown) ??
        ((page as unknown as { semantic_tags?: unknown }).semantic_tags as unknown);
      if (Array.isArray(tagsField)) {
        map[page.id] = tagsField.filter((value): value is string => typeof value === "string");
      }
    }
    return map;
  }, [graph]);

  const tagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const page of graph?.pages ?? []) {
      const tags = pageTags[page.id] ?? [];
      for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [graph, pageTags]);

  const backlinkPages = useMemo(() => {
    if (!currentGraphPage) return [];
    return uniqueStrings(currentGraphPage.backlinks)
      .map((pageId) => graph?.pages?.find((page) => page.id === pageId) ?? null)
      .filter((page): page is NonNullable<typeof page> => Boolean(page));
  }, [currentGraphPage, graph]);
  const relatedPages = useMemo(() => {
    if (!currentGraphPage) return [];
    return uniqueStrings(currentGraphPage.relatedPageIds)
      .map((pageId) => graph?.pages?.find((page) => page.id === pageId) ?? null)
      .filter((page): page is NonNullable<typeof page> => Boolean(page));
  }, [currentGraphPage, graph]);
  const graphPageLinks = useMemo(
    () => graph?.pages?.filter((page) => page.kind === "graph_report" || page.kind === "community_summary") ?? [],
    [graph]
  );

  const graphPresentation = graph?.presentation;
  const overviewMode = graphPresentation?.mode === "overview";

  // --- Persist recent searches ---
  useEffect(() => {
    persistRecentSearches(recentQueries);
  }, [recentQueries]);

  // --- Approval pre-selection ---
  useEffect(() => {
    if (!approvals.length) {
      setSelectedApprovalId("");
      return;
    }
    if (!selectedApprovalId || !approvals.some((approval) => approval.approvalId === selectedApprovalId)) {
      setSelectedApprovalId(approvals[0]?.approvalId ?? "");
    }
  }, [approvals, selectedApprovalId]);

  useEffect(() => {
    void loadApprovalDetail(selectedApprovalId || undefined);
  }, [selectedApprovalId, loadApprovalDetail]);

  // --- Live event stream causes auto-refresh ---
  useEffect(() => {
    if (!eventStream.events.length) return;
    const latest = eventStream.events[0];
    if (!latest) return;
    if (["compile", "ingest", "watch", "approval", "candidate", "lint"].includes(latest.type)) {
      void refresh();
    }
  }, [eventStream.events, refresh]);

  // --- Graph explain on selection ---
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

  // --- Search results ---
  useEffect(() => {
    const normalizedQuery = deferredQuery.trim();
    if (normalizedQuery.length < 2) {
      setResults([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    void searchViewerPages(normalizedQuery, {
      limit: 50,
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
            setRecentQueries((prev) => {
              if (!normalizedQuery) return prev;
              const next = [normalizedQuery, ...prev.filter((existing) => existing !== normalizedQuery)];
              return next.slice(0, MAX_RECENT_SEARCHES);
            });
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) setSearchError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [deferredQuery, kindFilter, pageStatusFilter, projectFilter, sourceTypeFilter, sourceClassFilter]);

  // --- Active page from selection ---
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
  const openPagePath = useCallback(
    async (pagePath: string, pageId?: string) => {
      try {
        const payload = await fetchViewerPage(pagePath);
        setActivePage(payload);
        setPageError(null);
        navigate({ view: "page", params: { path: pagePath, id: pageId ?? "" } });
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
    },
    [graph, navigate]
  );

  const openResult = useCallback(
    async (result: ViewerSearchResult) => {
      await openPagePath(result.path, result.pageId);
    },
    [openPagePath]
  );

  const handleReviewAction = useCallback(
    async (pageId: string, action: "accept" | "reject") => {
      if (!selectedApprovalId) return;
      const approvalSnapshot = selectedApprovalId;
      setBusyAction(`${action}:${pageId}`);
      setActionError(null);
      try {
        await applyReviewAction(approvalSnapshot, action, [pageId]);
        await refresh();
        await loadApprovalDetail(approvalSnapshot);
        undo.push(`${action === "accept" ? "Accepted" : "Rejected"} 1 entry`, async () => {
          // Best-effort undo: flip the action for the same page.
          const inverse = action === "accept" ? "reject" : "accept";
          await applyReviewAction(approvalSnapshot, inverse, [pageId]);
          await refresh();
          await loadApprovalDetail(approvalSnapshot);
        });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction("");
      }
    },
    [loadApprovalDetail, refresh, selectedApprovalId, undo]
  );

  const handleBulkReview = useCallback(
    async (pageIds: string[], action: "accept" | "reject") => {
      if (!selectedApprovalId || !pageIds.length) return;
      const approvalSnapshot = selectedApprovalId;
      setBusyAction(`bulk:${action}`);
      setActionError(null);
      try {
        await applyReviewAction(approvalSnapshot, action, pageIds);
        await refresh();
        await loadApprovalDetail(approvalSnapshot);
        undo.push(`${action === "accept" ? "Accepted" : "Rejected"} ${pageIds.length} entries`, async () => {
          const inverse = action === "accept" ? "reject" : "accept";
          await applyReviewAction(approvalSnapshot, inverse, pageIds);
          await refresh();
          await loadApprovalDetail(approvalSnapshot);
        });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction("");
      }
    },
    [loadApprovalDetail, refresh, selectedApprovalId, undo]
  );

  const handleCandidateAction = useCallback(
    async (target: string, action: "promote" | "archive", nextPath?: string) => {
      setBusyAction(`${action}:${target}`);
      setActionError(null);
      try {
        const result = await applyCandidateAction(target, action);
        await refresh();
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
    },
    [openPagePath, refresh]
  );

  const handleBulkCandidateAction = useCallback(
    async (targets: string[], action: "promote" | "archive") => {
      if (!targets.length) return;
      setBusyAction(`bulk-candidate:${action}`);
      setActionError(null);
      try {
        for (const target of targets) {
          await applyCandidateAction(target, action);
        }
        await refresh();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyAction("");
      }
    },
    [refresh]
  );

  const handleGraphQuery = useCallback(async () => {
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
  }, [graphQueryInput]);

  const handleGraphPath = useCallback(async () => {
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
  }, [pathFrom, pathTo]);

  const navigateNode = useCallback(
    (nodeId: string) => {
      const element = cyRef.current?.getElementById(nodeId);
      if (element) {
        cyRef.current?.elements().unselect();
        element.select();
        cyRef.current?.center(element);
      }
      navigate({ view: "node", params: { id: nodeId } });
    },
    [navigate]
  );

  // --- Hash route → state (must be after openPagePath/navigateNode are declared) ---
  useEffect(() => {
    if (route.view === "page" && route.params.path && route.params.path !== activePage?.path) {
      void openPagePath(route.params.path, route.params.id);
    }
    if (route.view === "node" && route.params.id) {
      navigateNode(route.params.id);
    }
    if (route.view === "tag" && route.params.tag) {
      setTagFilter(route.params.tag);
    }
    if (route.view === "approval" && route.params.id) {
      setWorkflowTab("approvals");
      setSelectedApprovalId(route.params.id);
    }
  }, [route, openPagePath, navigateNode, activePage?.path]);

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

  // --- Command palette + shortcuts ---
  const focusGlobalSearch = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search pages"]');
    input?.focus();
  }, []);

  const focusGraphQuery = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="graph-query-input"]');
    input?.focus();
  }, []);

  const focusPathInput = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="graph-path-from"]');
    input?.focus();
  }, []);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      { id: "refresh", label: "Refresh workspace", section: "View", shortcut: "R", run: () => void refresh() },
      { id: "fit", label: "Fit graph to viewport", section: "Graph", shortcut: "F", run: () => setFitTrigger((value) => value + 1) },
      { id: "search", label: "Focus search", section: "Search", shortcut: "/", run: focusGlobalSearch },
      { id: "graph-query", label: "Focus graph query", section: "Graph", shortcut: "Q", run: focusGraphQuery },
      { id: "graph-path", label: "Focus graph path", section: "Graph", shortcut: "P", run: focusPathInput },
      { id: "open-approvals", label: "Open approvals tab", section: "Workflow", run: () => setWorkflowTab("approvals") },
      { id: "open-candidates", label: "Open candidates tab", section: "Workflow", run: () => setWorkflowTab("candidates") },
      { id: "open-refresh", label: "Open refresh tab", section: "Workflow", run: () => setWorkflowTab("refresh") },
      { id: "open-activity", label: "Open activity tab", section: "Workflow", run: () => setWorkflowTab("activity") },
      { id: "open-lint", label: "Open lint tab", section: "Workflow", run: () => setWorkflowTab("lint") },
      { id: "theme-light", label: "Theme: light", section: "Theme", run: () => setTheme("light") },
      { id: "theme-dark", label: "Theme: dark", section: "Theme", run: () => setTheme("dark") },
      { id: "theme-system", label: "Theme: system", section: "Theme", run: () => setTheme("system") },
      {
        id: "drawer-sidebar",
        label: "Toggle filter sidebar",
        section: "Layout",
        run: () => setDrawer((d) => (d === "sidebar" ? "none" : "sidebar"))
      },
      { id: "drawer-rail", label: "Toggle detail rail", section: "Layout", run: () => setDrawer((d) => (d === "rail" ? "none" : "rail")) },
      { id: "help", label: "Show keyboard shortcuts", section: "Help", shortcut: "?", run: () => setHelpOpen(true) },
      ...tagOptions.slice(0, 12).map((entry) => ({
        id: `tag-${entry.tag}`,
        label: `Filter by tag: ${entry.tag}`,
        section: "Tags",
        keywords: ["tag", entry.tag],
        run: () => {
          setTagFilter(entry.tag);
          navigate({ view: "tag", params: { tag: entry.tag } });
        }
      }))
    ],
    [focusGlobalSearch, focusGraphQuery, focusPathInput, navigate, refresh, setTheme, tagOptions]
  );

  const shortcuts = useMemo<Shortcut[]>(
    () => [
      { key: "k", meta: true, description: "Open command palette", handler: () => setPaletteOpen(true), allowInInput: true },
      { key: "?", shift: true, description: "Show shortcut help", handler: () => setHelpOpen(true) },
      { key: "/", description: "Focus search", handler: focusGlobalSearch },
      { key: "f", description: "Fit graph", handler: () => setFitTrigger((value) => value + 1) },
      { key: "q", description: "Focus graph query", handler: focusGraphQuery },
      { key: "p", description: "Focus path-from", handler: focusPathInput },
      { key: "r", description: "Refresh workspace", handler: () => void refresh() },
      {
        key: "Escape",
        description: "Close overlays",
        handler: () => {
          setPaletteOpen(false);
          setHelpOpen(false);
          setDrawer("none");
        },
        allowInInput: true
      },
      { key: "[", description: "Toggle sidebar drawer", handler: () => setDrawer((d) => (d === "sidebar" ? "none" : "sidebar")) },
      { key: "]", description: "Toggle rail drawer", handler: () => setDrawer((d) => (d === "rail" ? "none" : "rail")) }
    ],
    [focusGlobalSearch, focusGraphQuery, focusPathInput, refresh]
  );

  useShortcuts(shortcuts);

  const activePageMarkdown = useMemo(() => (activePage ? { title: activePage.title, content: activePage.content } : null), [activePage]);

  const selectedNodeIds = selected ? [selected.id] : [];

  // --- Render ---
  return (
    <div className="app-shell">
      <header className="app-bar">
        <button
          type="button"
          className="app-bar-icon-btn drawer-trigger"
          aria-label="Toggle filter sidebar"
          onClick={() => setDrawer((d) => (d === "sidebar" ? "none" : "sidebar"))}
        >
          ☰
        </button>
        <span className="app-bar-title">SwarmVault</span>
        <span className="app-bar-subtitle">Graph Viewer</span>
        <span className="app-bar-spacer" />
        <div className="app-bar-actions">
          <ExportMenu cyRef={cyRef} graph={graph} selectedNodeIds={selectedNodeIds} pageMarkdown={activePageMarkdown} />
          <button
            type="button"
            className="app-bar-icon-btn"
            onClick={() => setPaletteOpen(true)}
            title="Command palette (⌘K)"
            aria-label="Open command palette"
          >
            ⌘K
          </button>
          <button
            type="button"
            className="app-bar-icon-btn"
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
          >
            ?
          </button>
          <ThemeToggle theme={theme} onChange={setTheme} />
          <button
            type="button"
            className="app-bar-icon-btn drawer-trigger"
            aria-label="Toggle detail rail"
            onClick={() => setDrawer((d) => (d === "rail" ? "none" : "rail"))}
          >
            ⌧
          </button>
        </div>
      </header>

      <div className={`drawer-backdrop${drawer !== "none" ? " is-open" : ""}`} onClick={() => setDrawer("none")} aria-hidden="true" />

      <div className={`sidebar${drawer === "sidebar" ? " is-open" : ""}`}>
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
          tagFilter={tagFilter}
          onTagChange={(value) => {
            setTagFilter(value);
            navigate({ view: "tag", params: { tag: value === "all" ? "" : value } });
          }}
          tagOptions={tagOptions}
          query={query}
          onQueryChange={setQuery}
        />
      </div>

      <div className="center-area">
        <StatsBar
          generatedAt={graph?.generatedAt ?? null}
          nodeCount={graphPresentation?.totalNodes ?? graph?.nodes.length ?? 0}
          edgeCount={graphPresentation?.totalEdges ?? graph?.edges.length ?? 0}
          communityCount={graphPresentation?.totalCommunities ?? graph?.communities?.length ?? 0}
          approvalCount={approvals.reduce((total, approval) => total + approval.pendingCount, 0)}
          candidateCount={candidates.length}
          pendingRefreshCount={watchStatus?.pendingSemanticRefresh.length ?? 0}
          benchmarkRatio={graphReport?.benchmark?.summary.reductionRatio ?? null}
        />
        {overviewMode ? (
          <div className="overview-banner" data-testid="graph-overview-banner">
            Overview mode: showing {graphPresentation?.displayedNodes.toLocaleString()} of {graphPresentation?.totalNodes.toLocaleString()}{" "}
            nodes. Use <code>--full</code> to render the entire graph.
          </div>
        ) : null}
        {loading && !graph ? (
          <div className="canvas canvas-loading">
            <span className="loading-text">Loading graph data…</span>
          </div>
        ) : !loading && graph && graph.nodes.length === 0 ? (
          <div className="canvas canvas-loading canvas-empty">
            <span className="canvas-empty-icon">{"\u25C8"}</span>
            <span className="text-muted">No nodes in the current graph view.</span>
          </div>
        ) : (
          <GraphCanvas
            graph={graph}
            edgeStatusFilter={edgeStatusFilter}
            communityFilter={communityFilter}
            sourceClassFilter={sourceClassFilter}
            tagFilter={tagFilter}
            pageTags={pageTags}
            pathResult={pathResult}
            onNodeSelect={setSelected}
            cyRef={cyRef}
            fitTrigger={fitTrigger}
          />
        )}
        <ReportTabs
          graphReport={graphReport}
          onOpenPage={openPagePath}
          onNavigateNode={navigateNode}
          onHighlightSurprise={highlightSurprise}
        />
      </div>

      <aside className={`detail-rail${drawer === "rail" ? " is-open" : ""}`}>
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
        <SearchResults
          results={results}
          searchError={searchError}
          query={query}
          onOpenResult={openResult}
          recentQueries={recentQueries}
          onSelectRecent={(value) => setQuery(value)}
          sort={searchSort}
          onSortChange={setSearchSort}
        />
        <Tabs
          tabs={[
            { id: "approvals", label: "Approvals", count: approvals.reduce((t, a) => t + a.pendingCount, 0) },
            { id: "candidates", label: "Candidates", count: candidates.length },
            { id: "refresh", label: "Refresh", count: watchStatus?.pendingSemanticRefresh.length ?? 0 },
            { id: "activity", label: "Activity", count: eventStream.events.length },
            { id: "lint", label: "Lint", count: lintFindings.length }
          ]}
          activeTab={workflowTab}
          onTabChange={setWorkflowTab}
        >
          {workflowTab === "approvals" && (
            <ApprovalQueue
              approvals={approvals}
              selectedApprovalId={selectedApprovalId}
              onSelectApproval={(id) => {
                setSelectedApprovalId(id);
                navigate({ view: "approval", params: { id } });
              }}
              approvalDetail={approvalDetail}
              approvalError={errors.approval ?? null}
              actionError={actionError}
              busyAction={busyAction}
              onReviewAction={(pageId, action) => void handleReviewAction(pageId, action)}
              onBulkReview={(ids, action) => void handleBulkReview(ids, action)}
              onOpenPage={openPagePath}
            />
          )}
          {workflowTab === "candidates" && (
            <CandidateList
              candidates={candidates}
              candidateError={errors.candidate ?? null}
              busyAction={busyAction}
              onCandidateAction={(target, action, nextPath) => void handleCandidateAction(target, action, nextPath)}
              onBulkCandidateAction={(targets, action) => void handleBulkCandidateAction(targets, action)}
              onOpenPage={openPagePath}
            />
          )}
          {workflowTab === "refresh" && <PendingRefresh watchStatus={watchStatus} watchError={errors.watch ?? null} />}
          {workflowTab === "activity" && (
            <ActivityFeed events={eventStream.events} connected={eventStream.connected} error={eventStream.error} />
          )}
          {workflowTab === "lint" && <LintFindings findings={lintFindings} error={errors.lint} onOpenPage={openPagePath} />}
        </Tabs>
        <PagePreview
          activePage={activePage}
          pageError={pageError}
          backlinkPages={backlinkPages}
          relatedPages={relatedPages}
          graphPageLinks={graphPageLinks}
          onOpenPage={openPagePath}
          onNavigateNode={navigateNode}
        />
      </aside>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />

      {helpOpen ? (
        <div
          className="palette-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          onClick={(event) => {
            if (event.target === event.currentTarget) setHelpOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setHelpOpen(false);
          }}
        >
          <div className="help-modal">
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <h3 className="panel-heading">Keyboard Shortcuts</h3>
              <button type="button" className="btn btn-ghost" onClick={() => setHelpOpen(false)}>
                ×
              </button>
            </div>
            <div className="shortcut-grid">
              {shortcuts.map((shortcut) => (
                <div key={shortcut.description} className="shortcut-row">
                  <span>{shortcut.description}</span>
                  <span className="kbd">
                    {shortcut.meta ? "⌘" : ""}
                    {shortcut.shift ? "⇧" : ""}
                    {shortcut.alt ? "⌥" : ""}
                    {shortcut.key.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <UndoToast entry={undo.entry} onUndo={undo.performUndo} onDismiss={undo.dismiss} />
    </div>
  );
}
