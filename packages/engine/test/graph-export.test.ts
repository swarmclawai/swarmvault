import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { exportObsidianVault, initVault } from "../src/index.js";
import type { GraphArtifact, GraphNode, GraphPage } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-obsidian-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeGraph(rootDir: string, graph: GraphArtifact): Promise<void> {
  await fs.writeFile(path.join(rootDir, "state", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

async function writeWikiPage(rootDir: string, relPath: string, content: string): Promise<void> {
  const fullPath = path.join(rootDir, "wiki", relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

function makeNode(overrides: Partial<GraphNode> & { id: string; type: string; label: string }): GraphNode {
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
    createdAt: "2026-04-08T18:30:00.000Z",
    updatedAt: "2026-04-08T18:30:00.000Z",
    compiledFrom: [],
    managedBy: "system",
    ...overrides
  };
}

function sampleGraph(): GraphArtifact {
  return {
    generatedAt: "2026-04-08T18:30:00.000Z",
    nodes: [
      makeNode({ id: "source:alpha", type: "source", label: "Alpha Source", pageId: "source:alpha" }),
      makeNode({ id: "concept:auth", type: "concept", label: "Authentication", pageId: "concept:auth" }),
      makeNode({ id: "entity:orphan", type: "entity", label: "Orphan Entity" }),
      makeNode({
        id: "rationale:long",
        type: "rationale",
        label: "Append-only event store with stream-based organization. WHY: An append-only store guarantees event immutability"
      })
    ],
    edges: [
      {
        id: "edge:alpha-auth",
        source: "source:alpha",
        target: "concept:auth",
        relation: "mentions",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 0.9,
        provenance: ["source:alpha"]
      },
      {
        id: "edge:auth-orphan",
        source: "concept:auth",
        target: "entity:orphan",
        relation: "related_to",
        status: "extracted",
        evidenceClass: "inferred",
        confidence: 0.7,
        provenance: []
      }
    ],
    hyperedges: [],
    communities: [{ id: "community:auth-1", label: "Authentication", nodeIds: ["concept:auth", "entity:orphan"] }],
    sources: [
      {
        sourceId: "source:alpha",
        title: "Alpha",
        originType: "file",
        sourceKind: "markdown",
        originalPath: "alpha.md",
        storedPath: "raw/sources/alpha.md",
        extractedTextPath: "state/extracts/alpha.md",
        extractedMetadataPath: "state/extracts/alpha.json",
        contentHash: "hash:alpha",
        semanticHash: "semantic:alpha",
        createdAt: "2026-04-08T18:30:00.000Z",
        updatedAt: "2026-04-08T18:30:00.000Z",
        mimeType: "text/markdown",
        sourceClass: "first_party"
      }
    ],
    pages: [
      makePage({ id: "source:alpha", path: "sources/alpha.md", title: "Alpha Source", nodeIds: ["source:alpha"] }),
      makePage({ id: "concept:auth", path: "concepts/auth.md", title: "Authentication", kind: "concept", nodeIds: ["concept:auth"] })
    ]
  };
}

describe("obsidian vault export", () => {
  it("copies wiki pages preserving folder structure", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);
    await writeWikiPage(
      root,
      "sources/alpha.md",
      matter.stringify("# Alpha Source\nSome content.", { page_id: "source:alpha", title: "Alpha Source", kind: "source" })
    );
    await writeWikiPage(
      root,
      "concepts/auth.md",
      matter.stringify("# Authentication\nAuth content.", { page_id: "concept:auth", title: "Authentication", kind: "concept" })
    );

    const outputDir = path.join(root, "obsidian-export");
    const result = await exportObsidianVault(root, outputDir);

    expect(result.format).toBe("obsidian");
    const sourcePage = await fs.readFile(path.join(outputDir, "sources", "alpha.md"), "utf8");
    expect(sourcePage).toContain("# Alpha Source");
    const conceptPage = await fs.readFile(path.join(outputDir, "concepts", "auth.md"), "utf8");
    expect(conceptPage).toContain("# Authentication");
  });

  it("enriches frontmatter with graph metadata", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    // Give concept:auth a community
    graph.nodes[1].communityId = "community:auth-1";
    await writeGraph(root, graph);
    await writeWikiPage(
      root,
      "concepts/auth.md",
      matter.stringify("# Authentication\nContent.", { page_id: "concept:auth", title: "Authentication", kind: "concept" })
    );

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    const content = await fs.readFile(path.join(outputDir, "concepts", "auth.md"), "utf8");
    const parsed = matter(content);
    expect(parsed.data.graph_community).toBe("community:auth-1");
  });

  it("appends graph connections section with wikilinks", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);
    await writeWikiPage(
      root,
      "sources/alpha.md",
      matter.stringify("# Alpha Source\nContent.", { page_id: "source:alpha", title: "Alpha Source", kind: "source" })
    );
    await writeWikiPage(
      root,
      "concepts/auth.md",
      matter.stringify("# Authentication\nContent.", { page_id: "concept:auth", title: "Authentication", kind: "concept" })
    );

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    const content = await fs.readFile(path.join(outputDir, "sources", "alpha.md"), "utf8");
    expect(content).toContain("## Graph Connections");
    expect(content).toContain("[[concepts/auth|Authentication]]");
  });

  it("creates stubs for orphan nodes in type subdirectories", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    // entity:orphan has no pageId, should go to graph/nodes/entities/
    const orphanFiles = await fs.readdir(path.join(outputDir, "graph", "nodes", "entities"));
    expect(orphanFiles.length).toBeGreaterThanOrEqual(1);
    const orphanContent = await fs.readFile(path.join(outputDir, "graph", "nodes", "entities", orphanFiles[0]), "utf8");
    expect(orphanContent).toContain("# Orphan Entity");
    const parsed = matter(orphanContent);
    expect(parsed.data.id).toBe("entity:orphan");
    expect(parsed.data.type).toBe("entity");
  });

  it("uses clean slugs for orphan filenames instead of raw labels", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    // The rationale node with a long label should have a slug filename, not the full sentence
    const rationaleFiles = await fs.readdir(path.join(outputDir, "graph", "nodes", "rationales"));
    expect(rationaleFiles.length).toBe(1);
    // Filename should be a slug, not the full 100+ char label
    expect(rationaleFiles[0].length).toBeLessThan(120);
    expect(rationaleFiles[0]).not.toContain("WHY");
  });

  it("writes community files to graph/communities/", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    graph.nodes[1].communityId = "community:auth-1";
    graph.nodes[2].communityId = "community:auth-1";
    await writeGraph(root, graph);
    await writeWikiPage(
      root,
      "concepts/auth.md",
      matter.stringify("# Auth\nContent.", { page_id: "concept:auth", title: "Auth", kind: "concept" })
    );

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    const communityDir = path.join(outputDir, "graph", "communities");
    const communityFiles = await fs.readdir(communityDir);
    // Should have at least the auth community + unassigned
    expect(communityFiles.length).toBeGreaterThanOrEqual(1);
    const authFile = communityFiles.find((f) => f.includes("Authentication"));
    expect(authFile).toBeTruthy();
    const content = await fs.readFile(path.join(communityDir, authFile!), "utf8");
    expect(content).toContain("# Authentication");
    expect(content).toContain("## Members");
  });

  it("adds aliases when node label differs from page title", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    // Make a node with label "Auth" pointing to page titled "Authentication"
    graph.nodes[1].label = "Auth";
    await writeGraph(root, graph);
    await writeWikiPage(
      root,
      "concepts/auth.md",
      matter.stringify("# Authentication\nContent.", { page_id: "concept:auth", title: "Authentication", kind: "concept" })
    );

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    const content = await fs.readFile(path.join(outputDir, "concepts", "auth.md"), "utf8");
    const parsed = matter(content);
    expect(parsed.data.aliases).toContain("Auth");
  });

  it("creates .obsidian config in export directory", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    const appJson = JSON.parse(await fs.readFile(path.join(outputDir, ".obsidian", "app.json"), "utf8"));
    expect(appJson.useMarkdownLinks).toBe(false);
    const corePlugins = JSON.parse(await fs.readFile(path.join(outputDir, ".obsidian", "core-plugins.json"), "utf8"));
    expect(corePlugins).toContain("graph");
    expect(corePlugins).toContain("backlink");
    const graphJson = JSON.parse(await fs.readFile(path.join(outputDir, ".obsidian", "graph.json"), "utf8"));
    expect(graphJson).toBeDefined();
  });

  it("deduplicates orphan node filenames with same slug", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    // Add two orphan entities with the same label
    graph.nodes.push(
      makeNode({ id: "entity:dup1", type: "entity", label: "Duplicate" }),
      makeNode({ id: "entity:dup2", type: "entity", label: "Duplicate" })
    );
    await writeGraph(root, graph);

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    const entityFiles = await fs.readdir(path.join(outputDir, "graph", "nodes", "entities"));
    const dupFiles = entityFiles.filter((f) => f.startsWith("duplicate"));
    expect(dupFiles.length).toBe(2);
    expect(dupFiles[0]).not.toBe(dupFiles[1]);
  });

  it("returns fileCount including all file types", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);
    await writeWikiPage(
      root,
      "sources/alpha.md",
      matter.stringify("# Alpha\nContent.", { page_id: "source:alpha", title: "Alpha", kind: "source" })
    );

    const outputDir = path.join(root, "obsidian-export");
    const result = await exportObsidianVault(root, outputDir);

    // Should include: wiki pages + orphan stubs + community files + .obsidian configs
    expect(result.fileCount).toBeGreaterThanOrEqual(5);
  });

  it("skips missing wiki files gracefully", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    // Graph references pages that don't exist on disk
    await writeGraph(root, graph);
    // Don't write any wiki pages

    const outputDir = path.join(root, "obsidian-export");
    // Should not throw
    const result = await exportObsidianVault(root, outputDir);
    expect(result.format).toBe("obsidian");
    expect(result.fileCount).toBeGreaterThanOrEqual(1);
  });

  it("copies referenced assets into output", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);

    // Create an asset in raw/assets
    const assetsDir = path.join(root, "raw", "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, "diagram.png"), "fake-png-data");

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    // raw/assets should be copied
    const copiedAsset = await fs.readFile(path.join(outputDir, "raw", "assets", "diagram.png"), "utf8");
    expect(copiedAsset).toBe("fake-png-data");
  });

  it("adds aliases to orphan node stubs when label differs from slug", async () => {
    const root = await createTempWorkspace();
    await initVault(root);

    const graph = sampleGraph();
    await writeGraph(root, graph);

    const outputDir = path.join(root, "obsidian-export");
    await exportObsidianVault(root, outputDir);

    // The orphan entity has label "Orphan Entity" but slug will be "orphan-entity"
    const entityFiles = await fs.readdir(path.join(outputDir, "graph", "nodes", "entities"));
    const orphanFile = entityFiles.find((f) => f.includes("orphan"));
    expect(orphanFile).toBeTruthy();
    const content = await fs.readFile(path.join(outputDir, "graph", "nodes", "entities", orphanFile!), "utf8");
    const parsed = matter(content);
    expect(parsed.data.aliases).toContain("Orphan Entity");
  });
});
