import { useState } from "react";

type FilterSidebarProps = {
  edgeStatusFilter: string;
  onEdgeStatusChange: (value: string) => void;
  kindFilter: string;
  onKindChange: (value: string) => void;
  pageStatusFilter: string;
  onPageStatusChange: (value: string) => void;
  projectFilter: string;
  onProjectChange: (value: string) => void;
  projectOptions: string[];
  sourceTypeFilter: string;
  onSourceTypeChange: (value: string) => void;
  sourceTypeOptions: string[];
  sourceClassFilter: string;
  onSourceClassChange: (value: string) => void;
  sourceClassOptions: string[];
  communityFilter: string;
  onCommunityChange: (value: string) => void;
  communityOptions: string[];
  query: string;
  onQueryChange: (value: string) => void;
};

export function FilterSidebar({
  edgeStatusFilter,
  onEdgeStatusChange,
  kindFilter,
  onKindChange,
  pageStatusFilter,
  onPageStatusChange,
  projectFilter,
  onProjectChange,
  projectOptions,
  sourceTypeFilter,
  onSourceTypeChange,
  sourceTypeOptions,
  sourceClassFilter,
  onSourceClassChange,
  sourceClassOptions,
  communityFilter,
  onCommunityChange,
  communityOptions,
  query,
  onQueryChange
}: FilterSidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["graph"]));

  const toggle = (section: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const graphActiveCount = [edgeStatusFilter, communityFilter, sourceClassFilter].filter((v) => v !== "all").length;
  const pagesActiveCount = [kindFilter, pageStatusFilter, projectFilter, sourceTypeFilter].filter((v) => v !== "all").length;

  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <label className="filter-group">
          <span className="filter-label">Search</span>
          <input
            type="search"
            className="input"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Pages, outputs, candidates\u2026"
            aria-label="Search pages"
          />
        </label>
      </div>

      <div className="sidebar-section">
        <button
          type="button"
          className={`sidebar-section-toggle ${expanded.has("graph") ? "is-expanded" : ""}`}
          onClick={() => toggle("graph")}
        >
          Graph{graphActiveCount > 0 ? <span className="filter-badge">{graphActiveCount}</span> : null}
        </button>
        <div className={`sidebar-section-body ${expanded.has("graph") ? "is-expanded" : ""}`}>
          <label className="filter-group">
            <span className="filter-label">Edge status</span>
            <select className="input" value={edgeStatusFilter} onChange={(event) => onEdgeStatusChange(event.target.value)}>
              <option value="all">All</option>
              <option value="extracted">Extracted</option>
              <option value="conflicted">Conflicted</option>
              <option value="inferred">Inferred</option>
              <option value="stale">Stale</option>
            </select>
          </label>
          <label className="filter-group">
            <span className="filter-label">Source class</span>
            <select className="input" value={sourceClassFilter} onChange={(event) => onSourceClassChange(event.target.value)}>
              <option value="all">All</option>
              {sourceClassOptions.map((sourceClass) => (
                <option key={sourceClass} value={sourceClass}>
                  {sourceClass}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span className="filter-label">Community</span>
            <select className="input" value={communityFilter} onChange={(event) => onCommunityChange(event.target.value)}>
              <option value="all">All</option>
              {communityOptions.map((communityId) => (
                <option key={communityId} value={communityId}>
                  {communityId}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="sidebar-section">
        <button
          type="button"
          className={`sidebar-section-toggle ${expanded.has("pages") ? "is-expanded" : ""}`}
          onClick={() => toggle("pages")}
        >
          Pages{pagesActiveCount > 0 ? <span className="filter-badge">{pagesActiveCount}</span> : null}
        </button>
        <div className={`sidebar-section-body ${expanded.has("pages") ? "is-expanded" : ""}`}>
          <label className="filter-group">
            <span className="filter-label">Page kind</span>
            <select className="input" value={kindFilter} onChange={(event) => onKindChange(event.target.value)}>
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
          <label className="filter-group">
            <span className="filter-label">Status</span>
            <select className="input" value={pageStatusFilter} onChange={(event) => onPageStatusChange(event.target.value)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="candidate">Candidate</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="filter-group">
            <span className="filter-label">Project</span>
            <select className="input" value={projectFilter} onChange={(event) => onProjectChange(event.target.value)}>
              <option value="all">All</option>
              <option value="unassigned">Unassigned</option>
              {projectOptions.map((projectId) => (
                <option key={projectId} value={projectId}>
                  {projectId}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-group">
            <span className="filter-label">Source type</span>
            <select className="input" value={sourceTypeFilter} onChange={(event) => onSourceTypeChange(event.target.value)}>
              <option value="all">All</option>
              {sourceTypeOptions.map((sourceType) => (
                <option key={sourceType} value={sourceType}>
                  {sourceType}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
