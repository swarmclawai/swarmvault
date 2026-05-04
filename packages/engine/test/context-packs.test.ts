import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildContextPack,
  compileVault,
  deleteContextPack,
  ingestInput,
  initVault,
  listContextPacks,
  readContextPack
} from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-context-pack-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("context packs", () => {
  it("builds, lists, reads, and deletes token-bounded context packs", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "alpha.md"),
      "# Alpha Memory\n\nDurable memory keeps agent context alive across coding sessions.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "beta.md"),
      "# Beta Graph\n\nGraph paths explain which source pages and concepts support an answer.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "gamma.md"),
      "# Gamma Review\n\nReview queues keep generated wiki changes inspectable before activation.\n",
      "utf8"
    );

    await ingestInput(rootDir, path.join(rootDir, "alpha.md"));
    await ingestInput(rootDir, path.join(rootDir, "beta.md"));
    await ingestInput(rootDir, path.join(rootDir, "gamma.md"));
    await compileVault(rootDir);

    const result = await buildContextPack(rootDir, {
      goal: "Help an agent extend durable memory context",
      target: "memory",
      budgetTokens: 300,
      format: "llms"
    });

    expect(result.pack.items.length).toBeGreaterThan(0);
    expect(result.pack.omittedItems.length).toBeGreaterThan(0);
    expect(result.pack.estimatedTokens).toBeLessThanOrEqual(result.pack.budgetTokens);
    expect(result.pack.citations.length).toBeGreaterThan(0);
    expect(result.rendered).toContain("Use these cited vault facts");
    await expect(fs.access(result.artifactPath)).resolves.toBeUndefined();
    await expect(fs.access(result.markdownPath)).resolves.toBeUndefined();

    const listed = await listContextPacks(rootDir);
    expect(listed.map((pack) => pack.id)).toContain(result.pack.id);

    const read = await readContextPack(rootDir, result.pack.id);
    expect(read?.goal).toBe("Help an agent extend durable memory context");
    await expect(readContextPack(rootDir, `../${result.pack.id}`)).resolves.toBeNull();

    const deleted = await deleteContextPack(rootDir, result.pack.id);
    expect(deleted?.id).toBe(result.pack.id);
    await expect(fs.access(result.artifactPath)).rejects.toThrow();
    await expect(fs.access(result.markdownPath)).rejects.toThrow();
  });

  it("builds a context pack without a target, agent, or other optional fields", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "notes.md"), "# Notes\n\nCapture goals, decisions, and follow-ups here.\n", "utf8");
    await ingestInput(rootDir, path.join(rootDir, "notes.md"));
    await compileVault(rootDir);

    const result = await buildContextPack(rootDir, {
      goal: "summarize the vault"
    });

    expect(result.pack.target).toBeUndefined();
    await expect(fs.access(result.markdownPath)).resolves.toBeUndefined();
    const markdown = await fs.readFile(result.markdownPath, "utf8");
    expect(markdown).not.toContain("[object Undefined]");
    expect(markdown).not.toContain("target:\n");
  });
});
