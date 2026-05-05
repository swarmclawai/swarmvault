import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/analysis.js";
import { loadVaultConfig } from "../src/config.js";
import { initVault } from "../src/index.js";
import type { ProviderAdapter, SourceManifest } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-analysis-chunking-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function manifestFor(rootDir: string): SourceManifest {
  return {
    sourceId: "source:long",
    title: "Long Source",
    originType: "file",
    sourceKind: "markdown",
    originalPath: path.join(rootDir, "long.md"),
    storedPath: path.join(rootDir, "raw", "sources", "long.md"),
    mimeType: "text/markdown",
    contentHash: "hash:long",
    semanticHash: "semantic:long",
    extractionHash: "extract:long",
    createdAt: "2026-05-05T12:00:00.000Z",
    updatedAt: "2026-05-05T12:00:00.000Z"
  };
}

describe("provider analysis chunking", () => {
  it("analyzes long non-code sources in bounded chunks and merges the result", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const { paths } = await loadVaultConfig(rootDir);
    const manifest = manifestFor(rootDir);
    const calls: string[] = [];
    const provider: ProviderAdapter = {
      id: "chunk-test",
      type: "custom",
      model: "chunk-model",
      capabilities: new Set(["structured"]),
      generateText: vi.fn(),
      generateStructured: async (request, schema) => {
        calls.push(request.prompt);
        const chunkLabel = request.prompt.match(/Chunk: (\d+)\/(\d+)/)?.[1] ?? "single";
        return schema.parse({
          title: `Chunk ${chunkLabel}`,
          summary: `Summary for chunk ${chunkLabel}.`,
          concepts: [{ name: `Concept ${chunkLabel}`, description: "Chunk concept" }],
          entities: [{ name: "SwarmVault", description: "Project entity" }],
          claims: [
            {
              text: `Claim from chunk ${chunkLabel}.`,
              confidence: 0.8,
              status: "extracted",
              polarity: "positive",
              citation: "provider-citation"
            }
          ],
          questions: [`Question ${chunkLabel}?`],
          tags: [`tag-${chunkLabel}`]
        });
      }
    };
    const text = Array.from({ length: 90 }, (_, index) => `## Section ${index}\n${"Long source paragraph. ".repeat(40)}`).join("\n\n");

    const analysis = await analyzeSource(manifest, text, provider, paths, {
      path: paths.schemaPath,
      content: "schema",
      hash: "schema-hash"
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((prompt) => prompt.length < 19000)).toBe(true);
    expect(analysis.summary).toContain("Summary for chunk 1");
    expect(analysis.concepts.length).toBeGreaterThan(1);
    expect(analysis.entities).toHaveLength(1);
    expect(analysis.claims[0]?.citation).toBe("source:long#chunk-1");
    expect(analysis.tags.length).toBeGreaterThan(1);
  });
});
