import type { NavigateNodeFn, OpenPageFn, ViewerGraphArtifact, ViewerGraphPathResult, ViewerGraphQueryResult } from "./types";

type GraphToolsProps = {
  graphQueryInput: string;
  onGraphQueryInputChange: (value: string) => void;
  onRunQuery: () => void;
  graphQueryResult: ViewerGraphQueryResult | null;
  pathFrom: string;
  onPathFromChange: (value: string) => void;
  pathTo: string;
  onPathToChange: (value: string) => void;
  onHighlightPath: () => void;
  pathResult: ViewerGraphPathResult | null;
  graphError: string | null;
  graph: ViewerGraphArtifact | null;
  onOpenPage: OpenPageFn;
  onNavigateNode: NavigateNodeFn;
};

export function GraphTools({
  graphQueryInput,
  onGraphQueryInputChange,
  onRunQuery,
  graphQueryResult,
  pathFrom,
  onPathFromChange,
  pathTo,
  onPathToChange,
  onHighlightPath,
  pathResult,
  graphError,
  graph,
  onOpenPage,
  onNavigateNode
}: GraphToolsProps) {
  return (
    <section className="panel">
      <h3 className="panel-heading">Graph Tools</h3>
      {graphError ? <p className="text-error">{graphError}</p> : null}
      <div className="card-list">
        <article className="card">
          <span className="label">query</span>
          <input
            type="search"
            className="input"
            value={graphQueryInput}
            onChange={(event) => onGraphQueryInputChange(event.target.value)}
            placeholder="Ask the local graph"
          />
          <button type="button" className="btn btn-primary" onClick={onRunQuery}>
            Run
          </button>
          {graphQueryResult ? (
            <>
              <p className="text-secondary text-sm">{graphQueryResult.summary}</p>
              <div className="chip-row">
                {graphQueryResult.hyperedgeIds
                  .map((hyperedgeId) => graph?.hyperedges?.find((hyperedge) => hyperedge.id === hyperedgeId))
                  .filter((hyperedge): hyperedge is NonNullable<typeof hyperedge> => Boolean(hyperedge))
                  .slice(0, 2)
                  .map((hyperedge) => (
                    <button
                      key={hyperedge.id}
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        const nextNodeId = hyperedge.nodeIds[0];
                        if (nextNodeId) onNavigateNode(nextNodeId);
                      }}
                    >
                      {hyperedge.label}
                    </button>
                  ))}
                {graphQueryResult.pageIds
                  .map((pageId) => graph?.pages?.find((page) => page.id === pageId))
                  .filter((page): page is NonNullable<typeof page> => Boolean(page))
                  .slice(0, 4)
                  .map((page) => (
                    <button key={page.id} type="button" className="btn btn-ghost" onClick={() => void onOpenPage(page.path, page.id)}>
                      {page.title}
                    </button>
                  ))}
              </div>
            </>
          ) : null}
        </article>
        <article className="card">
          <span className="label">path</span>
          <input
            type="text"
            className="input"
            value={pathFrom}
            onChange={(event) => onPathFromChange(event.target.value)}
            placeholder="From"
          />
          <input type="text" className="input" value={pathTo} onChange={(event) => onPathToChange(event.target.value)} placeholder="To" />
          <button type="button" className="btn btn-primary" onClick={onHighlightPath}>
            Highlight
          </button>
          {pathResult ? <p className="text-secondary text-sm">{pathResult.summary}</p> : null}
        </article>
      </div>
    </section>
  );
}
