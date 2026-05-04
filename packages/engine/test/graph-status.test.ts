import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, evaluateGraphShrinkGuard, getGraphStatus, ingestDirectory, initVault, loadVaultConfig } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-graph-status-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("graph status", () => {
  it("flags sharp graph shrinkage before a refresh is accepted", () => {
    const previous = {
      generatedAt: "2026-05-04T12:00:00.000Z",
      nodes: Array.from({ length: 12 }, (_, index) => ({
        id: `node:${index}`,
        type: "concept" as const,
        label: `Node ${index}`,
        sourceIds: [],
        projectIds: []
      })),
      edges: Array.from({ length: 8 }, (_, index) => ({
        id: `edge:${index}`,
        source: "node:0",
        target: `node:${index + 1}`,
        relation: "mentions",
        status: "extracted" as const,
        evidenceClass: "extracted" as const,
        confidence: 1,
        provenance: []
      })),
      hyperedges: [],
      sources: [],
      pages: []
    };
    const next = { ...previous, nodes: previous.nodes.slice(0, 8), edges: previous.edges.slice(0, 5) };

    const guard = evaluateGraphShrinkGuard(previous, next, { threshold: 0.25 });

    expect(guard.blocked).toBe(true);
    expect(guard.nodes.dropped).toBe(4);
    expect(guard.edges.dropped).toBe(3);
  });

  it("does not initialize a workspace when graph artifacts are missing", async () => {
    const rootDir = await createTempWorkspace();

    const status = await getGraphStatus(rootDir);

    expect(status.graphExists).toBe(false);
    expect(status.reportExists).toBe(false);
    expect(status.recommendedCommand).toBe("swarmvault compile");
    await expect(fs.access(path.join(rootDir, "swarmvault.config.json"))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "swarmvault.schema.md"))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "state"))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "wiki"))).rejects.toThrow();
  });

  it("reports tracked repo staleness without writing watch artifacts", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "app.ts"), "export function app() { return 'ok'; }\n", "utf8");
    await fs.writeFile(path.join(repoDir, "guide.md"), "# Guide\n\nInitial guide.\n", "utf8");
    await ingestDirectory(rootDir, repoDir, {});
    await compileVault(rootDir);
    const { paths } = await loadVaultConfig(rootDir);

    const fresh = await getGraphStatus(rootDir);
    expect(fresh.graphExists).toBe(true);
    expect(fresh.reportExists).toBe(true);
    expect(fresh.stale).toBe(false);
    expect(fresh.recommendedCommand).toBeNull();
    expect(fresh.trackedRepoRoots).toEqual([repoDir]);
    await expect(fs.access(paths.watchStatusPath)).rejects.toThrow();

    const relativeFresh = await getGraphStatus(rootDir, { repoRoots: ["repo"] });
    expect(relativeFresh.trackedRepoRoots).toEqual([repoDir]);
    expect(relativeFresh.stale).toBe(false);

    await fs.writeFile(path.join(repoDir, "app.ts"), "export function app() { return 'changed'; }\n", "utf8");
    const codeStatus = await getGraphStatus(rootDir);
    expect(codeStatus.codeChangeCount).toBe(1);
    expect(codeStatus.semanticChangeCount).toBe(0);
    expect(codeStatus.recommendedCommand).toBe("swarmvault graph update");

    await fs.writeFile(path.join(repoDir, "guide.md"), "# Guide\n\nUpdated guide.\n", "utf8");
    const mixedStatus = await getGraphStatus(rootDir);
    expect(mixedStatus.codeChangeCount).toBe(1);
    expect(mixedStatus.semanticChangeCount).toBe(1);
    expect(mixedStatus.recommendedCommand).toBe("swarmvault compile");
    expect(mixedStatus.changes.map((change) => `${change.refreshType}:${change.changeType}:${change.path}`)).toContain(
      "semantic:modified:repo/guide.md"
    );
    await expect(fs.access(paths.watchStatusPath)).rejects.toThrow();
  });
});
