import type { NavigateNodeFn, ViewerGraphExplainResult, ViewerGraphNode } from "./types";

type SelectionPanelProps = {
  selected: ViewerGraphNode | null;
  graphExplain: ViewerGraphExplainResult | null;
  graphError: string | null;
  onNavigateNode: NavigateNodeFn;
};

export function SelectionPanel({ selected, graphExplain, graphError, onNavigateNode }: SelectionPanelProps) {
  if (!selected) {
    return (
      <section className="panel" data-selected-node-id="" data-testid="selection-panel">
        <h3 className="panel-heading">Selection</h3>
        <div className="empty-state">
          <span className="empty-state-icon">{"\u25C8"}</span>
          <p className="text-muted text-sm">Select a node to inspect graph metrics and linked pages.</p>
        </div>
      </section>
    );
  }

  const sourceDisplay =
    selected.sourceIds.length > 3
      ? `${selected.sourceIds.slice(0, 3).join(", ")} +${selected.sourceIds.length - 3} more`
      : selected.sourceIds.join(", ") || "None";

  return (
    <section className="panel" data-selected-node-id={selected.id} data-testid="selection-panel">
      <h3 className="panel-heading">Selection</h3>
      {graphError ? <p className="text-error">{graphError}</p> : null}
      <span className="label">{selected.type}</span>
      <h4 className="card-title" style={{ margin: "4px 0 8px" }}>
        {selected.label}
      </h4>
      <div className="meta-grid">
        <span className="meta-label">ID</span>
        <code className="meta-value meta-value-truncate" title={selected.id}>
          {selected.id}
        </code>
        {selected.language ? (
          <>
            <span className="meta-label">Language</span>
            <span className="meta-value" title={selected.language}>
              {selected.language}
            </span>
          </>
        ) : null}
        {selected.symbolKind ? (
          <>
            <span className="meta-label">Symbol</span>
            <span className="meta-value" title={selected.symbolKind}>
              {selected.symbolKind}
            </span>
          </>
        ) : null}
        {selected.moduleId ? (
          <>
            <span className="meta-label">Module</span>
            <code className="meta-value meta-value-truncate" title={selected.moduleId}>
              {selected.moduleId}
            </code>
          </>
        ) : null}
        <span className="meta-label">Sources</span>
        <span className="meta-value" title={selected.sourceIds.join(", ") || "None"}>
          {sourceDisplay}
        </span>
        <span className="meta-label">Projects</span>
        <span className="meta-value" title={selected.projectIds.join(", ") || "Global"}>
          {selected.projectIds.join(", ") || "Global"}
        </span>
        <span className="meta-label">Community</span>
        <span className="meta-value" title={selected.communityId ?? "Unassigned"}>
          {selected.communityId ?? "Unassigned"}
        </span>
        <span className="meta-label">Degree</span>
        <span className="meta-value mono">{selected.degree ?? 0}</span>
        <span className="meta-label">Bridge</span>
        <span className="meta-value mono">{selected.bridgeScore ?? 0}</span>
        <span className="meta-label">God node</span>
        <span className="meta-value">{selected.isGodNode ? "Yes" : "No"}</span>
      </div>
      {graphExplain?.hyperedges.length ? (
        <div className="linked-section">
          <span className="label">Group Patterns</span>
          <div className="chip-row">
            {graphExplain.hyperedges.slice(0, 6).map((hyperedge) => (
              <button
                key={hyperedge.id}
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  const nextNodeId = hyperedge.nodeIds.find((nodeId) => nodeId !== selected.id) ?? hyperedge.nodeIds[0];
                  if (nextNodeId) onNavigateNode(nextNodeId);
                }}
              >
                {hyperedge.label}
              </button>
            ))}
          </div>
          {graphExplain.hyperedges[0]?.why ? <p className="text-secondary text-sm">{graphExplain.hyperedges[0].why}</p> : null}
        </div>
      ) : null}
      {graphExplain?.neighbors.length ? (
        <div className="linked-section">
          <span className="label">Neighbors</span>
          <div className="chip-row">
            {graphExplain.neighbors.slice(0, 8).map((neighbor) => (
              <button
                key={`${neighbor.direction}:${neighbor.nodeId}:${neighbor.relation}`}
                type="button"
                className="btn btn-ghost"
                onClick={() => onNavigateNode(neighbor.nodeId)}
              >
                {neighbor.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
