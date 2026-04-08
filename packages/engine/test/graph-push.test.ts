import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, pushGraphNeo4j } from "../src/index.js";
import type { GraphArtifact } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-neo4j-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.SWARMVAULT_TEST_NEO4J_PASSWORD;
});

async function writeGraph(rootDir: string, graph: GraphArtifact): Promise<void> {
  await fs.writeFile(path.join(rootDir, "state", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

async function updateConfig(rootDir: string, mutate: (config: Record<string, unknown>) => void): Promise<void> {
  const configPath = path.join(rootDir, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function sampleGraph(): GraphArtifact {
  return {
    generatedAt: "2026-04-08T18:30:00.000Z",
    nodes: [
      {
        id: "node:first",
        type: "concept",
        label: "First Party Concept",
        pageId: "page:first",
        freshness: "fresh",
        confidence: 1,
        sourceIds: ["source:first"],
        projectIds: [],
        sourceClass: "first_party"
      },
      {
        id: "node:third",
        type: "concept",
        label: "Third Party Concept",
        pageId: "page:third",
        freshness: "fresh",
        confidence: 1,
        sourceIds: ["source:third"],
        projectIds: [],
        sourceClass: "third_party"
      }
    ],
    edges: [
      {
        id: "edge:first-third",
        source: "node:first",
        target: "node:third",
        relation: "depends_on",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 0.9,
        provenance: ["source:first", "source:third"]
      }
    ],
    hyperedges: [
      {
        id: "hyper:mixed",
        label: "Mixed Group",
        relation: "participate_in",
        nodeIds: ["node:first", "node:third"],
        evidenceClass: "inferred",
        confidence: 0.75,
        sourcePageIds: ["page:first", "page:third"],
        why: "Mixed first-party and third-party cluster"
      }
    ],
    communities: [
      {
        id: "community:1",
        label: "Community 1",
        nodeIds: ["node:first", "node:third"]
      }
    ],
    sources: [
      {
        sourceId: "source:first",
        title: "First Source",
        originType: "file",
        sourceKind: "markdown",
        originalPath: "first.md",
        storedPath: "raw/sources/source:first.md",
        extractedTextPath: "state/extracts/source:first.md",
        extractedMetadataPath: "state/extracts/source:first.json",
        contentHash: "hash:first",
        createdAt: "2026-04-08T18:30:00.000Z",
        updatedAt: "2026-04-08T18:30:00.000Z",
        mimeType: "text/markdown",
        sourceClass: "first_party"
      },
      {
        sourceId: "source:third",
        title: "Third Source",
        originType: "file",
        sourceKind: "markdown",
        originalPath: "third.md",
        storedPath: "raw/sources/source:third.md",
        extractedTextPath: "state/extracts/source:third.md",
        extractedMetadataPath: "state/extracts/source:third.json",
        contentHash: "hash:third",
        createdAt: "2026-04-08T18:30:00.000Z",
        updatedAt: "2026-04-08T18:30:00.000Z",
        mimeType: "text/markdown",
        sourceClass: "third_party"
      }
    ],
    pages: [
      {
        id: "page:first",
        path: "wiki/concepts/first.md",
        title: "First Party Concept",
        kind: "concept",
        sourceClass: "first_party",
        sourceIds: ["source:first"],
        projectIds: [],
        nodeIds: ["node:first"],
        freshness: "fresh",
        status: "active",
        confidence: 1,
        backlinks: [],
        schemaHash: "schema",
        sourceHashes: { "source:first": "hash:first" },
        relatedPageIds: [],
        relatedNodeIds: [],
        relatedSourceIds: [],
        createdAt: "2026-04-08T18:30:00.000Z",
        updatedAt: "2026-04-08T18:30:00.000Z",
        compiledFrom: ["source:first"],
        managedBy: "system"
      },
      {
        id: "page:third",
        path: "wiki/concepts/third.md",
        title: "Third Party Concept",
        kind: "concept",
        sourceClass: "third_party",
        sourceIds: ["source:third"],
        projectIds: [],
        nodeIds: ["node:third"],
        freshness: "fresh",
        status: "active",
        confidence: 1,
        backlinks: [],
        schemaHash: "schema",
        sourceHashes: { "source:third": "hash:third" },
        relatedPageIds: [],
        relatedNodeIds: [],
        relatedSourceIds: [],
        createdAt: "2026-04-08T18:30:00.000Z",
        updatedAt: "2026-04-08T18:30:00.000Z",
        compiledFrom: ["source:third"],
        managedBy: "system"
      }
    ]
  };
}

describe("graph push neo4j", () => {
  it("uses config-backed defaults and first-party filtering in dry-run mode", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writeGraph(rootDir, sampleGraph());
    await updateConfig(rootDir, (config) => {
      config.graphSinks = {
        neo4j: {
          uri: "bolt://127.0.0.1:7687",
          username: "neo4j",
          passwordEnv: "SWARMVAULT_TEST_NEO4J_PASSWORD",
          database: "neo4j",
          batchSize: 123
        }
      };
    });

    const result = await pushGraphNeo4j(rootDir, { dryRun: true });
    expect(result.sink).toBe("neo4j");
    expect(result.uri).toBe("bolt://127.0.0.1:7687");
    expect(result.database).toBe("neo4j");
    expect(result.includedSourceClasses).toEqual(["first_party"]);
    expect(result.vaultId).toMatch(/^swarmvault-neo4j-[a-z0-9-]+-[a-f0-9]{12}$/);
    expect(result.counts.sources).toBe(1);
    expect(result.counts.pages).toBe(1);
    expect(result.counts.nodes).toBe(1);
    expect(result.counts.relationships).toBe(0);
    expect(result.counts.hyperedges).toBe(0);
    expect(result.skipped.sources).toBe(1);
    expect(result.skipped.nodes).toBe(1);
    expect(result.skipped.relationships).toBe(1);
    expect(result.skipped.hyperedges).toBe(1);
  });

  it("merges config and flags, preserves shared-database vaultId namespacing, and writes sync metadata", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writeGraph(rootDir, sampleGraph());
    await updateConfig(rootDir, (config) => {
      config.graphSinks = {
        neo4j: {
          uri: "bolt://127.0.0.1:7687",
          username: "neo4j",
          passwordEnv: "SWARMVAULT_TEST_NEO4J_PASSWORD",
          database: "default-db",
          includeClasses: ["first_party"]
        }
      };
    });
    process.env.SWARMVAULT_TEST_NEO4J_PASSWORD = "password";

    const calls: Array<{ query: string; params?: Record<string, unknown> }> = [];
    const fakeDriver = {
      session() {
        return {
          async run(query: string, params?: Record<string, unknown>) {
            calls.push({ query, params });
            return {};
          },
          async executeWrite<T>(work: (tx: { run(query: string, params?: Record<string, unknown>): Promise<unknown> }) => Promise<T>) {
            return await work({
              async run(query: string, params?: Record<string, unknown>) {
                calls.push({ query, params });
                return {};
              }
            });
          },
          async close() {}
        };
      },
      async close() {}
    };

    const result = await pushGraphNeo4j(rootDir, {
      database: "custom-db",
      vaultId: "vault-123",
      includeClasses: ["first_party", "third_party"],
      driverFactory: () => fakeDriver
    });

    expect(result.database).toBe("custom-db");
    expect(result.vaultId).toBe("vault-123");
    expect(result.includedSourceClasses).toEqual(["first_party", "third_party"]);
    expect(result.counts.nodes).toBe(2);
    expect(result.counts.relationships).toBe(1);
    expect(result.counts.hyperedges).toBe(1);
    expect(result.counts.groupMembers).toBe(2);

    expect(calls.some((entry) => entry.query.includes("CREATE CONSTRAINT swarmvault_node_identity"))).toBe(true);
    expect(
      calls.some(
        (entry) => entry.query.includes("MERGE (n:SwarmNode { vaultId: $vaultId, id: row.id })") && entry.params?.vaultId === "vault-123"
      )
    ).toBe(true);
    expect(
      calls.some((entry) => entry.query.includes("MERGE (s:SwarmVaultSync { vaultId: $vaultId })") && entry.params?.vaultId === "vault-123")
    ).toBe(true);
    expect(
      calls.some(
        (entry) =>
          entry.query.includes("MERGE (a)-[r:DEPENDS_ON") && Array.isArray(entry.params?.rows) && entry.params?.vaultId === "vault-123"
      )
    ).toBe(true);
    expect(calls.some((entry) => entry.query.includes("MERGE (a)-[r:GROUP_MEMBER"))).toBe(true);
  });
});
