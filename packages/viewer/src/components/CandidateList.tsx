import { useMemo, useState } from "react";
import type { OpenPageFn, ViewerCandidateRecord } from "./types";

type CandidateSort = "score" | "title" | "updated";

type CandidateListProps = {
  candidates: ViewerCandidateRecord[];
  candidateError: string | null;
  busyAction: string;
  onCandidateAction: (target: string, action: "promote" | "archive", nextPath?: string) => void;
  onBulkCandidateAction?: (targets: string[], action: "promote" | "archive") => void;
  onOpenPage: OpenPageFn;
};

export function CandidateList({
  candidates,
  candidateError,
  busyAction,
  onCandidateAction,
  onBulkCandidateAction,
  onOpenPage
}: CandidateListProps) {
  const [filterText, setFilterText] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "concept" | "entity">("all");
  const [sort, setSort] = useState<CandidateSort>("score");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const text = filterText.trim().toLowerCase();
    return candidates
      .filter((candidate) => (kindFilter === "all" ? true : candidate.kind === kindFilter))
      .filter((candidate) => {
        if (!text) return true;
        const haystack = `${candidate.title} ${candidate.path}`.toLowerCase();
        return haystack.includes(text);
      });
  }, [candidates, filterText, kindFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "title") return copy.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "updated") return copy.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return copy.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [filtered, sort]);

  const allSelected = sorted.length > 0 && sorted.every((c) => selectedIds.has(c.pageId));

  const toggle = (pageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(sorted.map((c) => c.pageId)));
  };

  const bulk = (action: "promote" | "archive") => {
    if (!selectedIds.size || !onBulkCandidateAction) return;
    onBulkCandidateAction([...selectedIds], action);
    setSelectedIds(new Set());
  };

  return (
    <div>
      {candidateError ? <p className="text-error">{candidateError}</p> : null}
      {candidates.length ? (
        <>
          <div className="list-filter-bar">
            <input
              type="search"
              className="input"
              placeholder="Filter candidates…"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              aria-label="Filter candidates"
            />
            <select
              className="input"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as "all" | "concept" | "entity")}
              aria-label="Filter by kind"
              style={{ width: "auto" }}
            >
              <option value="all">All kinds</option>
              <option value="concept">Concepts</option>
              <option value="entity">Entities</option>
            </select>
            <select
              className="input"
              value={sort}
              onChange={(event) => setSort(event.target.value as CandidateSort)}
              aria-label="Sort"
              style={{ width: "auto" }}
            >
              <option value="score">Score</option>
              <option value="title">Title</option>
              <option value="updated">Recent</option>
            </select>
          </div>
          {selectedIds.size > 0 && onBulkCandidateAction ? (
            <div className="bulk-toolbar" role="toolbar" aria-label="Bulk candidate actions">
              <span className="bulk-toolbar-count">{selectedIds.size}</span>
              <span className="text-muted">selected</span>
              <button type="button" className="btn btn-primary" onClick={() => bulk("promote")}>
                Promote all
              </button>
              <button type="button" className="btn btn-danger" onClick={() => bulk("archive")}>
                Archive all
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setSelectedIds(new Set())}>
                Clear
              </button>
            </div>
          ) : null}
          {onBulkCandidateAction ? (
            <label className="checkbox-cell" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span className="text-muted text-xs">Select all visible</span>
            </label>
          ) : null}
          <div className="card-list">
            {sorted.map((candidate) => (
              <article key={candidate.pageId} className={`card${selectedIds.has(candidate.pageId) ? " is-selected" : ""}`}>
                <div className="card-row">
                  {onBulkCandidateAction ? (
                    <label className="checkbox-cell">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(candidate.pageId)}
                        onChange={() => toggle(candidate.pageId)}
                        aria-label={`Select ${candidate.title}`}
                      />
                    </label>
                  ) : null}
                  <span className="label">{candidate.kind}</span>
                  {candidate.score != null ? (
                    <span className="chip" title="Promotion score">
                      score {candidate.score.toFixed(2)}
                    </span>
                  ) : null}
                </div>
                <strong className="card-title">{candidate.title}</strong>
                <p className="text-mono text-sm">{candidate.path}</p>
                <button type="button" className="btn btn-ghost" onClick={() => void onOpenPage(candidate.path, candidate.pageId)}>
                  Open candidate
                </button>
                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAction === `promote:${candidate.pageId}`}
                    onClick={() => onCandidateAction(candidate.pageId, "promote", candidate.activePath)}
                  >
                    Promote
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busyAction === `archive:${candidate.pageId}`}
                    onClick={() => onCandidateAction(candidate.pageId, "archive", candidate.path)}
                  >
                    Archive
                  </button>
                </div>
              </article>
            ))}
            {sorted.length === 0 ? <p className="text-muted text-sm">No candidates match the current filter.</p> : null}
          </div>
        </>
      ) : (
        <p className="text-muted text-sm">No candidate pages are waiting for review.</p>
      )}
    </div>
  );
}
