import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportGraphTree, initVault, mergeGraphFiles } from "../src/index.js";
import type { GraphArtifact, GraphNode, GraphPage } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-graph-tree-merge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeNode(overrides: Partial<GraphNode> & { id: string; type: GraphNode["type"]; label: string }): GraphNode {
  return {
    freshness: "fresh",
    confidence: 1,
    sourceIds: [],
    projectIds: [],
    sourceClass: "first_party",
    ...overrides
  };
}

function makePage(overrides: Partial<GraphPage> & { id: string; path: string; title: string }): GraphPage {
  return {
    kind: "source",
    sourceClass: "first_party",
    sourceIds: [],
    projectIds: [],
    nodeIds: [],
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "abc",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: "2026-05-04T12:00:00.000Z",
    updatedAt: "2026-05-04T12:00:00.000Z",
    compiledFrom: [],
    managedBy: "system",
    ...overrides
  };
}

function sampleGraph(): GraphArtifact {
  return {
    generatedAt: "2026-05-04T12:00:00.000Z",
    nodes: [
      makeNode({ id: "source:app", type: "source", label: "App source", sourceIds: ["source:app"] }),
      makeNode({ id: "module:source:app", type: "module", label: "src/app.ts", sourceIds: ["source:app"], language: "typescript" }),
      makeNode({
        id: "symbol:source:app:start",
        type: "symbol",
        label: "start",
        sourceIds: ["source:app"],
        language: "typescript",
        moduleId: "module:source:app",
        symbolKind: "function"
      })
    ],
    edges: [
      {
        id: "edge:start-app",
        source: "module:source:app",
        target: "symbol:source:app:start",
        relation: "defines",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 1,
        provenance: ["source:app"]
      }
    ],
    hyperedges: [],
    communities: [{ id: "community:app", label: "App", nodeIds: ["module:source:app", "symbol:source:app:start"] }],
    sources: [
      {
        sourceId: "source:app",
        title: "app.ts",
        originType: "file",
        sourceKind: "code",
        language: "typescript",
        repoRelativePath: "src/app.ts",
        originalPath: "src/app.ts",
        storedPath: "raw/sources/app.ts",
        contentHash: "hash:app",
        semanticHash: "semantic:app",
        createdAt: "2026-05-04T12:00:00.000Z",
        updatedAt: "2026-05-04T12:00:00.000Z",
        mimeType: "text/typescript",
        sourceClass: "first_party"
      }
    ],
    pages: [
      makePage({
        id: "source:app",
        path: "sources/app.md",
        title: "App source",
        sourceIds: ["source:app"],
        nodeIds: ["source:app", "module:source:app", "symbol:source:app:start"]
      })
    ]
  };
}

async function writeGraph(rootDir: string, graph: GraphArtifact): Promise<void> {
  await fs.writeFile(path.join(rootDir, "state", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

describe("graph tree export", () => {
  it("writes a collapsible tree grouped by source path, module, and symbol", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writeGraph(rootDir, sampleGraph());

    const result = await exportGraphTree(rootDir, undefined, { label: "Code Tree" });
    const html = await fs.readFile(result.outputPath, "utf8");

    expect(result.sourceCount).toBe(1);
    expect(html).toContain("Code Tree");
    expect(html).toContain("src");
    expect(html).toContain("app.ts");
    expect(html).toContain("start");
    expect(html).toContain("expandAll");
    expect(html).toContain("collapseAll");
    expect(html).toContain("inspectorTitle");
    expect(html).toContain("edge:start-app");
    expect(html).not.toContain("</script><script>");
  });
});

describe("graph merge", () => {
  it("merges SwarmVault and node-link JSON into a namespaced graph artifact", async () => {
    const rootDir = await createTempWorkspace();
    const first = path.join(rootDir, "first.json");
    const second = path.join(rootDir, "second.json");
    const output = path.join(rootDir, "merged", "graph.json");
    await fs.writeFile(first, JSON.stringify(sampleGraph()), "utf8");
    await fs.writeFile(
      second,
      JSON.stringify({
        nodes: [
          { id: "a", label: "External A", type: "concept" },
          { id: "b", label: "External B", type: "entity" }
        ],
        links: [{ source: "a", target: "b", relation: "mentions", evidenceClass: "EXTRACTED" }]
      }),
      "utf8"
    );

    const result = await mergeGraphFiles([first, second], output);
    const merged = JSON.parse(await fs.readFile(output, "utf8")) as GraphArtifact;

    expect(result.inputGraphs.map((input) => input.format)).toEqual(["swarmvault", "node-link"]);
    expect(merged.nodes.some((node) => node.id.startsWith("first:"))).toBe(true);
    expect(merged.nodes.some((node) => node.id.startsWith("second:"))).toBe(true);
    expect(merged.edges.some((edge) => edge.source === "second:a" && edge.target === "second:b")).toBe(true);
  });
});
