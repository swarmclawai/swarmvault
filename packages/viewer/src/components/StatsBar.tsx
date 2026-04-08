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
  generatedAt,
  nodeCount,
  edgeCount,
  communityCount,
  approvalCount,
  candidateCount,
  pendingRefreshCount,
  benchmarkRatio
}: StatsBarProps) {
  return (
    <div className="stats-strip">
      <div className="stat">
        <span className="stat-label">Generated</span>
        <span className="stat-value">{generatedAt ? new Date(generatedAt).toLocaleString() : "\u2014"}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Nodes</span>
        <span className="stat-value">{nodeCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Edges</span>
        <span className="stat-value">{edgeCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Communities</span>
        <span className="stat-value">{communityCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Approvals</span>
        <span className="stat-value">{approvalCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Candidates</span>
        <span className="stat-value">{candidateCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Refresh</span>
        <span className="stat-value">{pendingRefreshCount}</span>
      </div>
      <div className="stat">
        <span className="stat-label">Benchmark</span>
        <span className="stat-value">{benchmarkRatio != null ? `${(benchmarkRatio * 100).toFixed(1)}%` : "\u2014"}</span>
      </div>
    </div>
  );
}
