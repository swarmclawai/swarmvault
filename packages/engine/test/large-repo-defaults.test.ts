import { describe, expect, it } from "vitest";
import { enrichGraph } from "../src/graph-enrichment.js";
import { resolveLargeRepoDefaults } from "../src/large-repo-defaults.js";
import { buildGraphReportArtifact } from "../src/markdown.js";
import type { GraphArtifact, GraphNode, SourceAnalysis, SourceManifest } from "../src/types.js";

/**
 * Builds a minimal pair of source nodes and their matching manifests and
 * analyses, sharing the concept list supplied. The helper keeps the node
 * and manifest shape aligned with what the ingestion pipeline would have
 * produced so {@link enrichGraph} treats them as real candidates for
 * similarity edges.
 */
function buildSimilarityFixture(input: { sharedConcepts: string[]; extraConceptsByNode?: Record<string, string[]>; extraNodes?: number }): {
  nodes: GraphNode[];
  manifests: SourceManifest[];
  analyses: SourceAnalysis[];
} {
  const now = new Date().toISOString();
  const ids = ["left", "right", ...Array.from({ length: input.extraNodes ?? 0 }, (_, index) => `extra-${index}`)];
  const nodes: GraphNode[] = ids.map((id) => ({
    id: `source:${id}`,
    type: "source",
    label: `Source ${id}`,
    pageId: `source:${id}`,
    sourceIds: [id],
    projectIds: [],
    sourceClass: "first_party"
  }));
  const manifests: SourceManifest[] = ids.map((id) => ({
    sourceId: id,
    title: `Source ${id}`,
    originType: "file",
    sourceKind: "markdown",
    sourceType: "article",
    sourceClass: "first_party",
    originalPath: `${id}.md`,
    storedPath: `${id}.md`,
    extractionHash: id,
    mimeType: "text/markdown",
    contentHash: id,
    semanticHash: id,
    createdAt: now,
    updatedAt: now
  }));
  const analyses: SourceAnalysis[] = ids.map((id) => {
    const extras = input.extraConceptsByNode?.[id] ?? [];
    const concepts = [...input.sharedConcepts, ...extras].map((name) => ({
      id: `concept:${id}:${name}`,
      name,
      description: name
    }));
    return {
      analysisVersion: 1,
      sourceId: id,
      sourceHash: id,
      semanticHash: id,
      extractionHash: id,
      schemaHash: id,
      title: `Source ${id}`,
      summary: `Summary for ${id}`,
      concepts,
      entities: [],
      claims: [],
      questions: [],
      tags: [],
      rationales: [],
      producedAt: now
    };
  });
  return { nodes, manifests, analyses };
}

describe("resolveLargeRepoDefaults", () => {
  it("returns godNodeLimit 20 for small repos (nodeCount=100)", () => {
    const defaults = resolveLargeRepoDefaults({ nodeCount: 100 });
    expect(defaults.godNodeLimit).toBe(20);
  });

  it("returns godNodeLimit 10 for large repos (nodeCount=5000)", () => {
    const defaults = resolveLargeRepoDefaults({ nodeCount: 5000 });
    expect(defaults.godNodeLimit).toBe(10);
  });

  it("returns the user-configured godNodeLimit regardless of nodeCount", () => {
    const userSmall = resolveLargeRepoDefaults({
      nodeCount: 100,
      config: { graph: { godNodeLimit: 7 } } as never
    });
    expect(userSmall.godNodeLimit).toBe(7);

    const userLarge = resolveLargeRepoDefaults({
      nodeCount: 5000,
      config: { graph: { godNodeLimit: 7 } } as never
    });
    expect(userLarge.godNodeLimit).toBe(7);
  });

  it("grows the similarity edge cap linearly up to 20000", () => {
    expect(resolveLargeRepoDefaults({ nodeCount: 10 }).similarityEdgeCap).toBe(50);
    expect(resolveLargeRepoDefaults({ nodeCount: 1000 }).similarityEdgeCap).toBe(5000);
    expect(resolveLargeRepoDefaults({ nodeCount: 4000 }).similarityEdgeCap).toBe(20000);
    expect(resolveLargeRepoDefaults({ nodeCount: 100000 }).similarityEdgeCap).toBe(20000);
  });

  it("derives foldCommunitiesBelow as max(3, ceil(totalCommunities / 50))", () => {
    expect(resolveLargeRepoDefaults({ nodeCount: 100, totalCommunities: 10 }).foldCommunitiesBelow).toBe(3);
    expect(resolveLargeRepoDefaults({ nodeCount: 5000, totalCommunities: 300 }).foldCommunitiesBelow).toBe(6);
  });

  it("respects user-configured similarityIdfFloor and foldCommunitiesBelow", () => {
    const resolved = resolveLargeRepoDefaults({
      nodeCount: 100,
      totalCommunities: 300,
      config: {
        graph: {
          similarityIdfFloor: 1.5,
          foldCommunitiesBelow: 42
        }
      } as never
    });
    expect(resolved.similarityIdfFloor).toBe(1.5);
    expect(resolved.foldCommunitiesBelow).toBe(42);
  });
});

