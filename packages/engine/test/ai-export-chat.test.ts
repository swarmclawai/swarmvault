import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { askChatSession, compileVault, deleteChatSession, exportAiPack, ingestInput, initVault, listChatSessions } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-ai-export-chat-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("AI export packs and chat sessions", () => {
  async function createCompiledVault(): Promise<string> {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "research.md"),
      [
        "# Durable Agent Handoffs",
        "",
        "SwarmVault compiles durable wiki pages so future agents can read summaries, graph relations, and cited outputs."
      ].join("\n"),
      "utf8"
    );
    await ingestInput(rootDir, "research.md");
    await compileVault(rootDir);
    return rootDir;
  }

  it("exports a static AI handoff pack with index, full text, graph JSON-LD, manifest, and page siblings", async () => {
    const rootDir = await createCompiledVault();
    const result = await exportAiPack(rootDir, { outDir: "exports/ai", maxFullChars: 20_000 });

    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.files.some((file) => file.path === "llms.txt" && file.kind === "index")).toBe(true);
    expect(result.files.some((file) => file.path === "llms-full.txt" && file.kind === "full-text")).toBe(true);
    expect(result.files.some((file) => file.path === "graph.jsonld" && file.kind === "graph-jsonld")).toBe(true);
    expect(result.files.some((file) => file.path === "manifest.json" && file.kind === "manifest")).toBe(true);
    expect(result.files.some((file) => file.kind === "page-text")).toBe(true);
    expect(result.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);

    const index = await fs.readFile(path.join(result.outputDir, "llms.txt"), "utf8");
    expect(index).toContain("SwarmVault AI Index");
    expect(index).toContain("swarmvault chat");

    const graphJsonLd = JSON.parse(await fs.readFile(path.join(result.outputDir, "graph.jsonld"), "utf8")) as { "@graph": unknown[] };
    expect(Array.isArray(graphJsonLd["@graph"])).toBe(true);
    expect(graphJsonLd["@graph"].length).toBeGreaterThan(0);
  });

  it("persists resumable chat sessions over the compiled wiki", async () => {
    const rootDir = await createCompiledVault();
    const first = await askChatSession(rootDir, { question: "What does this vault preserve?", saveOutput: false });

    expect(first.session.turns).toHaveLength(1);
    expect(first.answer.length).toBeGreaterThan(0);
    await expect(fs.access(first.statePath)).resolves.toBeUndefined();
    await expect(fs.access(first.markdownPath)).resolves.toBeUndefined();

    const second = await askChatSession(rootDir, {
      question: "How should a future agent use that?",
      sessionId: first.session.id,
      saveOutput: false
    });
    expect(second.resumed).toBe(true);
    expect(second.session.turns).toHaveLength(2);
    expect(second.markdownPath).toBe(first.markdownPath);

    const sessions = await listChatSessions(rootDir);
    expect(sessions.some((session) => session.id === first.session.id && session.turnCount === 2)).toBe(true);

    const deleted = await deleteChatSession(rootDir, first.session.id.slice(0, 12));
    expect(deleted.id).toBe(first.session.id);
    expect(await listChatSessions(rootDir)).toHaveLength(0);
  });
});
