import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, ingestInput, initVault, queryVault } from "../src/index.js";
import type { CompileState, GraphArtifact } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-incr-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("incremental compilation", () => {
  it("returns zero changed pages once the candidate promotion pass has completed", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "note.md"), "# Test\n\nSome content about knowledge graphs and compilation.", "utf8");
    await ingestInput(rootDir, "note.md");

    const first = await compileVault(rootDir);
    expect(first.changedPages.length).toBeGreaterThan(0);

    const second = await compileVault(rootDir);
    expect(second.changedPages.length).toBeGreaterThan(0);

    const third = await compileVault(rootDir);
    expect(third.changedPages).toHaveLength(0);
  });

  it("writes sourceHashes to compile-state.json", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "a.md"), "# A\n\nContent A.", "utf8");
    await ingestInput(rootDir, "a.md");
    await compileVault(rootDir);

    const state = JSON.parse(await fs.readFile(path.join(rootDir, "state", "compile-state.json"), "utf8")) as CompileState;
    expect(Object.keys(state.sourceHashes).length).toBe(1);
    expect(state.rootSchemaHash).toBeTruthy();
    expect(state.effectiveSchemaHashes.global).toBeTruthy();
  });
});

describe("raw-source grounding in queries", () => {
  it("includes raw source excerpts in heuristic query output", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "raw-test.md"),
      "# Raw Source Test\n\nThis is the original raw content that should appear in query answers.",
      "utf8"
    );
    await ingestInput(rootDir, "raw-test.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, { question: "What is the raw content?", save: false });
    expect(result.answer).toContain("Raw source");
  });
});

describe("computed confidence", () => {
  it("assigns higher confidence to concepts seen in multiple sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "src1.md"),
      "# Knowledge Graphs\n\nKnowledge graphs store structured relationships between entities.",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "src2.md"),
      "# Graph Theory\n\nKnowledge graphs are a fundamental data structure for knowledge representation.",
      "utf8"
    );
    await ingestInput(rootDir, "src1.md");
    await ingestInput(rootDir, "src2.md");
    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;

    const multiSourceNodes = graph.nodes.filter((n) => n.type !== "source" && n.sourceIds.length > 1);
    const singleSourceNodes = graph.nodes.filter((n) => n.type !== "source" && n.sourceIds.length === 1);

    if (multiSourceNodes.length > 0 && singleSourceNodes.length > 0) {
      const avgMulti = multiSourceNodes.reduce((s, n) => s + (n.confidence ?? 0), 0) / multiSourceNodes.length;
      const avgSingle = singleSourceNodes.reduce((s, n) => s + (n.confidence ?? 0), 0) / singleSourceNodes.length;
      expect(avgMulti).toBeGreaterThan(avgSingle);
    }
  });
});

describe("concept-scoped conflict detection", () => {
  it("does not create conflict edges from coincidental word overlap", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "pos.md"),
      "# System Performance\n\nThe system is fast and efficient. Performance is excellent.",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "neg.md"),
      "# Weather Forecast\n\nThe weather is not great today. It cannot rain forever.",
      "utf8"
    );
    await ingestInput(rootDir, "pos.md");
    await ingestInput(rootDir, "neg.md");
    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;

    const conflictEdges = graph.edges.filter((e) => e.relation === "conflicted_with");
    expect(conflictEdges).toHaveLength(0);
  });
});
