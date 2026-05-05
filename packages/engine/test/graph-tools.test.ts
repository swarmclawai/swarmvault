import { describe, expect, it } from "vitest";
import { graphStats, queryGraph, shortestGraphPath, validateGraphArtifact } from "../src/graph-tools.js";
import type { GraphArtifact } from "../src/types.js";

function nodeId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

/**
 * Builds a tiny graph where the label "auth" is ambiguous between a
 * well-connected concept hub and a leaf code source. The leaf source has
 * nothing but a single outgoing edge to its module. The concept sits between
 * two sources ("briefing" and "intro") so it is the only path that connects
 * either source to the other through the concept hub.
 *
 * Historically `graph path "auth" "briefing"` picked the leaf source first
 * and returned "No path found". The disambiguator should prefer the concept
 * hub because it has higher degree and higher node-type priority.
 */
function buildAmbiguousGraph(): GraphArtifact {
  const nodes = [
    {
      id: nodeId("concept", "auth"),
      type: "concept" as const,
      label: "auth",
      sourceIds: [],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 2,
      bridgeScore: 0.6
    },
    {
      id: nodeId("source", "auth-code"),
      type: "source" as const,
      label: "auth",
      pageId: nodeId("source", "auth-code"),
      sourceIds: ["auth-code"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.1
    },
    {
      id: nodeId("module", "auth-code"),
      type: "module" as const,
      label: "auth module",
      pageId: nodeId("module", "auth-code"),
      sourceIds: ["auth-code"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.1
    },
    {
      id: nodeId("source", "briefing"),
      type: "source" as const,
      label: "briefing",
      pageId: nodeId("source", "briefing"),
      sourceIds: ["briefing"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.2
    },
    {
      id: nodeId("source", "intro"),
      type: "source" as const,
      label: "intro",
      pageId: nodeId("source", "intro"),
      sourceIds: ["intro"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.2
    }
  ];

  const edges = [
    {
      id: "auth-code->module",
      source: nodeId("source", "auth-code"),
      target: nodeId("module", "auth-code"),
      relation: "contains_code",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 1,
      provenance: ["test"]
    },
    {
      id: "briefing->concept:auth",
      source: nodeId("source", "briefing"),
      target: nodeId("concept", "auth"),
      relation: "mentions",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 1,
      provenance: ["test"]
    },
    {
      id: "intro->concept:auth",
      source: nodeId("source", "intro"),
      target: nodeId("concept", "auth"),
      relation: "mentions",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 1,
      provenance: ["test"]
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    hyperedges: [],
    communities: [],
    sources: [],
    pages: []
  };
}

function buildValidatedGraph(): GraphArtifact {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  return {
    generatedAt: now,
    nodes: [
      {
        id: "source:notes",
        type: "source",
        label: "notes",
        pageId: "page:notes",
        sourceIds: [],
        projectIds: [],
        confidence: 1
      },
      {
        id: "concept:durable-outputs",
        type: "concept",
        label: "Durable Outputs",
        pageId: "page:durable-outputs",
        sourceIds: [],
        projectIds: [],
        confidence: 0.9
      }
    ],
    edges: [
      {
        id: "source:notes->concept:durable-outputs:mentions",
        source: "source:notes",
        target: "concept:durable-outputs",
        relation: "mentions",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 0.8,
        provenance: ["page:notes"]
      }
    ],
    hyperedges: [
      {
        id: "pattern:durable-output-flow",
        label: "Durable output flow",
        relation: "participate_in",
        nodeIds: ["source:notes", "concept:durable-outputs"],
        evidenceClass: "extracted",
        confidence: 0.7,
        sourcePageIds: ["page:notes"],
        why: "The source describes durable outputs."
      }
    ],
    communities: [
      {
        id: "community:durable-output",
        label: "Durable output",
        nodeIds: ["source:notes", "concept:durable-outputs"]
      }
    ],
    sources: [],
    pages: [
      {
        id: "page:notes",
        path: "sources/notes.md",
        title: "notes",
        kind: "source",
        sourceIds: [],
        projectIds: [],
        nodeIds: ["source:notes"],
        freshness: "fresh",
        status: "active",
        confidence: 1,
        backlinks: [],
        schemaHash: "schema",
        sourceHashes: {},
        sourceSemanticHashes: {},
        relatedPageIds: ["page:durable-outputs"],
        relatedNodeIds: ["concept:durable-outputs"],
        relatedSourceIds: [],
        createdAt: now,
        updatedAt: now,
        compiledFrom: [],
        managedBy: "system"
      },
      {
        id: "page:durable-outputs",
        path: "concepts/durable-outputs.md",
        title: "Durable Outputs",
        kind: "concept",
        sourceIds: [],
        projectIds: [],
        nodeIds: ["concept:durable-outputs"],
        freshness: "fresh",
        status: "active",
        confidence: 0.9,
        backlinks: [],
        schemaHash: "schema",
        sourceHashes: {},
        sourceSemanticHashes: {},
        relatedPageIds: ["page:notes"],
        relatedNodeIds: ["source:notes"],
        relatedSourceIds: [],
        createdAt: now,
        updatedAt: now,
        compiledFrom: [],
        managedBy: "system"
      }
    ]
  };
}

describe("shortestGraphPath", () => {
  it("prefers high-degree concept hubs over leaf sources when resolving ambiguous labels", () => {
    const graph = buildAmbiguousGraph();
    const result = shortestGraphPath(graph, "auth", "briefing");

    expect(result.resolvedFromNodeId).toBe("concept:auth");
    expect(result.resolvedToNodeId).toBe("source:briefing");
    expect(result.found).toBe(true);
    expect(result.nodeIds).toEqual(["concept:auth", "source:briefing"]);
  });

  it("still resolves explicit node ids without disambiguation", () => {
    const graph = buildAmbiguousGraph();
    const result = shortestGraphPath(graph, "source:auth-code", "module:auth-code");

    expect(result.resolvedFromNodeId).toBe("source:auth-code");
    expect(result.resolvedToNodeId).toBe("module:auth-code");
    expect(result.found).toBe(true);
  });

  it("reports no path between genuinely disconnected nodes", () => {
    const graph = buildAmbiguousGraph();
    const result = shortestGraphPath(graph, "source:auth-code", "source:briefing");

    expect(result.found).toBe(false);
    expect(result.nodeIds).toEqual([]);
  });
});

describe("graphStats and validateGraphArtifact", () => {
  it("summarizes graph counts and relation evidence", () => {
    const stats = graphStats(buildValidatedGraph());

    expect(stats.counts).toMatchObject({
      nodes: 2,
      edges: 1,
      hyperedges: 1,
      pages: 2,
      communities: 1
    });
    expect(stats.nodeTypes.concept).toBe(1);
    expect(stats.edgeRelations.mentions).toBe(1);
    expect(stats.hyperedgeRelations.participate_in).toBe(1);
    expect(stats.evidenceClasses.extracted).toBe(2);
  });

  it("validates intact graph artifacts without warnings", () => {
    const result = validateGraphArtifact(buildValidatedGraph());

    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.summary).toContain("Graph valid");
  });

  it("reports dangling references, duplicate ids, and invalid confidence", () => {
    const graph = buildValidatedGraph();
    graph.nodes.push({ ...graph.nodes[0], label: "duplicate notes" });
    graph.edges[0] = {
      ...graph.edges[0],
      target: "concept:missing",
      confidence: 1.2
    };
    graph.pages[0] = {
      ...graph.pages[0],
      relatedNodeIds: ["node:missing-related"]
    };

    const result = validateGraphArtifact(graph, { strict: true });

    expect(result.ok).toBe(false);
    expect(result.errorCount).toBeGreaterThanOrEqual(2);
    expect(result.warningCount).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["duplicate_id", "dangling_edge_node", "invalid_confidence", "dangling_related_node"])
    );
  });
});

describe("queryGraph filters", () => {
  it("filters traversal by relation groups, evidence classes, node types, and languages", () => {
    const graph = buildAmbiguousGraph();
    graph.nodes.push(
      {
        id: "symbol:loader",
        type: "symbol",
        label: "loadMath",
        pageId: "module:loader",
        sourceIds: ["loader"],
        projectIds: [],
        sourceClass: "first_party",
        language: "typescript",
        degree: 1,
        bridgeScore: 0.2
      },
      {
        id: "symbol:add",
        type: "symbol",
        label: "add",
        pageId: "module:math",
        sourceIds: ["math"],
        projectIds: [],
        sourceClass: "first_party",
        language: "typescript",
        degree: 1,
        bridgeScore: 0.2
      }
    );
    graph.edges.push(
      {
        id: "loader->add:calls",
        source: "symbol:loader",
        target: "symbol:add",
        relation: "calls",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 1,
        provenance: ["test"]
      },
      {
        id: "loader->math:imports",
        source: "symbol:loader",
        target: "module:auth-code",
        relation: "imports",
        status: "inferred",
        evidenceClass: "inferred",
        confidence: 0.6,
        provenance: ["test"]
      }
    );

    const result = queryGraph(graph, "loadMath", [], {
      filters: {
        relationGroups: ["calls"],
        evidenceClasses: ["extracted"],
        nodeTypes: ["symbol"],
        languages: ["typescript"]
      }
    });

    expect(result.visitedEdgeIds).toEqual(["loader->add:calls"]);
    expect(result.filterStats?.expandedRelations).toEqual(["calls"]);
    expect(result.filterStats?.droppedEdges).toBeGreaterThan(0);
    expect(result.summary).toContain("Filters:");
    expect(result.summary).toContain("context=calls");
  });
});