describe("similarity IDF weighting", () => {
  it("lets a rare shared concept contribute more than a generic one", () => {
    // Corpus: left and right share the generic concept "javascript" along
    // with everyone else, and *only* they share the rare concept
    // "quaternion-math". The rare concept must dominate the score so that
    // the edge between left and right still clears the 0.5 threshold.
    const genericFixture = buildSimilarityFixture({
      sharedConcepts: ["javascript"],
      extraNodes: 8
    });
    const genericEnriched = enrichGraph(
      {
        generatedAt: new Date().toISOString(),
        nodes: genericFixture.nodes,
        edges: [],
        communities: [],
        sources: genericFixture.manifests,
        pages: []
      },
      genericFixture.manifests,
      genericFixture.analyses
    );
    const genericLeftRight = genericEnriched.edges.find(
      (edge) =>
        edge.relation === "semantically_similar_to" &&
        (edge.source === "source:left" || edge.target === "source:left") &&
        (edge.source === "source:right" || edge.target === "source:right")
    );

    const rareFixture = buildSimilarityFixture({
      sharedConcepts: [],
      extraConceptsByNode: {
        left: ["quaternion-math"],
        right: ["quaternion-math"]
      },
      extraNodes: 8
    });
    // Give the extra nodes a different generic concept so the graph still
    // builds document frequencies across the full context set.
    for (let index = 0; index < rareFixture.analyses.length - 2; index++) {
      const analysis = rareFixture.analyses[index + 2];
      analysis.concepts = [{ id: `concept:filler-${index}`, name: "javascript", description: "javascript" }];
    }
    const rareEnriched = enrichGraph(
      {
        generatedAt: new Date().toISOString(),
        nodes: rareFixture.nodes,
        edges: [],
        communities: [],
        sources: rareFixture.manifests,
        pages: []
      },
      rareFixture.manifests,
      rareFixture.analyses
    );
    const rareLeftRight = rareEnriched.edges.find(
      (edge) =>
        edge.relation === "semantically_similar_to" &&
        (edge.source === "source:left" || edge.target === "source:left") &&
        (edge.source === "source:right" || edge.target === "source:right")
    );

    // The rare shared concept must produce a strong edge.
    expect(rareLeftRight).toBeDefined();
    if (rareLeftRight && genericLeftRight) {
      expect(rareLeftRight.confidence).toBeGreaterThan(genericLeftRight.confidence);
    } else {
      // When the generic-only overlap fails to produce an edge at all, the
      // rare-concept fixture must still emit one — which is even stronger
      // evidence that IDF weighting is active.
      expect(rareLeftRight).toBeDefined();
    }
  });

  it("drops features below the configured similarityIdfFloor", () => {
    // Every node shares the same concept so its IDF is 1.0 with the
    // default floor (0.5). Raising the floor above 1.0 must drop that
    // feature entirely and suppress the edge.
    const fixture = buildSimilarityFixture({
      sharedConcepts: ["ubiquitous"],
      extraNodes: 4
    });
    const enrichedWithHighFloor = enrichGraph(
      {
        generatedAt: new Date().toISOString(),
        nodes: fixture.nodes,
        edges: [],
        communities: [],
        sources: fixture.manifests,
        pages: []
      },
      fixture.manifests,
      fixture.analyses,
      [],
      { similarityIdfFloor: 10 }
    );
    const similarityEdges = enrichedWithHighFloor.edges.filter((edge) => edge.relation === "semantically_similar_to");
    expect(similarityEdges.length).toBe(0);
  });
});

describe("god-node surprise reason", () => {
  function buildGodNodeGraph(): GraphArtifact {
    const nodeIds = Array.from({ length: 12 }, (_, index) => `concept:${index}`);
    const nodes: GraphNode[] = nodeIds.map((id, index) => ({
      id,
      type: "concept",
      label: `Concept ${index}`,
      sourceIds: [`source-${index}`],
      projectIds: [],
      sourceClass: "first_party",
      communityId: index < 6 ? "community-a" : "community-b",
      degree: index === 0 ? 11 : 1,
      bridgeScore: index === 0 ? 1 : 0,
      isGodNode: index === 0,
      surpriseReason: index === 0 ? "degree 11, across 2 communities" : undefined
    }));
    const edges = nodeIds.slice(1).map((target, index) => ({
      id: `edge-${index}`,
      source: "concept:0",
      target,
      relation: "mentions",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 0.9,
      provenance: [`source-${index}`]
    }));
    return {
      generatedAt: new Date().toISOString(),
      nodes,
      edges,
      hyperedges: [],
      communities: [
        { id: "community-a", label: "A", nodeIds: nodeIds.slice(0, 6) },
        { id: "community-b", label: "B", nodeIds: nodeIds.slice(6) }
      ],
      sources: [],
      pages: []
    };
  }

  it("populates surpriseReason on god-node report entries and is deterministic", () => {
    const graph = buildGodNodeGraph();
    const report1 = buildGraphReportArtifact({
      graph,
      communityPages: [],
      graphHash: "hash"
    });
    const report2 = buildGraphReportArtifact({
      graph,
      communityPages: [],
      graphHash: "hash"
    });

    expect(report1.godNodes.length).toBeGreaterThan(0);
    for (const entry of report1.godNodes) {
      expect(entry.surpriseReason).toBeTruthy();
      expect(entry.surpriseReason).toMatch(/degree \d+/);
    }
    // Same graph must produce byte-identical surpriseReason strings.
    expect(report1.godNodes.map((entry) => entry.surpriseReason)).toEqual(report2.godNodes.map((entry) => entry.surpriseReason));
  });
});
