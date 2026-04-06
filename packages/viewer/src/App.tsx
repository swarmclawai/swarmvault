import { useEffect, useRef, useState } from "react";
import cytoscape, { type Core } from "cytoscape";
import { fetchGraphArtifact, type ViewerGraphArtifact, type ViewerGraphNode } from "./lib";

const COLORS: Record<string, string> = {
  source: "#f59e0b",
  concept: "#0ea5e9",
  entity: "#22c55e"
};

export function App() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [graph, setGraph] = useState<ViewerGraphArtifact | null>(null);
  const [selected, setSelected] = useState<ViewerGraphNode | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    void fetchGraphArtifact()
      .then(setGraph)
      .catch(() => setGraph({ generatedAt: "", nodes: [], edges: [] }));
  }, []);

  useEffect(() => {
    if (!containerRef.current || !graph) {
      return;
    }

    cyRef.current?.destroy();
    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...graph.nodes.map((node) => ({
          data: { ...node, color: COLORS[node.type] ?? "#94a3b8" }
        })),
        ...graph.edges
          .filter((edge) => statusFilter === "all" || edge.status === statusFilter)
          .map((edge) => ({
            data: edge
          }))
      ],
      layout: {
        name: "cose",
        animate: false,
        idealEdgeLength: 120,
        nodeRepulsion: 8000
      },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(color)",
            color: "#f8fafc",
            "text-outline-color": "#020617",
            "text-outline-width": 2,
            "font-family": "\"Avenir Next\", \"Segoe UI\", sans-serif",
            "font-size": 11
          }
        },
        {
          selector: "edge",
          style: {
            width: 2,
            "line-color": "#64748b",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#64748b",
            "curve-style": "bezier",
            label: "data(relation)",
            "font-size": 9,
            color: "#cbd5e1"
          }
        },
        {
          selector: ":selected",
          style: {
            "border-width": 3,
            "border-color": "#f8fafc"
          }
        }
      ]
    });

    cy.on("select", "node", (event) => {
      setSelected(event.target.data() as ViewerGraphNode);
    });
    cy.on("unselect", "node", () => {
      setSelected(null);
    });

    cyRef.current = cy;
    return () => cy.destroy();
  }, [graph, statusFilter]);

  return (
    <main className="app-shell">
      <section className="app-header">
        <div>
          <p className="eyebrow">SwarmVault Viewer</p>
          <h1>Knowledge graph with provenance-first structure</h1>
          <p className="lede">
            Sources, concepts, and entities stay visible as separate layers so the wiki does not collapse into a pile of summaries.
          </p>
        </div>
        <label className="filter">
          Edge status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All</option>
            <option value="extracted">Extracted</option>
            <option value="conflicted">Conflicted</option>
            <option value="inferred">Inferred</option>
          </select>
        </label>
      </section>

      <section className="stats">
        <article>
          <span>Generated</span>
          <strong>{graph?.generatedAt ? new Date(graph.generatedAt).toLocaleString() : "Not compiled"}</strong>
        </article>
        <article>
          <span>Nodes</span>
          <strong>{graph?.nodes.length ?? 0}</strong>
        </article>
        <article>
          <span>Edges</span>
          <strong>{graph?.edges.length ?? 0}</strong>
        </article>
      </section>

      <section className="workspace">
        <div className="canvas" ref={containerRef} />
        <aside className="panel">
          <h2>Selection</h2>
          {selected ? (
            <>
              <p className="panel-label">{selected.type}</p>
              <h3>{selected.label}</h3>
              <p>Node ID: <code>{selected.id}</code></p>
              <p>Sources: {selected.sourceIds.join(", ") || "None"}</p>
            </>
          ) : (
            <p>Select a node to inspect its details.</p>
          )}
        </aside>
      </section>
    </main>
  );
}
