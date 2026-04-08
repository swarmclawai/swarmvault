import { Fragment, type ReactNode } from "react";
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

type SearchResultsProps = {
  results: ViewerSearchResult[];
  searchError: string | null;
  query: string;
  onOpenResult: (result: ViewerSearchResult) => Promise<void>;
};

export function SearchResults({ results, searchError, query, onOpenResult }: SearchResultsProps) {
  return (
    <section className="panel">
      <h3 className="panel-heading">Search Results{results.length > 0 ? <span className="tab-count">{results.length}</span> : null}</h3>
      {searchError ? <p className="text-error">{searchError}</p> : null}
      {results.length ? (
        <div className="card-list">
          {results.map((result) => (
            <button key={`${result.pageId}:${result.path}`} type="button" className="result-card" onClick={() => void onOpenResult(result)}>
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
      ) : (
        <div className="empty-state">
          <p className="text-muted text-sm">
            {query.trim().length >= 2 ? "No pages matched this query." : "Search the wiki, outputs, or candidate pages."}
          </p>
        </div>
      )}
    </section>
  );
}
