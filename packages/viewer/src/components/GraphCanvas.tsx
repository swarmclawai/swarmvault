import cytoscape, { type LayoutOptions } from "cytoscape";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { GraphLegend } from "./GraphLegend";
import { GraphMinimap } from "./GraphMinimap";
import type { Core, ViewerGraphArtifact, ViewerGraphNode, ViewerGraphPathResult } from "./types";

declare global {
  interface Window {
    __SWARMVAULT_TEST__?: {
      getNodeIds: () => string[];
      getConnectedNodePair: () => { from: string; to: string } | null;
      getRenderedNodePosition: (nodeId: string) => { x: number; y: number } | null;
      clearSelection: () => void;
      hasClass: (elementId: string, className: string) => boolean;
    };
  }
}

function exposeTestApi(cy: Core): void {
  if (typeof window === "undefined") return;
  window.__SWARMVAULT_TEST__ = {
    getNodeIds: () => cy.nodes().map((node) => node.id()),
    getConnectedNodePair: () => {
      const edge = cy.edges()[0];
      if (!edge || edge.empty()) return null;
      return { from: edge.source().id(), to: edge.target().id() };
    },
    getRenderedNodePosition: (nodeId: string) => {
      const node = cy.getElementById(nodeId);
      if (!node || node.empty()) return null;
      const position = node.renderedPosition();
      return { x: position.x, y: position.y };
    },
    clearSelection: () => {
      cy.elements(":selected").unselect();
    },
    hasClass: (elementId: string, className: string) => {
      const element = cy.getElementById(elementId);
      return !element.empty() && element.hasClass(className);
    }
  };
}

function clearTestApi(cy: Core, currentRef: Core | null): void {
  if (typeof window === "undefined" || !window.__SWARMVAULT_TEST__) return;
  if (currentRef === cy) {
    delete window.__SWARMVAULT_TEST__;
  }
}

const COLORS: Record<string, string> = {
  source: "#f59e0b",
  module: "#fb7185",
  symbol: "#8b5cf6",
  rationale: "#14b8a6",
  concept: "#0ea5e9",
  entity: "#22c55e"
};

export type LayoutName = "cose" | "concentric" | "circle" | "breadthfirst" | "grid";

const LAYOUT_LABELS: Record<LayoutName, string> = {
  cose: "Force (cose)",
  concentric: "Concentric",
  circle: "Circle",
  breadthfirst: "Hierarchy",
  grid: "Grid"
};

const LAYOUT_OPTIONS: Record<LayoutName, LayoutOptions> = {
  cose: {
    name: "cose",
    animate: false,
    idealEdgeLength: 280,
    nodeRepulsion: 120_000,
    nodeOverlap: 60,
    gravity: 0.08,
    nestingFactor: 1.2,
    edgeElasticity: 100,
    numIter: 3000
  } as unknown as LayoutOptions,
  concentric: {
    name: "concentric",
    animate: false,
    minNodeSpacing: 30,
    levelWidth: () => 1
  } as unknown as LayoutOptions,
  circle: { name: "circle", animate: false, radius: 320 } as unknown as LayoutOptions,
  breadthfirst: {
    name: "breadthfirst",
    animate: false,
    spacingFactor: 1.4,
    directed: true
  } as unknown as LayoutOptions,
  grid: { name: "grid", animate: false, padding: 40 } as unknown as LayoutOptions
};

type GraphCanvasProps = {
  graph: ViewerGraphArtifact | null;
  edgeStatusFilter: string;
  communityFilter: string;
  sourceClassFilter: string;
  tagFilter?: string;
  pathResult: ViewerGraphPathResult | null;
  onNodeSelect: (node: ViewerGraphNode | null) => void;
  cyRef: React.MutableRefObject<Core | null>;
  fitTrigger?: number;
  pageTags?: Record<string, string[]>;
  onLayoutChange?: (layout: LayoutName) => void;
};

