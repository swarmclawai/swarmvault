import { describe, expect, it } from "vitest";
import { buildGraphShareArtifact, renderGraphShareMarkdown, renderGraphShareSvg } from "../src/graph-share.js";
import type { GraphArtifact, GraphNode, GraphPage, GraphReportArtifact, SourceManifest } from "../src/types.js";

function node(input: Partial<GraphNode> & { id: string; label: string; type: GraphNode["type"] }): GraphNode {
  return {
    confidence: 1,
    freshness: "fresh",
    sourceIds: ["alpha"],
    projectIds: [],
    sourceClass: "first_party",
    ...input
  };
}

function page(input: Partial<GraphPage> & { id: string; path: string; title: string; kind: GraphPage["kind"] }): GraphPage {
  return {
    sourceIds: ["alpha"],
    projectIds: [],
    nodeIds: [input.id],
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "schema",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T12:00:00.000Z",
    compiledFrom: ["alpha"],
    managedBy: "system",
    sourceClass: "first_party",
    ...input
  };
}

function manifest(): SourceManifest {
  return {
    sourceId: "alpha",
    title: "Alpha",
    originType: "file",
    sourceKind: "markdown",
    originalPath: "alpha.md",
    storedPath: "raw/sources/alpha.md",
    extractedTextPath: "state/extracts/alpha.md",
    extractedMetadataPath: "state/extracts/alpha.json",
    contentHash: "hash",
    semanticHash: "semantic",
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-20T12:00:00.000Z",
    mimeType: "text/markdown",
    sourceClass: "first_party"
  };
}

function graph(): GraphArtifact {
  return {
    generatedAt: "2026-04-20T12:00:00.000Z",
    nodes: [
      node({ id: "concept:compiler", label: "Knowledge Compiler", type: "concept", degree: 8, pageId: "concept:compiler" }),
      node({ id: "concept:review", label: "Review Loop", type: "concept", degree: 5, bridgeScore: 0.7, pageId: "concept:review" })
    ],
    edges: [
      {
        id: "edge:compiler-review",
        source: "concept:compiler",
        target: "concept:review",
        relation: "supports",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 0.9,
        provenance: ["alpha"]
      }
    ],
    hyperedges: [],
    communities: [{ id: "community:one", label: "Compiler", nodeIds: ["concept:compiler", "concept:review"] }],
    sources: [manifest()],
    pages: [
      page({ id: "concept:compiler", path: "concepts/compiler.md", title: "Knowledge Compiler", kind: "concept" }),
      page({ id: "concept:review", path: "concepts/review.md", title: "Review Loop", kind: "concept" })
    ]
  };
}

function report(): GraphReportArtifact {
  return {
    generatedAt: "2026-04-20T12:00:00.000Z",
    graphHash: "hash",
    overview: { nodes: 2, edges: 1, pages: 2, communities: 1 },
    firstPartyOverview: { nodes: 2, edges: 1, pages: 2, communities: 1 },
    sourceClassBreakdown: {
      first_party: { sources: 1, pages: 2, nodes: 2 },
      third_party: { sources: 0, pages: 0, nodes: 0 },
      resource: { sources: 0, pages: 0, nodes: 0 },
      generated: { sources: 0, pages: 0, nodes: 0 }
    },
    warnings: [],
    godNodes: [{ nodeId: "concept:compiler", label: "Knowledge Compiler", pageId: "concept:compiler", degree: 8 }],
    bridgeNodes: [{ nodeId: "concept:review", label: "Review Loop", pageId: "concept:review", bridgeScore: 0.7 }],
    thinCommunities: [],
    surprisingConnections: [
      {
        id: "surprise:one",
        sourceNodeId: "concept:compiler",
        sourceLabel: "Knowledge Compiler",
        targetNodeId: "concept:review",
        targetLabel: "Review Loop",
        relation: "supports",
        evidenceClass: "extracted",
        confidence: 0.9,
        pathNodeIds: ["concept:compiler", "concept:review"],
        pathEdgeIds: ["edge:compiler-review"],
        pathRelations: ["supports"],
        pathEvidenceClasses: ["extracted"],
        pathSummary: "Knowledge Compiler -> Review Loop",
        why: "The compiler produces artifacts that make review faster.",
        explanation: "A direct extracted edge connects the two concepts."
      }
    ],
    groupPatterns: [],
    suggestedQuestions: ["What changed after the first compile?"],
    communityPages: [],
    recentResearchSources: [],
    contradictions: [],
    knowledgeGaps: {
      isolatedNodes: [],
      thinCommunityCount: 0,
      ambiguousEdgeRatio: 0,
      warnings: []
    }
  };
}

describe("graph share card", () => {
  it("builds a post-ready share artifact from graph report highlights", () => {
    const artifact = buildGraphShareArtifact({ graph: graph(), report: report(), vaultName: "demo-vault" });

    expect(artifact.vaultName).toBe("demo-vault");
    expect(artifact.overview.sources).toBe(1);
    expect(artifact.highlights.topHubs[0]?.label).toBe("Knowledge Compiler");
    expect(artifact.shortPost).toContain("1 sources -> 2 wiki pages");
    expect(artifact.shortPost).toContain("swarmvault scan ./your-repo");
  });

  it("renders markdown with a copyable share post and reproduce commands", () => {
    const artifact = buildGraphShareArtifact({ graph: graph(), report: report(), vaultName: "demo-vault" });
    const markdown = renderGraphShareMarkdown(artifact);

    expect(markdown).toContain("# SwarmVault Share Card");
    expect(markdown).toContain("## Share Post");
    expect(markdown).toContain("swarmvault graph share --post");
  });

  it("renders an escaped visual SVG share card", () => {
    const unsafeGraph = graph();
    unsafeGraph.nodes[0] = {
      ...unsafeGraph.nodes[0]!,
      label: "Knowledge <script>alert(1)</script>"
    };
    const artifact = buildGraphShareArtifact({ graph: unsafeGraph, report: null, vaultName: "demo-vault" });
    const svg = renderGraphShareSvg(artifact);

    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"');
    expect(svg).toContain("<title>SwarmVault share card for demo-vault</title>");
    expect(svg).toContain("Sources");
    expect(svg).toContain("Graph nodes");
    expect(svg).toContain("Knowledge &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(svg).not.toContain("<script>alert(1)</script>");
  });
});
