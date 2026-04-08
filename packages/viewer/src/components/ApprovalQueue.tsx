import type { OpenPageFn, ViewerApprovalDetail, ViewerApprovalSummary } from "./types";

function snippetFromContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 220);
}

type ApprovalQueueProps = {
  approvals: ViewerApprovalSummary[];
  selectedApprovalId: string;
  onSelectApproval: (approvalId: string) => void;
  approvalDetail: ViewerApprovalDetail | null;
  approvalError: string | null;
  actionError: string | null;
  busyAction: string;
  onReviewAction: (pageId: string, action: "accept" | "reject") => void;
  onOpenPage: OpenPageFn;
};

export function ApprovalQueue({
  approvals,
  selectedApprovalId,
  onSelectApproval,
  approvalDetail,
  approvalError,
  actionError,
  busyAction,
  onReviewAction,
  onOpenPage
}: ApprovalQueueProps) {
  return (
    <div>
      {approvalError ? <p className="text-error">{approvalError}</p> : null}
      {actionError ? <p className="text-error">{actionError}</p> : null}
      {approvals.length ? (
        <div className="card-list">
          {approvals.map((approval) => (
            <button
              key={approval.approvalId}
              type="button"
              className={`result-card${selectedApprovalId === approval.approvalId ? " is-active" : ""}`}
              onClick={() => onSelectApproval(approval.approvalId)}
            >
              <span className="label">pending {approval.pendingCount}</span>
              <strong className="card-title">{approval.approvalId}</strong>
              <p className="text-muted text-sm">
                accepted {approval.acceptedCount} / rejected {approval.rejectedCount}
              </p>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-muted text-sm">No staged approval bundles.</p>
      )}
      {approvalDetail?.entries.length ? (
        <div className="card-list" style={{ marginTop: 8 }}>
          {approvalDetail.entries.map((entry) => (
            <article key={`${entry.pageId}:${entry.nextPath ?? entry.previousPath ?? entry.changeType}`} className="card">
              <span className="label">
                {entry.status} / {entry.changeType}
              </span>
              <strong className="card-title">{entry.title}</strong>
              <p className="text-mono text-sm">{entry.nextPath ?? entry.previousPath}</p>
              {entry.stagedContent ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void onOpenPage(entry.nextPath ?? entry.previousPath ?? "", entry.pageId)}
                >
                  Open page
                </button>
              ) : null}
              {entry.status === "pending" ? (
                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyAction === `accept:${entry.pageId}`}
                    onClick={() => onReviewAction(entry.pageId, "accept")}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busyAction === `reject:${entry.pageId}`}
                    onClick={() => onReviewAction(entry.pageId, "reject")}
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <p className="text-secondary text-sm">
                  {entry.currentContent ? snippetFromContent(entry.currentContent) : "No current content on disk."}
                </p>
              )}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
