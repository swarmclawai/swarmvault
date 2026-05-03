import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, ingestInput, initVault, refreshGraphClusters } from "../src/index.js";
import type { GraphArtifact } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-cluster-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("refreshGraphClusters", () => {
  it("recomputes communities and graph report artifacts from an existing graph without recompile", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "alpha.ts"),
      "export function alpha() { return beta(); }\nfunction beta() { return 'b'; }\n",
      "utf8"
    );
    await fs.writeFile(path.join(rootDir, "gamma.ts"), "export function gamma() { return 'g'; }\n", "utf8");
    await ingestInput(rootDir, "alpha.ts");
    await ingestInput(rootDir, "gamma.ts");
    await compileVault(rootDir);

    const graphPath = path.join(rootDir, "state", "graph.json");
    const original = JSON.parse(await fs.readFile(graphPath, "utf8")) as GraphArtifact;
    await fs.writeFile(
      graphPath,
      JSON.stringify(
        {
          ...original,
          nodes: original.nodes.map(({ communityId: _communityId, degree: _degree, bridgeScore: _bridgeScore, ...node }) => node),
          communities: []
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await refreshGraphClusters(rootDir, { resolution: 1 });

    const refreshed = JSON.parse(await fs.readFile(graphPath, "utf8")) as GraphArtifact;
    expect(result.graphPath).toBe(graphPath);
    expect(result.nodeCount).toBe(refreshed.nodes.length);
    expect(result.communityCount).toBeGreaterThan(0);
    expect(refreshed.communities?.length ?? 0).toBeGreaterThan(0);
    expect(refreshed.nodes.some((node) => typeof node.degree === "number")).toBe(true);
    await expect(fs.access(path.join(rootDir, "wiki", "graph", "report.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "wiki", "graph", "report.md"))).resolves.toBeUndefined();
  });
});
