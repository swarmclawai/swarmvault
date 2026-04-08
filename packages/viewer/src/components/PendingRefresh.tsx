import type { ViewerWatchStatus } from "./types";

type PendingRefreshProps = {
  watchStatus: ViewerWatchStatus | null;
  watchError: string | null;
};

export function PendingRefresh({ watchStatus, watchError }: PendingRefreshProps) {
  if (!watchStatus?.pendingSemanticRefresh.length) {
    return <p className="text-muted text-sm">No files are pending semantic refresh.</p>;
  }

  return (
    <div>
      <p className="text-muted text-sm">
        Watched roots: {watchStatus.watchedRepoRoots.length ? watchStatus.watchedRepoRoots.join(", ") : "none"}
        {watchStatus.lastRun?.finishedAt ? ` \u00b7 Last run: ${new Date(watchStatus.lastRun.finishedAt).toLocaleString()}` : ""}
      </p>
      {watchError ? <p className="text-error">{watchError}</p> : null}
      <div className="card-list">
        {watchStatus.pendingSemanticRefresh.slice(0, 8).map((entry) => (
          <article key={entry.id} className="card">
            <span className="label">{entry.changeType}</span>
            <strong className="card-title">{entry.path}</strong>
            <p className="text-muted text-sm">{entry.sourceKind ? `Kind: ${entry.sourceKind}` : "Awaiting semantic refresh."}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
