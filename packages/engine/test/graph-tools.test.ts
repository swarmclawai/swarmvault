import { describe, expect, it } from "vitest";
import { shortestGraphPath } from "../src/graph-tools.js";
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
