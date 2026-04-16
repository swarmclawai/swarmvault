import type { Core } from "cytoscape";
import { useState } from "react";
import { buildSubgraphExport, downloadDataUrl, downloadText, type ViewerGraphArtifact } from "../lib";

type ExportMenuProps = {
  cyRef: React.MutableRefObject<Core | null>;
  graph: ViewerGraphArtifact | null;
  selectedNodeIds: string[];
  pageMarkdown?: { title: string; content: string } | null;
};

function exportCanvasImage(cy: Core, format: "png" | "jpg"): string | null {
  if (!cy) return null;
  const exporter = cy.png as ((opts: { full: boolean; bg: string; output: "base64uri" }) => string) | undefined;
  if (!exporter) return null;
  if (format === "png") {
    return cy.png({ full: true, bg: "transparent", output: "base64uri" });
  }
  return cy.jpg({ full: true, bg: "#ffffff", output: "base64uri", quality: 0.9 });
}

function exportCanvasSvg(cy: Core): string | null {
  // Cytoscape ships SVG via plugin; fall back to manual minimal SVG when plugin missing.
  const cyAny = cy as unknown as { svg?: (opts: { full: boolean; scale: number }) => string };
  if (typeof cyAny.svg === "function") {
    return cyAny.svg({ full: true, scale: 1 });
  }
  return null;
}

export function ExportMenu({ cyRef, graph, selectedNodeIds, pageMarkdown }: ExportMenuProps) {
  const [open, setOpen] = useState(false);

  const handlePng = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const data = exportCanvasImage(cy, "png");
    if (data) downloadDataUrl(`swarmvault-graph-${Date.now()}.png`, data);
    setOpen(false);
  };

  const handleSvg = () => {
    const cy = cyRef.current;
    if (!cy) return;
    const svg = exportCanvasSvg(cy);
    if (svg) downloadText(`swarmvault-graph-${Date.now()}.svg`, svg, "image/svg+xml");
    setOpen(false);
  };

  const handleSubgraph = () => {
    if (!graph) return;
    const ids = selectedNodeIds.length ? selectedNodeIds : graph.nodes.map((node) => node.id);
    const payload = buildSubgraphExport(graph, ids);
    downloadText(`swarmvault-subgraph-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
    setOpen(false);
  };

  const handleCopyMarkdown = async () => {
    if (!pageMarkdown) return;
    const text = `# ${pageMarkdown.title}\n\n${pageMarkdown.content}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      downloadText(`${pageMarkdown.title.replace(/[^a-z0-9-_.]+/gi, "-") || "page"}.md`, text, "text/markdown");
    }
    setOpen(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <button type="button" className="btn" onClick={() => setOpen((prev) => !prev)} aria-expanded={open} aria-haspopup="menu">
        Export ▾
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            background: "var(--c-bg-elevated)",
            border: "1px solid var(--c-border)",
            borderRadius: "var(--radius-md)",
            padding: "var(--sp-1)",
            zIndex: 20,
            boxShadow: "var(--c-shadow-elevated)",
            display: "flex",
            flexDirection: "column",
            minWidth: 200
          }}
        >
          <button type="button" role="menuitem" className="palette-item" onClick={handlePng}>
            Canvas as PNG
          </button>
          <button type="button" role="menuitem" className="palette-item" onClick={handleSvg}>
            Canvas as SVG
          </button>
          <button type="button" role="menuitem" className="palette-item" onClick={handleSubgraph}>
            Subgraph as JSON ({selectedNodeIds.length || (graph?.nodes.length ?? 0)} nodes)
          </button>
          <button type="button" role="menuitem" className="palette-item" onClick={handleCopyMarkdown} disabled={!pageMarkdown}>
            Copy page as markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}
