import { useState } from "react";
import { Tabs } from "./Tabs";
import type { NavigateNodeFn, OpenPageFn, ViewerGraphReport } from "./types";

type ReportTabsProps = {
  graphReport: ViewerGraphReport | null;
  onOpenPage: OpenPageFn;
  onNavigateNode: NavigateNodeFn;
  onHighlightSurprise: (sourceNodeId: string, targetNodeId: string) => void;
};

export function ReportTabs({ graphReport, onOpenPage, onNavigateNode, onHighlightSurprise }: ReportTabsProps) {
  const [activeTab, setActiveTab] = useState("overview");

  if (!graphReport) {
    return (
      <div className="report-tabs">
        <div className="report-tabs-empty">Loading graph report...</div>
      </div>
    );
  }

  return (
    <div className="report-tabs">
      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "surprising", label: "Surprising", count: graphReport.surprisingConnections.length },
          { id: "patterns", label: "Patterns", count: graphReport.groupPatterns.length },
          { id: "benchmark", label: "Benchmark" },
          { id: "sources", label: "Sources", count: graphReport.recentResearchSources.length }
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "overview" && (
          <div>
            <div className="report-stats">
              <span>
                Nodes <strong>{graphReport.overview.nodes}</strong>
              </span>
              <span>
                Edges <strong>{graphReport.overview.edges}</strong>
              </span>
              <span>
                Communities <strong>{graphReport.overview.communities}</strong>
              </span>
            </div>
            <div className="report-stats" style={{ marginTop: 6 }}>
              <span className="text-muted">
                1st-party: {graphReport.firstPartyOverview.nodes} nodes \u00b7 {graphReport.firstPartyOverview.edges} edges \u00b7{" "}
                {graphReport.firstPartyOverview.communities} communities
              </span>
            </div>
            {graphReport.warnings.length ? (
              <div className="linked-section">
                <span className="label">Warnings</span>
                <div className="card-list">
                  {graphReport.warnings.map((warning) => (
                    <article key={warning} className="card card-warning">
                      <p className="text-sm">
                        {"\u26A0"} {warning}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {activeTab === "surprising" && (
          <div>
            {graphReport.surprisingConnections.length ? (
              <div className="card-list">
                {graphReport.surprisingConnections.map((connection) => (
                  <article key={connection.id} className="card">
                    <div className="surprise-row">
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => onHighlightSurprise(connection.sourceNodeId, connection.targetNodeId)}
                      >
                        {connection.sourceLabel} &rarr; {connection.targetLabel}
                      </button>
                      <span className="text-mono text-sm">{connection.relation}</span>
                    </div>
                    {connection.explanation ? <p className="text-secondary text-sm">{connection.explanation}</p> : null}
                    {connection.confidence != null ? (
                      <span className="text-muted text-sm">confidence: {connection.confidence.toFixed(2)}</span>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-muted text-sm">No surprising connections detected.</p>
            )}
          </div>
        )}

        {activeTab === "patterns" && (
          <div>
            {graphReport.groupPatterns.length ? (
              <div className="card-list">
                {graphReport.groupPatterns.map((hyperedge) => (
                  <article key={hyperedge.id} className="card">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        const nextNodeId = hyperedge.nodeIds[0];
                        if (nextNodeId) onNavigateNode(nextNodeId);
                      }}
                    >
                      {hyperedge.label}
                    </button>
                    {hyperedge.why ? <p className="text-secondary text-sm">{hyperedge.why}</p> : null}
                    <span className="text-muted text-sm">
                      {hyperedge.nodeIds.length} nodes \u00b7 {hyperedge.relation}
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-muted text-sm">No group patterns detected.</p>
            )}
            {graphReport.suggestedQuestions?.length ? (
              <div className="linked-section">
                <span className="label">Suggested Questions</span>
                <div className="card-list">
                  {graphReport.suggestedQuestions.map((question) => (
                    <p key={question} className="text-secondary text-sm">
                      {question}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {activeTab === "benchmark" && (
          <div>
            {graphReport.benchmark ? (
              <div className="meta-grid">
                <span className="meta-label">Status</span>
                <span className="meta-value">{graphReport.benchmark.stale ? "Stale" : "Fresh"}</span>
                <span className="meta-label">Questions</span>
                <span className="meta-value mono">{graphReport.benchmark.summary.questionCount}</span>
                <span className="meta-label">Context tokens</span>
                <span className="meta-value mono">{graphReport.benchmark.summary.finalContextTokens.toLocaleString()}</span>
                <span className="meta-label">Naive corpus</span>
                <span className="meta-value mono">{graphReport.benchmark.summary.naiveCorpusTokens.toLocaleString()}</span>
                <span className="meta-label">Reduction</span>
                <span className="meta-value mono">{(graphReport.benchmark.summary.reductionRatio * 100).toFixed(1)}%</span>
                <span className="meta-label">Unique visited</span>
                <span className="meta-value mono">{graphReport.benchmark.summary.uniqueVisitedNodes}</span>
              </div>
            ) : (
              <p className="text-muted text-sm">No benchmark summary is available yet.</p>
            )}
          </div>
        )}

        {activeTab === "sources" && (
          <div>
            {graphReport.recentResearchSources.length ? (
              <div className="card-list">
                {graphReport.recentResearchSources.map((page) => (
                  <article key={page.pageId} className="card">
                    <button type="button" className="btn btn-ghost" onClick={() => void onOpenPage(page.path, page.pageId)}>
                      {page.title}
                    </button>
                    <span className="text-muted text-sm">
                      {page.sourceType} \u00b7 {page.updatedAt ? new Date(page.updatedAt).toLocaleDateString() : ""}
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <p className="text-muted text-sm">No recent research sources.</p>
            )}
          </div>
        )}
      </Tabs>
    </div>
  );
}
