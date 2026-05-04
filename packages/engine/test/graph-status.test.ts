import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWatchedRoot,
  compileVault,
  evaluateGraphShrinkGuard,
  getGraphStatus,
  ingestDirectory,
  initVault,
  loadVaultConfig,
  projectGraphAfterRemovals,
  runWatchCycle
} from "../src/index.js";

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

  it("aborts a graph update before destructive sync when shrink would exceed the threshold", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "alpha.ts"),
      "export function alpha() { return 1; }\nexport function beta() { return 2; }\nexport function gamma() { return 3; }\nexport function delta() { return 4; }\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "beta.ts"),
      "export function epsilon() { return 5; }\nexport function zeta() { return 6; }\nexport function eta() { return 7; }\n",
      "utf8"
    );
    await fs.writeFile(path.join(repoDir, "gamma.ts"), "export function theta() { return 8; }\n", "utf8");
    await ingestDirectory(rootDir, repoDir, {});
    await compileVault(rootDir);
    await addWatchedRoot(rootDir, repoDir);

    const { paths } = await loadVaultConfig(rootDir);
    const beforeGraph = JSON.parse(await fs.readFile(paths.graphPath, "utf8"));
    const beforeNodeCount = beforeGraph.nodes.length;
    const beforeEdgeCount = beforeGraph.edges.length;
    const beforeWikiCodePages = await fs.readdir(path.join(paths.wikiDir, "code"));

    // Delete two of three files so the predicted shrink crosses the 25% threshold
    await fs.rm(path.join(repoDir, "alpha.ts"));
    await fs.rm(path.join(repoDir, "beta.ts"));

    await expect(runWatchCycle(rootDir, { repo: true, codeOnly: true })).rejects.toThrow(/Graph update aborted/);

    // No destructive work should have happened — vault state must match the pre-abort baseline.
    const afterGraph = JSON.parse(await fs.readFile(paths.graphPath, "utf8"));
    expect(afterGraph.nodes.length).toBe(beforeNodeCount);
    expect(afterGraph.edges.length).toBe(beforeEdgeCount);
    const afterWikiCodePages = await fs.readdir(path.join(paths.wikiDir, "code"));
    expect(afterWikiCodePages.sort()).toEqual(beforeWikiCodePages.sort());
    await expect(fs.access(path.join(paths.rawDir, "sources"))).resolves.toBeUndefined();
    const rawSourcesAfter = await fs.readdir(path.join(paths.rawDir, "sources"));
    expect(rawSourcesAfter.some((entry) => entry.startsWith("alpha-"))).toBe(true);
    expect(rawSourcesAfter.some((entry) => entry.startsWith("beta-"))).toBe(true);
  });

  it("projects graph removals deterministically based on sourceId coverage", () => {
    const baseGraph = {
      generatedAt: "2026-05-04T12:00:00.000Z",
      nodes: [
        {
          id: "source:alpha",
          type: "source" as const,
          label: "alpha",
          sourceIds: ["alpha"],
          projectIds: []
        },
        {
          id: "source:beta",
          type: "source" as const,
          label: "beta",
          sourceIds: ["beta"],
          projectIds: []
        },
        {
          id: "concept:shared",
          type: "concept" as const,
          label: "shared",
          sourceIds: ["alpha", "beta"],
          projectIds: []
        }
      ],
      edges: [
        {
          id: "edge:alpha-shared",
          source: "source:alpha",
          target: "concept:shared",
          relation: "mentions",
          status: "extracted" as const,
          evidenceClass: "extracted" as const,
          confidence: 1,
          provenance: []
        },
        {
          id: "edge:beta-shared",
          source: "source:beta",
          target: "concept:shared",
          relation: "mentions",
          status: "extracted" as const,
          evidenceClass: "extracted" as const,
          confidence: 1,
          provenance: []
        }
      ],
      hyperedges: [],
      sources: [],
      pages: []
    };

    const projected = projectGraphAfterRemovals(baseGraph, ["alpha"]);
    expect(projected.nodes.map((node) => node.id).sort()).toEqual(["concept:shared", "source:beta"]);
    expect(projected.edges.map((edge) => edge.id)).toEqual(["edge:beta-shared"]);
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
