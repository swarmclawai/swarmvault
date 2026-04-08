import type { ViewerSearchResult } from "./types";

type SearchResultsProps = {
  results: ViewerSearchResult[];
  searchError: string | null;
  query: string;
  onOpenResult: (result: ViewerSearchResult) => Promise<void>;
};

export function SearchResults({ results, searchError, query, onOpenResult }: SearchResultsProps) {
  return (
    <section className="panel">
      <h3 className="panel-heading">Search Results</h3>
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
              <p className="text-secondary text-sm">{result.snippet}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-muted text-sm">
          {query.trim().length >= 2 ? "No pages matched this query." : "Search the wiki, outputs, or candidate pages."}
        </p>
      )}
    </section>
  );
}
