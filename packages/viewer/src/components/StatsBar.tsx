type StatsBarProps = {
  generatedAt: string | null;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  approvalCount: number;
  candidateCount: number;
  pendingRefreshCount: number;
  benchmarkRatio: number | null;
};

export function StatsBar({
  nodeCount,
  edgeCount,
  communityCount,
  approvalCount,
  candidateCount,
  pendingRefreshCount,
  benchmarkRatio
}: StatsBarProps) {
  const workflowTotal = approvalCount + candidateCount + pendingRefreshCount;

  return (
    <div className="stats-strip">
      <div className="stats-group">
        <div className="stat">
          <span className="stat-label">Nodes</span>
          <span className="stat-value">{nodeCount.toLocaleString()}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Edges</span>
          <span className="stat-value">{edgeCount.toLocaleString()}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Communities</span>
          <span className="stat-value">{communityCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Benchmark</span>
          <span className="stat-value">{benchmarkRatio != null ? `${(benchmarkRatio * 100).toFixed(1)}%` : "\u2014"}</span>
        </div>
      </div>
      {workflowTotal > 0 ? (
        <>
          <div className="stats-divider" />
          <div className="stats-group">
            {approvalCount > 0 ? (
              <div className="stat">
                <span className="stat-label">Approvals</span>
                <span className="stat-value">{approvalCount}</span>
              </div>
            ) : null}
            {candidateCount > 0 ? (
              <div className="stat">
                <span className="stat-label">Candidates</span>
                <span className="stat-value">{candidateCount}</span>
              </div>
            ) : null}
            {pendingRefreshCount > 0 ? (
              <div className="stat">
                <span className="stat-label">Refresh</span>
                <span className="stat-value">{pendingRefreshCount}</span>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
