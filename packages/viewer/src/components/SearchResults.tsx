import { Fragment, type ReactNode, useState } from "react";
import type { ViewerSearchResult } from "./types";

function highlightQuery(text: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return text;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  if (parts.length === 1) return text;
  const lowered = trimmed.toLowerCase();
  let offset = 0;
  return parts.map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    return part.toLowerCase() === lowered ? <mark key={key}>{part}</mark> : <Fragment key={key}>{part}</Fragment>;
  });
}

export type SearchSort = "relevance" | "title" | "updated";

type SearchResultsProps = {
  results: ViewerSearchResult[];
  searchError: string | null;
  query: string;
  onOpenResult: (result: ViewerSearchResult) => Promise<void>;
  recentQueries?: string[];
  onSelectRecent?: (query: string) => void;
  sort?: SearchSort;
  onSortChange?: (sort: SearchSort) => void;
  pageSize?: number;
};

export function SearchResults({
  results,
  searchError,
  query,
  onOpenResult,
  recentQueries = [],
  onSelectRecent,
  sort = "relevance",
  onSortChange,
  pageSize = 10
}: SearchResultsProps) {
  const [shown, setShown] = useState(pageSize);
  const [showHelp, setShowHelp] = useState(false);

  const sorted = [...results].sort((left, right) => {
    if (sort === "title") return left.title.localeCompare(right.title);
    if (sort === "updated") return (right.pageId ?? "").localeCompare(left.pageId ?? "");
    return 0;
  });

  return (
    <section className="panel" aria-label="Search results">
      <h3 className="panel-heading">
        Search Results
        {results.length > 0 ? (
          <span className="panel-meta">
            {results.length} match{results.length === 1 ? "" : "es"}
          </span>
        ) : null}
      </h3>
      <div className="search-controls">
        <label className="filter-group" style={{ flex: 1, minWidth: 120 }}>
          <span className="filter-label">Sort</span>
          <select
            className="input"
            value={sort}
            onChange={(event) => onSortChange?.(event.target.value as SearchSort)}
            aria-label="Sort search results"
          >
            <option value="relevance">Relevance</option>
            <option value="title">Title</option>
            <option value="updated">Recent</option>
          </select>
        </label>
        <button type="button" className="btn btn-ghost" onClick={() => setShowHelp((prev) => !prev)} aria-expanded={showHelp}>
          {showHelp ? "Hide help" : "Search help"}
        </button>
      </div>
      {showHelp ? (
        <div className="search-syntax-help">
          <p>
            Use <code>kind:source</code>, <code>status:active</code>, or <code>project:foo</code> filters in the sidebar to scope. Type at
            least <code>2</code> characters; matches are highlighted in snippets. Combine with the tag filter for domain-scoped results.
          </p>
        </div>
      ) : null}
      {searchError ? <p className="text-error">{searchError}</p> : null}
      {sorted.length ? (
        <>
          <div className="card-list">
            {sorted.slice(0, shown).map((result) => (
              <button
                key={`${result.pageId}:${result.path}`}
                type="button"
                className="result-card"
                onClick={() => void onOpenResult(result)}
              >
                <span className="label">
                  {result.kind ?? "page"} / {result.status ?? "active"}
                </span>
                <strong className="card-title">{result.title}</strong>
                {result.sourceType ? <p className="text-muted text-sm">Source: {result.sourceType}</p> : null}
                {result.sourceClass ? <p className="text-muted text-sm">Class: {result.sourceClass}</p> : null}
                <p className="text-muted text-sm">{result.projectIds.length ? result.projectIds.join(", ") : "global"}</p>
                <p className="text-secondary text-sm">{highlightQuery(result.snippet, query)}</p>
              </button>
            ))}
          </div>
          {sorted.length > shown ? (
            <div className="action-row">
              <button type="button" className="btn" onClick={() => setShown((prev) => prev + pageSize)}>
                Show {Math.min(pageSize, sorted.length - shown)} more
              </button>
              <span className="text-muted text-sm action-row-end">
                Showing {Math.min(shown, sorted.length)} of {sorted.length}
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-state">
          <p className="text-muted text-sm">
            {query.trim().length >= 2 ? "No pages matched this query." : "Search the wiki, outputs, or candidate pages."}
          </p>
        </div>
      )}
      {recentQueries.length && onSelectRecent ? (
        <div className="recent-searches">
          <span className="label">Recent</span>
          {recentQueries.slice(0, 6).map((recent) => (
            <button key={recent} type="button" className="chip chip-tag" onClick={() => onSelectRecent(recent)}>
              {recent}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
