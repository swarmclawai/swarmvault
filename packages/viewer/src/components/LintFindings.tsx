import type { OpenPageFn, ViewerLintFinding } from "./types";

type LintFindingsProps = {
  findings: ViewerLintFinding[];
  error?: string;
  onOpenPage: OpenPageFn;
};

const SEVERITY_LABEL: Record<ViewerLintFinding["severity"], string> = {
  error: "is-error",
  warning: "is-warning",
  info: "is-info"
};

export function LintFindings({ findings, error, onOpenPage }: LintFindingsProps) {
  if (error) {
    return (
      <section className="panel" aria-label="Lint findings">
        <h3 className="panel-heading">Lint Findings</h3>
        <p className="text-error">{error}</p>
      </section>
    );
  }
  if (!findings.length) {
    return (
      <section className="panel" aria-label="Lint findings">
        <h3 className="panel-heading">Lint Findings</h3>
        <p className="text-muted text-sm">
          No lint findings. Run <code>swarmvault lint --deep</code> for a fresh sweep.
        </p>
      </section>
    );
  }
  const grouped = findings.reduce<Record<string, ViewerLintFinding[]>>((acc, finding) => {
    const bucket = acc[finding.category] ?? [];
    bucket.push(finding);
    acc[finding.category] = bucket;
    return acc;
  }, {});
  return (
    <section className="panel" aria-label="Lint findings">
      <h3 className="panel-heading">
        Lint Findings <span className="panel-meta">{findings.length} total</span>
      </h3>
      <div className="card-list">
        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <p className="label" style={{ marginBottom: 4 }}>
              {category} · {items.length}
            </p>
            <div className="card-list">
              {items.slice(0, 12).map((finding) => (
                <article key={finding.id} className={`lint-finding ${SEVERITY_LABEL[finding.severity]}`}>
                  <strong className="text-sm">{finding.message}</strong>
                  {finding.pagePath ? (
                    <button type="button" className="btn btn-ghost" onClick={() => void onOpenPage(finding.pagePath ?? "", finding.pageId)}>
                      Open page
                    </button>
                  ) : null}
                </article>
              ))}
              {items.length > 12 ? <p className="text-muted text-sm">+{items.length - 12} more</p> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
