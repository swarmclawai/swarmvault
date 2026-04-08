import cytoscape from "cytoscape";
import { useEffect, useEffectEvent, useRef } from "react";
import type { Core, ViewerGraphArtifact, ViewerGraphNode, ViewerGraphPathResult } from "./types";

const COLORS: Record<string, string> = {
  source: "#f59e0b",
  module: "#fb7185",
  symbol: "#8b5cf6",
  rationale: "#14b8a6",
  concept: "#0ea5e9",
  entity: "#22c55e"
};

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

type GraphCanvasProps = {
  graph: ViewerGraphArtifact | null;
  edgeStatusFilter: string;
  communityFilter: string;
  sourceClassFilter: string;
  pathResult: ViewerGraphPathResult | null;
  onNodeSelect: (node: ViewerGraphNode | null) => void;
  cyRef: React.MutableRefObject<Core | null>;
};

export function GraphCanvas({
  graph,
  edgeStatusFilter,
  communityFilter,
  sourceClassFilter,
  pathResult,
  onNodeSelect,
  cyRef
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
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
      for (const nodeId of nextPathResult.nodeIds) {
        cy.getElementById(nodeId).addClass("path-node");
      }
      for (const edgeId of nextPathResult.edgeIds) {
        cy.getElementById(edgeId).addClass("path-edge");
      }
    }
  });
  const exposeTestApi = useEffectEvent((cy: Core) => {
    if (typeof window === "undefined") {
      return;
    }

    window.__SWARMVAULT_TEST__ = {
      getNodeIds: () => cy.nodes().map((node) => node.id()),
      getConnectedNodePair: () => {
        const edge = cy.edges()[0];
        if (!edge || edge.empty()) {
          return null;
        }
        return {
          from: edge.source().id(),
          to: edge.target().id()
        };
      },
      getRenderedNodePosition: (nodeId: string) => {
        const node = cy.getElementById(nodeId);
        if (!node || node.empty()) {
          return null;
        }
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
  });
  const clearTestApi = useEffectEvent((currentGraph: Core) => {
    if (typeof window !== "undefined" && window.__SWARMVAULT_TEST__) {
      if (cyRef.current === currentGraph) {
        delete window.__SWARMVAULT_TEST__;
      }
    }
  });
  const resizeGraph = useEffectEvent(() => {
    cyRef.current?.resize();
  });

  useEffect(() => {
    if (!containerRef.current || !graph) return;

    const allowedNodeIds = new Set(
      graph.nodes
        .filter((node) => communityFilter === "all" || node.communityId === communityFilter)
        .filter((node) => sourceClassFilter === "all" || (node.sourceClass ?? "") === sourceClassFilter)
        .map((node) => node.id)
    );

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
            classes: edge.relation === "semantically_similar_to" ? "similarity-edge" : ""
          }))
      ],
      layout: {
        name: "cose",
        animate: false,
        idealEdgeLength: 280,
        nodeRepulsion: 120_000,
        nodeOverlap: 60,
        gravity: 0.08,
        nestingFactor: 1.2,
        edgeElasticity: 100,
        numIter: 3000
      },
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "background-color": "data(color)",
            "background-opacity": 0.85,
            color: "#f1f5f9",
            "font-family": '"Inter", "Segoe UI", system-ui, sans-serif',
            "font-size": 11,
            "font-weight": "normal",
            "text-halign": "center",
            "text-valign": "bottom",
            "text-margin-y": 7,
            "text-max-width": "100px",
            "text-wrap": "ellipsis",
            "min-zoomed-font-size": 10,
            "text-background-opacity": 0.55,
            "text-background-color": "#020617",
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
            "border-color": "rgba(254, 240, 138, 0.35)",
            "border-opacity": 1,
            "background-opacity": 1,
            "font-size": 12,
            "font-weight": "bold",
            "text-max-width": "140px",
            "z-index": 12
          }
        },
        {
          selector: 'node[type = "module"]',
          style: {
            shape: "round-rectangle",
            width: 44,
            height: 28,
            "font-size": 11,
            "text-max-width": "120px",
            "background-opacity": 0.88,
            "z-index": 8
          }
        },
        {
          selector: 'node[type = "symbol"]',
          style: {
            shape: "diamond",
            width: 20,
            height: 20,
            "font-size": 9,
            "text-max-width": "70px",
            "background-opacity": 0.6,
            "z-index": 3
          }
        },
        {
          selector: 'node[type = "rationale"]',
          style: {
            shape: "hexagon",
            width: 28,
            height: 28,
            "background-opacity": 0.75,
            "z-index": 6
          }
        },
        {
          selector: 'node[type = "source"]',
          style: {
            shape: "ellipse",
            width: 32,
            height: 32,
            "background-opacity": 0.95,
            "z-index": 10
          }
        },
        {
          selector: 'node[type = "concept"]',
          style: {
            shape: "round-rectangle",
            width: 34,
            height: 22,
            "background-opacity": 0.7,
            "z-index": 5
          }
        },
        {
          selector: 'node[type = "entity"]',
          style: {
            shape: "ellipse",
            width: 26,
            height: 26,
            "background-opacity": 0.7,
            "z-index": 5
          }
        },
        {
          selector: "edge",
          style: {
            width: 0.8,
            "line-color": "rgba(71, 85, 105, 0.35)",
            "target-arrow-shape": "triangle-backcurve",
            "target-arrow-color": "rgba(71, 85, 105, 0.35)",
            "arrow-scale": 0.6,
            "curve-style": "bezier",
            label: "",
            "font-size": 8,
            color: "rgba(148, 163, 184, 0.8)",
            "text-background-opacity": 0,
            "text-background-color": "#020617",
            "text-background-padding": "2px",
            "text-background-shape": "roundrectangle",
            "text-rotation": "autorotate",
            "text-margin-y": -8
          }
        },
        {
          selector: "edge:selected",
          style: {
            label: "data(relation)",
            width: 2,
            "line-color": "#94a3b8",
            "target-arrow-color": "#94a3b8",
            "text-background-opacity": 0.7
          }
        },
        {
          selector: ".similarity-edge",
          style: {
            "line-style": "dashed",
            "line-color": "rgba(249, 115, 22, 0.4)",
            "target-arrow-color": "rgba(249, 115, 22, 0.4)",
            "line-dash-pattern": [6, 4]
          }
        },
        {
          selector: ".path-node",
          style: {
            "border-width": 3,
            "border-color": "#38bdf8",
            "background-opacity": 1,
            "z-index": 100
          }
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
        {
          selector: ":selected",
          style: {
            "border-width": 2,
            "border-color": "#e2e8f0"
          }
        },
        {
          selector: "node:active",
          style: {
            "overlay-color": "#38bdf8",
            "overlay-opacity": 0.12
          }
        }
      ]
    });

    cy.on("select", "node", (event) => {
      handleNodeSelect(event.target.data() as ViewerGraphNode);
    });
    cy.on("unselect", "node", () => {
      handleNodeSelect(null);
    });

    // Show edge labels on hover with background pill
    cy.on("mouseover", "edge", (event) => {
      event.target.style("label", event.target.data("relation") ?? "");
      event.target.style("width", 1.8);
      event.target.style("line-color", "rgba(148, 163, 184, 0.7)");
      event.target.style("target-arrow-color", "rgba(148, 163, 184, 0.7)");
      event.target.style("text-background-opacity", 0.7);
      event.target.style("z-index", 999);
    });
    cy.on("mouseout", "edge", (event) => {
      if (!event.target.selected() && !event.target.hasClass("path-edge")) {
        event.target.removeStyle("label");
        event.target.removeStyle("width");
        event.target.removeStyle("line-color");
        event.target.removeStyle("target-arrow-color");
        event.target.removeStyle("text-background-opacity");
        event.target.removeStyle("z-index");
      }
    });

    // Expand label and highlight connected edges on node hover
    cy.on("mouseover", "node", (event) => {
      event.target.style("text-max-width", "200px");
      event.target.style("text-wrap", "wrap");
      event.target.style("z-index", 999);
      const connectedEdges = event.target.connectedEdges();
      connectedEdges.style("line-color", "rgba(148, 163, 184, 0.6)");
      connectedEdges.style("target-arrow-color", "rgba(148, 163, 184, 0.6)");
      connectedEdges.style("width", 1.3);
    });
    cy.on("mouseout", "node", (event) => {
      if (!event.target.selected()) {
        event.target.removeStyle("text-max-width");
        event.target.removeStyle("text-wrap");
        event.target.removeStyle("z-index");
      }
      const connectedEdges = event.target.connectedEdges();
      connectedEdges.forEach((edge: cytoscape.EdgeSingular) => {
        if (!edge.selected() && !edge.hasClass("path-edge")) {
          edge.removeStyle("line-color");
          edge.removeStyle("target-arrow-color");
          edge.removeStyle("width");
        }
      });
    });

    replaceGraphInstance(cy);
    exposeTestApi(cy);
    return () => {
      clearTestApi(cy);
      clearGraphInstance(cy);
    };
  }, [communityFilter, edgeStatusFilter, graph, sourceClassFilter]);

  useEffect(() => {
    applyPathHighlight(pathResult);
  }, [pathResult]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      resizeGraph();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return <div className="canvas" data-testid="graph-canvas" ref={containerRef} />;
}
