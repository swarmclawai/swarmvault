import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContextPack,
  compileVault,
  finishMemoryTask,
  initVault,
  listMemoryTasks,
  readMemoryTask,
  renderMemoryTaskMarkdown,
  resumeMemoryTask,
  runMigration,
  startMemoryTask,
  updateMemoryTask
} from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("agent memory tasks", () => {
  it("starts, updates, finishes, lists, reads, and resumes a durable memory task", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const started = await startMemoryTask(rootDir, {
      goal: "Implement durable agent memory",
      target: "./packages/engine/src",
      budgetTokens: 300,
      agent: "codex"
    });

    expect(started.task.status).toBe("active");
    expect(started.task.contextPackIds.length).toBe(1);
    expect(started.markdownPath).toContain(path.join("wiki", "memory", "tasks"));
    await expect(fs.access(started.artifactPath)).resolves.toBeUndefined();
    await expect(fs.access(started.markdownPath)).resolves.toBeUndefined();

    const updated = await updateMemoryTask(rootDir, started.task.id, {
      note: "The ledger should stay git-friendly.",
      decision: "Represent tasks as markdown plus JSON.",
      changedPath: "packages/engine/src/memory.ts",
      status: "blocked"
    });
    expect(updated.task.notes).toHaveLength(1);
    expect(updated.task.decisions).toHaveLength(1);
    expect(updated.task.changedPaths).toEqual(["packages/engine/src/memory.ts"]);
    expect(updated.task.status).toBe("blocked");

    const finished = await finishMemoryTask(rootDir, started.task.id, {
      outcome: "Memory task lifecycle is implemented.",
      followUp: "Wire memory tasks into the graph viewer."
    });
    expect(finished.task.status).toBe("completed");
    expect(finished.task.outcome).toBe("Memory task lifecycle is implemented.");
    expect(finished.task.followUps).toEqual(["Wire memory tasks into the graph viewer."]);

    const listed = await listMemoryTasks(rootDir);
    expect(listed.map((task) => task.id)).toContain(started.task.id);

    const read = await readMemoryTask(rootDir, started.task.id);
    expect(read?.goal).toBe("Implement durable agent memory");

    const markdown = renderMemoryTaskMarkdown(finished.task);
    expect(markdown).toContain("## Decisions");
    expect(markdown).toContain("Represent tasks as markdown plus JSON.");

    const parsed = matter(await fs.readFile(finished.markdownPath, "utf8"));
    expect(parsed.data.kind).toBe("memory_task");
    expect(parsed.data.status).toBe("completed");
    expect(parsed.data.memory_task_id).toBe(started.task.id);
    expect(parsed.data.task_id).toBe(started.task.id);
    expect(parsed.data.task_status).toBe("completed");
    expect(parsed.data.context_pack_ids).toEqual(started.task.contextPackIds);

    const resume = await resumeMemoryTask(rootDir, started.task.id, { format: "llms" });
    expect(resume.rendered).toContain("Agent Task Resume");
    expect(resume.rendered).toContain("Memory task lifecycle is implemented.");
    expect(resume.task.id).toBe(started.task.id);

    const followOnPack = await buildContextPack(rootDir, {
      goal: "Continue durable agent memory work",
      target: "packages/engine/src/memory.ts",
      budgetTokens: 1200
    });
    expect(followOnPack.pack.items.some((item) => item.pageId === `memory:${started.task.id}`)).toBe(true);
    expect(followOnPack.pack.items.find((item) => item.pageId === `memory:${started.task.id}`)?.reason).toMatch(/memory/i);

    await compileVault(rootDir);
    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8"));
    expect(
      graph.nodes.some((node: { id: string; type: string }) => node.id === `memory:${started.task.id}` && node.type === "memory_task")
    ).toBe(true);
    expect(graph.nodes.some((node: { type: string }) => node.type === "decision")).toBe(true);
    expect(graph.edges.some((edge: { relation: string }) => edge.relation === "records_decision")).toBe(true);
    expect(graph.edges.some((edge: { relation: string }) => edge.relation === "follows_up")).toBe(true);
  });

  it("starts a memory task without a target or agent without crashing the YAML serializer", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "notes.md"), "# Notes\n\nLightweight scratchpad to anchor the context pack.\n", "utf8");

    const started = await startMemoryTask(rootDir, {
      goal: "Run a memory task with no target or agent"
    });

    expect(started.task.status).toBe("active");
    expect(started.task.target).toBeUndefined();
    expect(started.task.agent).toBeUndefined();
    const markdown = await fs.readFile(started.markdownPath, "utf8");
    expect(markdown).not.toContain("[object Undefined]");
    const parsed = matter(markdown);
    expect(parsed.data.target).toBeUndefined();
    expect(parsed.data.agent).toBeUndefined();
  });

  it("migrates a vault by creating memory index artifacts without touching context packs", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.mkdir(path.join(rootDir, "state", "context-packs"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "state", "context-packs", "existing.json"), "{}\n", "utf8");

    const result = await runMigration(rootDir, { targetVersion: "2.0.0", dryRun: false });
    const seen = new Set([...result.applied.map((entry) => entry.id), ...result.skipped.map((entry) => entry.id)]);
    expect(seen.has("1.5-to-2.0-add-memory-ledger")).toBe(true);
    await expect(fs.access(path.join(rootDir, "wiki", "memory", "index.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "state", "memory", "tasks"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "state", "context-packs", "existing.json"))).resolves.toBeUndefined();
  });
});
