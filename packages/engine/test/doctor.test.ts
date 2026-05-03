import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, doctorVault, ingestInput, initVault } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-doctor-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("vault doctor", () => {
  it("reports missing graph and retrieval artifacts for an initialized empty vault", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const report = await doctorVault(rootDir);

    expect(report.ok).toBe(false);
    expect(report.status).toBe("error");
    expect(report.counts.sources).toBe(0);
    expect(report.checks.some((check) => check.id === "graph" && check.status === "error")).toBe(true);
    expect(report.checks.some((check) => check.id === "retrieval" && check.status === "warning")).toBe(true);
    expect(report.checks.flatMap((check) => check.actions ?? []).some((action) => action.command === "swarmvault compile")).toBe(true);
    expect(report.recommendations[0]).toMatchObject({
      id: "graph:swarmvault compile",
      priority: "high",
      command: "swarmvault compile",
      sourceCheckId: "graph"
    });
    expect(report.recommendations).toContainEqual(
      expect.objectContaining({
        id: "retrieval:swarmvault retrieval doctor --repair",
        safeAction: "doctor:repair",
        command: "swarmvault retrieval doctor --repair"
      })
    );
  });

  it("summarizes a healthy compiled vault", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "alpha.md"), "# Alpha\n\nDoctor health should summarize compiled vaults.\n", "utf8");
    await ingestInput(rootDir, path.join(rootDir, "alpha.md"));
    await compileVault(rootDir);
    await compileVault(rootDir);

    const report = await doctorVault(rootDir);

    expect(report.ok).toBe(true);
    expect(report.status).toBe("ok");
    expect(report.counts.sources).toBe(1);
    expect(report.counts.pages).toBeGreaterThan(0);
    expect(report.counts.nodes).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "graph")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "retrieval")?.status).toBe("ok");
    expect(report.recommendations).toEqual([]);
  });

  it("repairs missing retrieval artifacts when requested", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "alpha.md"), "# Alpha\n\nDoctor repair delegates to retrieval rebuild.\n", "utf8");
    await ingestInput(rootDir, path.join(rootDir, "alpha.md"));
    await compileVault(rootDir);
    await fs.rm(path.join(rootDir, "state", "retrieval", "fts-000.sqlite"), { force: true });

    const before = await doctorVault(rootDir);
    expect(before.ok).toBe(false);
    expect(before.repaired).toEqual([]);

    const repaired = await doctorVault(rootDir, { repair: true });
    expect(repaired.repaired).toContain("retrieval");
    expect(repaired.checks.find((check) => check.id === "retrieval")?.status).toBe("ok");
  });
});
