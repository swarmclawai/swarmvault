import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS, detectVaultVersion, initVault, planMigration, runMigration } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-migrate-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writePage(rootDir: string, relPath: string, data: Record<string, unknown>, body: string): Promise<void> {
  const full = path.join(rootDir, "wiki", relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, matter.stringify(body, data), "utf8");
}

async function readPage(rootDir: string, relPath: string): Promise<{ data: Record<string, unknown>; content: string }> {
  const raw = await fs.readFile(path.join(rootDir, "wiki", relPath), "utf8");
  const parsed = matter(raw);
  return { data: (parsed.data ?? {}) as Record<string, unknown>, content: parsed.content };
}

describe("swarmvault migrate", () => {
  it("ships every migration step with a valid id and to-version", () => {
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(0);
    for (const step of ALL_MIGRATIONS) {
      expect(step.id).toMatch(/.+/);
      expect(step.toVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("detectVaultVersion returns null for an un-migrated vault with no graph", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.rm(path.join(rootDir, "state", "vault-version.json"), { force: true });
    await fs.rm(path.join(rootDir, "state", "graph.json"), { force: true });
    const version = await detectVaultVersion(rootDir);
    expect(version).toBeNull();
  });

  it("detectVaultVersion prefers state/vault-version.json when present", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.mkdir(path.join(rootDir, "state"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "state", "vault-version.json"),
      JSON.stringify({ version: "0.10.0", migratedAt: new Date().toISOString(), appliedSteps: [] }, null, 2),
      "utf8"
    );
    const version = await detectVaultVersion(rootDir);
    expect(version).toBe("0.10.0");
  });

  it("planMigration limits steps by the target version cap", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const plan = await planMigration(rootDir, "0.10.0");
    for (const step of plan.steps) {
      const [major, minor, patch] = step.toVersion.split(".").map((part) => Number.parseInt(part, 10));
      const target = [0, 10, 0];
      const cmp = major - target[0] || minor - target[1] || patch - target[2];
      expect(cmp).toBeLessThanOrEqual(0);
    }
  });

  it("adds decay_score, last_confirmed_at, tier, and tags to legacy pages on apply", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writePage(
      rootDir,
      "insights/old-insight.md",
      {
        page_id: "insights:old-insight",
        kind: "insight",
        title: "Old Insight",
        source_ids: [],
        node_ids: [],
        freshness: "fresh",
        updated_at: "2025-01-01T00:00:00.000Z"
      },
      "# Old Insight\n\nSome content.\n"
    );
    await writePage(
      rootDir,
      "concepts/legacy-concept.md",
      {
        page_id: "concept:legacy-concept",
        kind: "concept",
        title: "Legacy Concept",
        source_ids: [],
        node_ids: [],
        freshness: "fresh",
        updated_at: "2025-01-01T00:00:00.000Z"
      },
      "# Legacy Concept\n"
    );

    const dryRun = await runMigration(rootDir, { dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    // Dry-run must not write state/vault-version.json
    await expect(fs.access(path.join(rootDir, "state", "vault-version.json"))).rejects.toThrow();

    const applied = await runMigration(rootDir, { dryRun: false });
    expect(applied.dryRun).toBe(false);
    const knownSteps = new Set([
      "0.9-to-0.10-add-decay-fields",
      "0.9-to-0.10-add-tier-default",
      "0.10-to-0.11-add-tags-field",
      "0.10-to-0.11-normalize-config-watch-absence",
      "any-to-any-rebuild-search-index"
    ]);
    const seen = new Set([...applied.applied.map((entry) => entry.id), ...applied.skipped.map((entry) => entry.id)]);
    for (const id of knownSteps) {
      expect(seen.has(id)).toBe(true);
    }

    const insight = await readPage(rootDir, "insights/old-insight.md");
    expect(insight.data.decay_score).toBe(1);
    expect(insight.data.tier).toBe("working");

    const concept = await readPage(rootDir, "concepts/legacy-concept.md");
    expect(concept.data.tags).toEqual(["concept"]);

    if (applied.applied.length > 0) {
      const record = JSON.parse(await fs.readFile(path.join(rootDir, "state", "vault-version.json"), "utf8"));
      expect(record.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Array.isArray(record.appliedSteps)).toBe(true);
    }
  });

  it("is idempotent: running twice leaves pages unchanged on the second run", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await writePage(
      rootDir,
      "insights/retry.md",
      {
        page_id: "insights:retry",
        kind: "insight",
        title: "Retry",
        source_ids: [],
        node_ids: [],
        freshness: "fresh",
        updated_at: "2025-01-01T00:00:00.000Z"
      },
      "# Retry\n"
    );
    await runMigration(rootDir, { dryRun: false });
    const second = await runMigration(rootDir, { dryRun: false });
    expect(second.applied).toEqual([]);
  });
});
