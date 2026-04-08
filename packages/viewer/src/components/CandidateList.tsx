import type { OpenPageFn, ViewerCandidateRecord } from "./types";

type CandidateListProps = {
  candidates: ViewerCandidateRecord[];
  candidateError: string | null;
  busyAction: string;
  onCandidateAction: (target: string, action: "promote" | "archive", nextPath?: string) => void;
  onOpenPage: OpenPageFn;
};

export function CandidateList({ candidates, candidateError, busyAction, onCandidateAction, onOpenPage }: CandidateListProps) {
  return (
    <div>
      {candidateError ? <p className="text-error">{candidateError}</p> : null}
      {candidates.length ? (
        <div className="card-list">
          {candidates.map((candidate) => (
            <article key={candidate.pageId} className="card">
              <span className="label">{candidate.kind}</span>
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
        </div>
      ) : (
        <p className="text-muted text-sm">No candidate pages are waiting for review.</p>
      )}
    </div>
  );
}