export function GraphCanvas({
  graph,
  edgeStatusFilter,
  communityFilter,
  sourceClassFilter,
  tagFilter = "all",
  pathResult,
  onNodeSelect,
  cyRef,
  fitTrigger,
  pageTags,
  onLayoutChange
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<LayoutName>("cose");
  const [labelMode, setLabelMode] = useState<"auto" | "always" | "never">("auto");

  const handleNodeSelect = useEffectEvent((node: ViewerGraphNode | null) => {
    onNodeSelect(node);
  });
  const replaceGraphInstance = useEffectEvent((nextGraph: Core) => {
    cyRef.current?.destroy();
    cyRef.current = nextGraph;
  });
  const clearGraphInstance = useEffectEvent((currentGraph: Core) => {
    if (cyRef.current === currentGraph) {
      cyRef.current = null;
    }
    currentGraph.destroy();
  });
  const applyPathHighlight = useEffectEvent((nextPathResult: ViewerGraphPathResult | null) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass("path-node path-edge");
    if (nextPathResult) {
      for (const nodeId of nextPathResult.nodeIds) cy.getElementById(nodeId).addClass("path-node");
      for (const edgeId of nextPathResult.edgeIds) cy.getElementById(edgeId).addClass("path-edge");
    }
  });
  const resizeGraph = useEffectEvent(() => {
    cyRef.current?.resize();
  });

  // Tag filter set
  const tagAllowedNodeIds = (() => {
    if (!graph || tagFilter === "all" || !pageTags) return null;
    const allowed = new Set<string>();
    for (const node of graph.nodes) {
      if (!node.pageId) continue;
      const tags = pageTags[node.pageId];
      if (tags?.includes(tagFilter)) allowed.add(node.id);
    }
    return allowed;
  })();

  useEffect(() => {
    if (!containerRef.current || !graph) return;

    const allowedNodeIds = new Set(
      graph.nodes
        .filter((node) => communityFilter === "all" || node.communityId === communityFilter)
        .filter((node) => sourceClassFilter === "all" || (node.sourceClass ?? "") === sourceClassFilter)
        .filter((node) => !tagAllowedNodeIds || tagAllowedNodeIds.has(node.id))
        .map((node) => node.id)
    );

    const labelStyle = labelMode === "always" ? "data(label)" : labelMode === "never" ? "" : "data(label)";
    const labelMinZoomed = labelMode === "always" ? 0 : labelMode === "never" ? 999 : 0.5;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [
        ...graph.nodes
          .filter((node) => allowedNodeIds.has(node.id))
          .map((node) => ({
            data: { ...node, color: COLORS[node.type] ?? "#94a3b8" }
          })),
        ...graph.edges
          .filter((edge) => allowedNodeIds.has(edge.source) && allowedNodeIds.has(edge.target))
          .filter((edge) => edgeStatusFilter === "all" || edge.status === edgeStatusFilter)
          .map((edge) => ({
            data: edge,
            classes: [
              edge.relation === "semantically_similar_to" ? "similarity-edge" : "",
              edge.status === "conflicted" ? "conflicted-edge" : "",
              edge.status === "inferred" ? "inferred-edge" : ""
            ]
              .filter(Boolean)
              .join(" ")
          }))
      ],
      layout: LAYOUT_OPTIONS[layout],
      style: [
        {
          selector: "node",
          style: {
            label: labelStyle,
            "background-color": "data(color)",
            "background-opacity": 0.85,
            color: "var(--c-text-primary)",
            "font-family": '"Inter", "Segoe UI", system-ui, sans-serif',
            "font-size": 11,
            "font-weight": "normal",
            "text-halign": "center",
            "text-valign": "bottom",
            "text-margin-y": 7,
            "text-max-width": "100px",
            "text-wrap": "ellipsis",
            "min-zoomed-font-size": labelMinZoomed,
            "text-background-opacity": 0.55,
            "text-background-color": "var(--c-bg-base)",
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "border-width": 0,
            "overlay-padding": 4
          }
        },
        {
          selector: "node[?isGodNode]",
          style: {
            width: 56,
            height: 56,
            "border-width": 1.5,
            "border-color": "rgba(254, 240, 138, 0.65)",
            "border-opacity": 1,
            "background-opacity": 1,
            "font-size": 12,
            "font-weight": "bold",
            "text-max-width": "140px",
            "z-index": 12
          }
        },
        { selector: 'node[type = "module"]', style: { shape: "round-rectangle", width: 44, height: 28, "z-index": 8 } },
        { selector: 'node[type = "symbol"]', style: { shape: "diamond", width: 20, height: 20, "background-opacity": 0.6 } },
        { selector: 'node[type = "rationale"]', style: { shape: "hexagon", width: 28, height: 28, "background-opacity": 0.75 } },
        {
          selector: 'node[type = "source"]',
          style: { shape: "ellipse", width: 32, height: 32, "background-opacity": 0.95, "z-index": 10 }
        },
        { selector: 'node[type = "concept"]', style: { shape: "round-rectangle", width: 34, height: 22, "background-opacity": 0.7 } },
        { selector: 'node[type = "entity"]', style: { shape: "ellipse", width: 26, height: 26, "background-opacity": 0.7 } },
        {
          selector: "edge",
          style: {
            width: 0.8,
            "line-color": "rgba(71, 85, 105, 0.45)",
            "target-arrow-shape": "triangle-backcurve",
            "target-arrow-color": "rgba(71, 85, 105, 0.45)",
            "arrow-scale": 0.6,
            "curve-style": "bezier",
            "font-size": 8,
            "text-background-opacity": 0,
            "text-background-color": "var(--c-bg-base)",
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-rotation": "autorotate",
            "text-margin-y": -8
          }
        },
        {
          selector: "edge:selected",
          style: { label: "data(relation)", width: 2, "text-background-opacity": 0.7 }
        },
        {
          selector: ".similarity-edge",
          style: {
            "line-style": "dashed",
            "line-color": "rgba(249, 115, 22, 0.5)",
            "target-arrow-color": "rgba(249, 115, 22, 0.5)",
            "line-dash-pattern": [6, 4]
          }
        },
        {
          selector: ".inferred-edge",
          style: {
            "line-color": "rgba(56, 189, 248, 0.6)",
            "target-arrow-color": "rgba(56, 189, 248, 0.6)"
          }
        },
        {
          selector: ".conflicted-edge",
          style: {
            "line-color": "rgba(248, 113, 113, 0.7)",
            "target-arrow-color": "rgba(248, 113, 113, 0.7)",
            width: 1.5
          }
        },
        {
          selector: ".path-node",
          style: { "border-width": 3, "border-color": "#38bdf8", "background-opacity": 1, "z-index": 100 }
        },
        {
          selector: ".path-edge",
          style: {
            width: 2.5,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8",
            label: "data(relation)",
            "text-background-opacity": 0.7,
            "z-index": 100
          }
        },
        { selector: ":selected", style: { "border-width": 2, "border-color": "#e2e8f0" } },
        { selector: "node:active", style: { "overlay-color": "#38bdf8", "overlay-opacity": 0.12 } }
      ]
    });

    cy.on("select", "node", (event) => handleNodeSelect(event.target.data() as ViewerGraphNode));
    cy.on("unselect", "node", () => handleNodeSelect(null));

    cy.on("mouseover", "edge", (event) => {
      event.target.style("label", event.target.data("relation") ?? "");
      event.target.style("width", 1.8);
      event.target.style("z-index", 999);
    });
    cy.on("mouseout", "edge", (event) => {
      if (!event.target.selected() && !event.target.hasClass("path-edge")) {
        event.target.removeStyle("label");
        event.target.removeStyle("width");
        event.target.removeStyle("z-index");
      }
    });

    cy.on("mouseover", "node", (event) => {
      event.target.style("text-max-width", "200px");
      event.target.style("text-wrap", "wrap");
      event.target.style("z-index", 999);
    });
    cy.on("mouseout", "node", (event) => {
      if (!event.target.selected()) {
        event.target.removeStyle("text-max-width");
        event.target.removeStyle("text-wrap");
        event.target.removeStyle("z-index");
      }
    });

    replaceGraphInstance(cy);
    exposeTestApi(cy);
    return () => {
      clearTestApi(cy, cyRef.current);
      clearGraphInstance(cy);
    };
  }, [communityFilter, edgeStatusFilter, graph, sourceClassFilter, layout, labelMode, tagAllowedNodeIds, cyRef]);

  useEffect(() => {
    applyPathHighlight(pathResult);
  }, [pathResult]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => resizeGraph());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (fitTrigger == null) return;
    cyRef.current?.fit(undefined, 30);
  }, [fitTrigger, cyRef.current?.fit]);

  const handleFit = () => cyRef.current?.fit(undefined, 30);
  const handleReset = () => cyRef.current?.reset();

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar" role="toolbar" aria-label="Graph view controls">
        <div className="canvas-toolbar-group">
          <label htmlFor="layout-select" className="label">
            Layout
          </label>
          <select
            id="layout-select"
            className="input"
            value={layout}
            onChange={(event) => {
              const next = event.target.value as LayoutName;
              setLayout(next);
              onLayoutChange?.(next);
            }}
          >
            {Object.entries(LAYOUT_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="canvas-toolbar-group">
          <label htmlFor="label-mode" className="label">
            Labels
          </label>
          <select
            id="label-mode"
            className="input"
            value={labelMode}
            onChange={(event) => setLabelMode(event.target.value as "auto" | "always" | "never")}
          >
            <option value="auto">Auto</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>
        <div className="canvas-toolbar-group">
          <button type="button" className="btn" onClick={handleFit} title="Fit to viewport (F)">
            Fit
          </button>
          <button type="button" className="btn" onClick={handleReset} title="Reset zoom">
            Reset
          </button>
        </div>
      </div>
      <div className="canvas" data-testid="graph-canvas" ref={containerRef} />
      <GraphLegend />
      <GraphMinimap cyRef={cyRef} />
    </div>
  );
}
