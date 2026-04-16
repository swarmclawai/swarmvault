import { useState } from "react";

const NODE_TYPES = [
  { id: "source", label: "Source", color: "#f59e0b", shape: "shape-round" },
  { id: "module", label: "Module", color: "#fb7185", shape: "" },
  { id: "symbol", label: "Symbol", color: "#8b5cf6", shape: "shape-diamond" },
  { id: "rationale", label: "Rationale", color: "#14b8a6", shape: "shape-hex" },
  { id: "concept", label: "Concept", color: "#0ea5e9", shape: "" },
  { id: "entity", label: "Entity", color: "#22c55e", shape: "shape-round" }
];

const EDGE_KINDS = [
  { label: "Structural (extracted)", color: "rgba(148, 163, 184, 0.7)", style: "line-solid" },
  { label: "Inferred", color: "rgba(56, 189, 248, 0.7)", style: "line-solid" },
  { label: "Conflicted", color: "var(--c-text-error)", style: "line-solid" },
  { label: "Similarity", color: "rgba(249, 115, 22, 0.7)", style: "line-dashed" }
];

export function GraphLegend() {
  const [open, setOpen] = useState(true);
  if (!open) {
    return (
      <button type="button" className="btn legend-toggle" onClick={() => setOpen(true)} title="Show legend" aria-label="Show legend">
        Legend
      </button>
    );
  }
  return (
    <aside className="canvas-legend" aria-label="Graph legend">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="canvas-legend-heading">Legend</span>
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)} aria-label="Hide legend" title="Hide legend">
          ×
        </button>
      </div>
      <div className="canvas-legend-group">
        <span className="label">Nodes</span>
        {NODE_TYPES.map((node) => (
          <div key={node.id} className="legend-row">
            <span className={`legend-swatch ${node.shape}`} style={{ background: node.color }} aria-hidden="true" />
            <span>{node.label}</span>
          </div>
        ))}
      </div>
      <div className="canvas-legend-group" style={{ marginTop: "var(--sp-2)" }}>
        <span className="label">Edges</span>
        {EDGE_KINDS.map((edge) => (
          <div key={edge.label} className="legend-row">
            <span className={`legend-swatch ${edge.style}`} style={{ color: edge.color }} aria-hidden="true" />
            <span>{edge.label}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
