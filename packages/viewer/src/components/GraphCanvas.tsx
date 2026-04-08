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
        idealEdgeLength: 120,
        nodeRepulsion: 8_000
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
            "font-family": '"IBM Plex Mono", "SF Mono", monospace',
            "font-size": 10
          }
        },
        {
          selector: "node[?isGodNode]",
          style: {
            width: 56,
            height: 56,
            "border-width": 3,
            "border-color": "#fef08a"
          }
        },
        {
          selector: 'node[type = "module"]',
          style: {
            shape: "round-rectangle",
            width: 48,
            height: 30
          }
        },
        {
          selector: 'node[type = "symbol"]',
          style: {
            shape: "diamond",
            width: 28,
            height: 28,
            "font-size": 9
          }
        },
        {
          selector: 'node[type = "rationale"]',
          style: {
            shape: "hexagon",
            width: 34,
            height: 34
          }
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#475569",
            "target-arrow-shape": "triangle",
            "target-arrow-color": "#475569",
            "curve-style": "bezier",
            label: "data(relation)",
            "font-size": 8,
            color: "#64748b"
          }
        },
        {
          selector: ".similarity-edge",
          style: {
            "line-style": "dashed",
            "line-color": "#f97316",
            "target-arrow-color": "#f97316"
          }
        },
        {
          selector: ".path-node",
          style: {
            "border-width": 4,
            "border-color": "#38bdf8"
          }
        },
        {
          selector: ".path-edge",
          style: {
            width: 3,
            "line-color": "#38bdf8",
            "target-arrow-color": "#38bdf8"
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
      handleNodeSelect(event.target.data() as ViewerGraphNode);
    });
    cy.on("unselect", "node", () => {
      handleNodeSelect(null);
    });

    replaceGraphInstance(cy);
    return () => clearGraphInstance(cy);
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

  return <div className="canvas" ref={containerRef} />;
}
