import { describe, expect, it } from "vitest";
import { buildViewerGraphArtifact } from "../src/graph-presentation.js";
import type { GraphArtifact, GraphReportArtifact } from "../src/types.js";

function largeGraph(): GraphArtifact {
  const nodes = Array.from({ length: 5_100 }, (_, index) => ({
    id: `node-${index}`,
    type: "concept" as const,
    label: `Node ${index}`,
    sourceIds: [`source-${index}`],
    projectIds: [],
    sourceClass: index < 4_200 ? ("first_party" as const) : ("third_party" as const),
    communityId: index < 4_200 ? "community-core" : "community-external",
    degree: index === 0 ? 5_099 : index >= 4_200 ? 2 : 1,
    bridgeScore: index === 4_250 ? 0.95 : 0.1
  }));

  const edges = Array.from({ length: 5_099 }, (_, index) => ({
    id: `edge-${index + 1}`,
    source: "node-0",
    target: `node-${index + 1}`,
    relation: "mentions",
    status: "extracted" as const,
    evidenceClass: "extracted" as const,
    confidence: 0.8,
    provenance: ["test"]
  }));

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    hyperedges: [
      {
        id: "group-1",
        label: "Pinned cluster",
        relation: "form",
        nodeIds: ["node-0", "node-4250", "node-5099"],
        evidenceClass: "extracted",
        confidence: 0.8,
        sourcePageIds: [],
        why: "Pinned nodes should survive overview mode."
      }
    ],
    communities: [
      {
        id: "community-core",
        label: "Core",
        nodeIds: nodes.slice(0, 4_200).map((node) => node.id)
      },
      {
        id: "community-external",
        label: "External",
        nodeIds: nodes.slice(4_200).map((node) => node.id)
      }
    ],
    sources: [],
    pages: []
  };
}

function largeGraphReport(): GraphReportArtifact {
  return {
    generatedAt: new Date().toISOString(),
    graphHash: "hash",
    overview: {
      nodes: 5_100,
      edges: 5_099,
      pages: 0,
      communities: 2
    },
    firstPartyOverview: {
      nodes: 4_200,
      edges: 4_199,
      pages: 0,
      communities: 1
    },
    sourceClassBreakdown: {
      first_party: { sources: 0, pages: 0, nodes: 4_200 },
      third_party: { sources: 0, pages: 0, nodes: 900 },
      resource: { sources: 0, pages: 0, nodes: 0 },
      generated: { sources: 0, pages: 0, nodes: 0 }
    },
    warnings: [],
    godNodes: [{ nodeId: "node-0", label: "Node 0", degree: 5_099, bridgeScore: 0.9 }],
    bridgeNodes: [{ nodeId: "node-4250", label: "Node 4250", degree: 2, bridgeScore: 0.95 }],
    thinCommunities: [],
    surprisingConnections: [
      {
        id: "surprise-1",
        sourceNodeId: "node-4250",
        sourceLabel: "Node 4250",
        targetNodeId: "node-5099",
        targetLabel: "Node 5099",
        relation: "mentions",
        evidenceClass: "extracted",
        confidence: 0.8,
        pathNodeIds: ["node-4250", "node-0", "node-5099"],
        pathEdgeIds: ["edge-4250", "edge-5099"],
        pathRelations: ["mentions", "mentions"],
        pathEvidenceClasses: ["extracted", "extracted"],
        pathSummary: "Node 4250 reaches Node 5099 through Node 0.",
        why: "Pinned endpoints should remain visible.",
        explanation: "Overview mode should preserve the report's most interesting endpoints."
      }
    ],
    groupPatterns: [],
    suggestedQuestions: [],
    communityPages: [],
    recentResearchSources: [],
    contradictions: []
  };
}

describe("buildViewerGraphArtifact", () => {
  it("samples very large graphs into overview mode while keeping pinned report nodes", () => {
    const graph = largeGraph();
    const artifact = buildViewerGraphArtifact(graph, { report: largeGraphReport() });

    expect(artifact.presentation.mode).toBe("overview");
    expect(artifact.presentation.totalNodes).toBe(5_100);
    expect(artifact.nodes.length).toBeLessThanOrEqual(1_500);
    expect(artifact.nodes.some((node) => node.id === "node-0")).toBe(true);
    expect(artifact.nodes.some((node) => node.id === "node-4250")).toBe(true);
    expect(artifact.nodes.some((node) => node.id === "node-5099")).toBe(true);
    expect(artifact.edges.some((edge) => edge.source === "node-0" && edge.target === "node-5099")).toBe(true);
    expect(artifact.hyperedges.some((hyperedge) => hyperedge.id === "group-1")).toBe(true);
  });

  it("returns the full graph when overview sampling is disabled", () => {
    const graph = largeGraph();
    const artifact = buildViewerGraphArtifact(graph, { report: largeGraphReport(), full: true });

    expect(artifact.presentation.mode).toBe("full");
    expect(artifact.nodes.length).toBe(graph.nodes.length);
    expect(artifact.edges.length).toBe(graph.edges.length);
    expect(artifact.communities?.length).toBe(graph.communities?.length);
  });
});
