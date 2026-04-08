import type { OpenPageFn, ViewerOutputAsset, ViewerPagePayload } from "./types";

function assetUrl(asset: ViewerOutputAsset): string {
  return asset.dataUrl ?? `/api/asset?path=${encodeURIComponent(asset.path)}`;
}

type PageLink = { id: string; path: string; title: string };

type PagePreviewProps = {
  activePage: ViewerPagePayload | null;
  pageError: string | null;
  backlinkPages: PageLink[];
  relatedPages: PageLink[];
  graphPageLinks: PageLink[];
  onOpenPage: OpenPageFn;
};

export function PagePreview({ activePage, pageError, backlinkPages, relatedPages, graphPageLinks, onOpenPage }: PagePreviewProps) {
  return (
    <section className="panel page-panel">
      <h3 className="panel-heading">Page Preview</h3>
      {pageError ? <p className="text-error">{pageError}</p> : null}
      {activePage ? (
        <>
          <span className="label">{activePage.path}</span>
          <h4 className="card-title" style={{ margin: "4px 0 8px" }}>
            {activePage.title}
          </h4>
          <p className="text-muted text-sm">
            {typeof activePage.frontmatter.kind === "string" ? activePage.frontmatter.kind : "page"} /{" "}
            {typeof activePage.frontmatter.status === "string" ? activePage.frontmatter.status : "active"}
          </p>
          {typeof activePage.frontmatter.source_type === "string" ? (
            <p className="text-muted text-sm">Source: {activePage.frontmatter.source_type}</p>
          ) : null}
          <p className="text-muted text-sm">
            Projects:{" "}
            {Array.isArray(activePage.frontmatter.project_ids)
              ? (activePage.frontmatter.project_ids as string[]).join(", ") || "Global"
              : "Global"}
          </p>
          <p className="text-secondary text-sm">{activePage.content.replace(/\s+/g, " ").trim().slice(0, 220)}</p>
          {activePage.assets.length ? (
            <div className="asset-preview">
              {activePage.assets.map((asset) =>
                asset.mimeType.startsWith("image/") ? (
                  <figure key={asset.id} className="asset-card">
                    <img src={assetUrl(asset)} alt={activePage.title} />
                    <figcaption>
                      {asset.role} / {asset.mimeType}
                    </figcaption>
                  </figure>
                ) : (
                  <a key={asset.id} className="btn btn-ghost" href={assetUrl(asset)} target="_blank" rel="noreferrer">
                    Open {asset.role}
                  </a>
                )
              )}
            </div>
          ) : null}
          {backlinkPages.length ? (
            <div className="linked-section">
              <span className="label">Backlinks</span>
              <div className="chip-row">
                {backlinkPages.map((page) => (
                  <button key={page.id} type="button" className="btn btn-ghost" onClick={() => void onOpenPage(page.path, page.id)}>
                    {page.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {relatedPages.length ? (
            <div className="linked-section">
              <span className="label">Related Pages</span>
              <div className="chip-row">
                {relatedPages.map((page) => (
                  <button key={page.id} type="button" className="btn btn-ghost" onClick={() => void onOpenPage(page.path, page.id)}>
                    {page.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {graphPageLinks.length ? (
            <div className="linked-section">
              <span className="label">Graph Reports</span>
              <div className="chip-row">
                {graphPageLinks.slice(0, 6).map((page) => (
                  <button key={page.id} type="button" className="btn btn-ghost" onClick={() => void onOpenPage(page.path, page.id)}>
                    {page.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <pre className="content-pre">{activePage.content.slice(0, 1200)}</pre>
        </>
      ) : (
        <p className="text-muted text-sm">Open a search result, review entry, candidate, or graph node page.</p>
      )}
    </section>
  );
}
