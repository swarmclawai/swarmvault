import { useMemo, useState } from "react";
import { DiffView } from "./DiffView";
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
  onBulkReview?: (pageIds: string[], action: "accept" | "reject") => void;
  onOpenPage: OpenPageFn;
};

type EntryFilter = "all" | "pending" | "accepted" | "rejected";

export function ApprovalQueue({
  approvals,
  selectedApprovalId,
  onSelectApproval,
  approvalDetail,
  approvalError,
  actionError,
  busyAction,
  onReviewAction,
  onBulkReview,
  onOpenPage
}: ApprovalQueueProps) {
  const [statusFilter, setStatusFilter] = useState<EntryFilter>("pending");
  const [filterText, setFilterText] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const filteredEntries = useMemo(() => {
    if (!approvalDetail) return [];
    const text = filterText.trim().toLowerCase();
    return approvalDetail.entries.filter((entry) => {
      if (statusFilter !== "all" && entry.status !== statusFilter) return false;
      if (text) {
        const haystack = `${entry.title} ${entry.kind} ${entry.changeType} ${entry.nextPath ?? entry.previousPath ?? ""}`.toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
  }, [approvalDetail, statusFilter, filterText]);

  const allFilteredIds = filteredEntries.filter((entry) => entry.status === "pending").map((entry) => entry.pageId);
  const allSelected = allFilteredIds.length > 0 && allFilteredIds.every((id) => selectedIds.has(id));

  const toggleSelected = (pageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allFilteredIds));
    }
  };

  const handleBulk = (action: "accept" | "reject") => {
    if (!selectedIds.size || !onBulkReview) return;
    onBulkReview([...selectedIds], action);
    setSelectedIds(new Set());
  };

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
        <>
          <div className="list-filter-bar" style={{ marginTop: 8 }}>
            <input
              type="search"
              className="input"
              placeholder="Filter entries…"
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              aria-label="Filter approval entries"
            />
            <select
              className="input"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as EntryFilter)}
              aria-label="Filter by status"
              style={{ width: "auto" }}
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="accepted">Accepted</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          {selectedIds.size > 0 && onBulkReview ? (
            <div className="bulk-toolbar" role="toolbar" aria-label="Bulk approval actions">
              <span className="bulk-toolbar-count">{selectedIds.size}</span>
              <span className="text-muted">selected</span>
              <button type="button" className="btn btn-primary" onClick={() => handleBulk("accept")}>
                Accept all
              </button>
              <button type="button" className="btn btn-danger" onClick={() => handleBulk("reject")}>
                Reject all
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setSelectedIds(new Set())}>
                Clear
              </button>
            </div>
          ) : null}
          {allFilteredIds.length > 0 && onBulkReview ? (
            <label className="checkbox-cell" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span className="text-muted text-xs">Select all pending</span>
            </label>
          ) : null}
          <div className="card-list">
            {filteredEntries.map((entry) => (
              <ApprovalEntryCard
                key={`${entry.pageId}:${entry.nextPath ?? entry.previousPath ?? entry.changeType}`}
                entry={entry}
                busyAction={busyAction}
                onReviewAction={onReviewAction}
                onOpenPage={onOpenPage}
                selected={selectedIds.has(entry.pageId)}
                onToggleSelected={onBulkReview ? toggleSelected : undefined}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

type ApprovalEntryCardProps = {
  entry: ViewerApprovalDetail["entries"][number];
  busyAction: string;
  onReviewAction: (pageId: string, action: "accept" | "reject") => void;
  onOpenPage: OpenPageFn;
  selected: boolean;
  onToggleSelected?: (pageId: string) => void;
};

function ApprovalEntryCard({ entry, busyAction, onReviewAction, onOpenPage, selected, onToggleSelected }: ApprovalEntryCardProps) {
  const [showDiff, setShowDiff] = useState(false);
  const hasDiff = Boolean(entry.structuredDiff?.hunks.length);
  const hasProtectedWarning = entry.warnings?.includes("protected_frontmatter_changed") ?? false;

  return (
    <article className={`card${selected ? " is-selected" : ""}`}>
      <div className="card-row">
        {onToggleSelected && entry.status === "pending" ? (
          <label className="checkbox-cell">
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelected(entry.pageId)}
              aria-label={`Select ${entry.title}`}
            />
          </label>
        ) : null}
        <span className="label">
          {entry.status} / {entry.changeType}
        </span>
      </div>
      <strong className="card-title">{entry.title}</strong>
      <p className="text-mono text-sm">{entry.nextPath ?? entry.previousPath}</p>
      {hasProtectedWarning ? <p className="text-error text-sm">Warning: protected frontmatter fields changed.</p> : null}
      <div className="action-row">
        {entry.stagedContent ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void onOpenPage(entry.nextPath ?? entry.previousPath ?? "", entry.pageId)}
          >
            Open page
          </button>
        ) : null}
        {hasDiff ? (
          <button type="button" className="btn btn-ghost" onClick={() => setShowDiff((prev) => !prev)}>
            {showDiff ? "Hide diff" : "View diff"}
          </button>
        ) : null}
      </div>
      {showDiff && entry.structuredDiff ? <DiffView diff={entry.structuredDiff} warnings={entry.warnings} /> : null}
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
  );
}
