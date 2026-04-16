import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import type { NavigateNodeFn, OpenPageFn, ViewerOutputAsset, ViewerPagePayload } from "./types";

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
  onNavigateNode?: NavigateNodeFn;
};

const PREVIEW_COLLAPSED_CHARS = 1200;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function asStringList(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string").join(", ");
  }
  return "";
}

export function PagePreview({
  activePage,
  pageError,
  backlinkPages,
  relatedPages,
  graphPageLinks,
  onOpenPage,
  onNavigateNode
}: PagePreviewProps) {
  const [expanded, setExpanded] = useState(false);

  const frontmatter = activePage?.frontmatter ?? {};
  const sourceIds = asStringArray(frontmatter.source_ids);
  const nodeIds = asStringArray(frontmatter.node_ids);
  const tags = [...asStringArray(frontmatter.tags), ...asStringArray(frontmatter.semantic_tags)];
  const kind = asString(frontmatter.kind) ?? "page";
  const status = asString(frontmatter.status) ?? "active";
  const sourceType = asString(frontmatter.source_type);
  const projects = asStringList(frontmatter.project_ids) || "Global";
  const pageId = asString(frontmatter.page_id);
  const freshness = asString(frontmatter.freshness);

  const showExpand = activePage ? activePage.content.length > PREVIEW_COLLAPSED_CHARS : false;
  const displayContent = useMemo(() => {
    if (!activePage) return "";
    if (expanded || !showExpand) return activePage.content;
    return `${activePage.content.slice(0, PREVIEW_COLLAPSED_CHARS)}…`;
  }, [activePage, expanded, showExpand]);

  return (
    <section className="panel page-panel" data-testid="page-preview">
      <h3 className="panel-heading">Page Preview</h3>
      {pageError ? <p className="text-error">{pageError}</p> : null}
      {activePage ? (
        <>
          <span className="label">{activePage.path}</span>
          <h4 className="card-title" style={{ margin: "4px 0 8px" }}>
            {activePage.title}
          </h4>
          <div className="meta-grid">
            <span className="meta-label">Kind</span>
            <span className="meta-value">
              {kind} / {status}
            </span>
            {sourceType ? (
              <>
                <span className="meta-label">Source</span>
                <span className="meta-value">{sourceType}</span>
              </>
            ) : null}
            <span className="meta-label">Projects</span>
            <span className="meta-value">{projects}</span>
            {pageId ? (
              <>
                <span className="meta-label">Page ID</span>
                <code className="meta-value mono meta-value-truncate" title={pageId}>
                  {pageId}
                </code>
              </>
            ) : null}
            {freshness ? (
              <>
                <span className="meta-label">Freshness</span>
                <span className="meta-value mono">{freshness}</span>
              </>
            ) : null}
          </div>
          {sourceIds.length ? (
            <div className="linked-section">
              <span className="label">Sources</span>
              <div className="chip-row">
                {sourceIds.slice(0, 8).map((sourceId) => (
                  <code key={sourceId} className="chip chip-static" title={sourceId}>
                    {sourceId}
                  </code>
                ))}
                {sourceIds.length > 8 ? <span className="text-muted text-sm">+{sourceIds.length - 8} more</span> : null}
              </div>
            </div>
          ) : null}
          {nodeIds.length && onNavigateNode ? (
            <div className="linked-section">
              <span className="label">Graph Nodes</span>
              <div className="chip-row">
                {nodeIds.slice(0, 8).map((nodeId) => (
                  <button
                    key={nodeId}
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onNavigateNode(nodeId)}
                    title={`Select ${nodeId}`}
                  >
                    {nodeId}
                  </button>
                ))}
                {nodeIds.length > 8 ? <span className="text-muted text-sm">+{nodeIds.length - 8} more</span> : null}
              </div>
            </div>
          ) : null}
          {tags.length ? (
            <div className="linked-section">
              <span className="label">Tags</span>
              <div className="chip-row">
                {tags.map((tag) => (
                  <span key={tag} className="chip chip-tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
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
          <article className="markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
            >
              {displayContent}
            </ReactMarkdown>
          </article>
          {showExpand ? (
            <div className="action-row">
              <button type="button" className="btn btn-ghost" onClick={() => setExpanded((prev) => !prev)}>
                {expanded ? "Collapse" : `Show all ${activePage.content.length.toLocaleString()} characters`}
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="empty-state">
          <span className="empty-state-icon">{"\uD83D\uDCC4"}</span>
          <p className="text-muted text-sm">Open a search result, review entry, candidate, or graph node page.</p>
        </div>
      )}
    </section>
  );
}
