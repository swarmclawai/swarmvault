import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, exploreVault, ingestInput, initVault, lintVault, queryVault, searchVault, watchVault } from "../src/index.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-compound-"));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition.");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("compounding loop", () => {
  it("rebuilds compile artifacts when state files are missing even if sources are unchanged", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "note.md"), "# Artifact Check\n\nPersistent outputs matter for search and graph sync.", "utf8");
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    await fs.rm(path.join(rootDir, "state", "graph.json"), { force: true });
    await fs.rm(path.join(rootDir, "state", "search.sqlite"), { force: true });
    await fs.rm(path.join(rootDir, "wiki", "index.md"), { force: true });

    const result = await compileVault(rootDir);
    expect(result.pageCount).toBeGreaterThan(0);
    await expect(fs.access(path.join(rootDir, "state", "graph.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "state", "search.sqlite"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "wiki", "index.md"))).resolves.toBeUndefined();
  });

  it("saves outputs immediately into graph/search/indexes and recompiles related output sections later", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "note.md"),
      ["# Local Graphs", "", "Local-first systems keep durable graph artifacts and schema-guided markdown outputs."].join("\n"),
      "utf8"
    );
    const manifest = await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, "What does this vault say about durable graph artifacts?", true);
    expect(result.savedTo).toBeTruthy();
    expect(result.savedPageId).toBeTruthy();
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.relatedPageIds.length).toBeGreaterThan(0);

    const savedOutput = await fs.readFile(result.savedTo as string, "utf8");
    const parsedOutput = matter(savedOutput);
    expect(parsedOutput.data.source_ids).toContain(manifest.sourceId);
    expect(parsedOutput.data.related_page_ids).toContain(`source:${manifest.sourceId}`);

    const rootIndex = await fs.readFile(path.join(rootDir, "wiki", "index.md"), "utf8");
    const outputsIndex = await fs.readFile(path.join(rootDir, "wiki", "outputs", "index.md"), "utf8");
    expect(rootIndex).toContain(parsedOutput.data.title as string);
    expect(outputsIndex).toContain(parsedOutput.data.title as string);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as {
      pages: Array<{ id: string }>;
    };
    expect(graph.pages.some((page) => page.id === result.savedPageId)).toBe(true);

    const searchResults = await searchVault(rootDir, "durable graph artifacts", 10);
    expect(searchResults.some((page) => page.pageId === result.savedPageId)).toBe(true);

    await compileVault(rootDir);
    const sourcePage = await fs.readFile(path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`), "utf8");
    expect(sourcePage).toContain("## Related Outputs");
    expect(sourcePage).toContain(parsedOutput.data.title as string);
  });

  it("indexes human insights without rewriting them", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "note.md"),
      ["# Durable Notes", "", "Compiled pages should coexist with human-authored insight files."].join("\n"),
      "utf8"
    );
    await ingestInput(rootDir, "note.md");

    const insightPath = path.join(rootDir, "wiki", "insights", "research-hypothesis.md");
    const insightContent = [
      "---",
      "title: Research Hypothesis",
      "status: active",
      "managed_by: human",
      "---",
      "",
      "# Research Hypothesis",
      "",
      "Human insight: durable notes need explicit session history."
    ].join("\n");
    await fs.writeFile(insightPath, insightContent, "utf8");

    await compileVault(rootDir);

    const searchResults = await searchVault(rootDir, "explicit session history", 10);
    expect(searchResults.some((page) => page.path === "insights/research-hypothesis.md")).toBe(true);

    const query = await queryVault(rootDir, "What human insight is recorded about session history?");
    expect(query.relatedPageIds.some((pageId) => pageId.startsWith("insight:"))).toBe(true);
    expect(query.answer).toContain("Research Hypothesis");

    const insightAfterCompile = await fs.readFile(insightPath, "utf8");
    expect(insightAfterCompile).toBe(insightContent);
  });

  it("writes multi-step exploration outputs and a hub page", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "research.md"),
      ["# Research", "", "SwarmVault compiles research notes into a persistent wiki and graph."].join("\n"),
      "utf8"
    );
    await ingestInput(rootDir, "research.md");
    await compileVault(rootDir);

    const result = await exploreVault(rootDir, "How does this vault work?", 2);
    expect(result.stepCount).toBeGreaterThan(0);
    expect(result.stepCount).toBeLessThanOrEqual(2);
    expect(result.steps.every((step) => step.savedTo.length > 0)).toBe(true);
    await expect(fs.access(result.hubPath)).resolves.toBeUndefined();

    const hub = await fs.readFile(result.hubPath, "utf8");
    expect(hub).toContain("## Steps");
    expect(hub).toContain("## Follow-Up Questions");
  });

  it("retries watch cycles after a failure without a second file event", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "watch-provider.mjs"),
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "",
        "export async function createAdapter(id, config, rootDir) {",
        "  const failOncePath = path.join(rootDir, 'state', 'watch-fail-once.txt');",
        "  const shouldFail = await fs",
        "    .access(failOncePath)",
        "    .then(() => true)",
        "    .catch(() => false);",
        "  if (shouldFail) {",
        "    await fs.rm(failOncePath, { force: true });",
        "    throw new Error('intentional first failure');",
        "  }",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText() {",
        "      return { text: 'ok' };",
        "    },",
        "    async generateStructured() {",
        "      return {",
        "        title: 'Retry Source',",
        "        summary: 'Recovered after retry.',",
        "        concepts: [],",
        "        entities: [],",
        "        claims: [],",
        "        questions: []",
        "      };",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(rootDir, "state", "watch-fail-once.txt"), "fail-once\n", "utf8");

    const configPath = path.join(rootDir, "swarmvault.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      providers: Record<string, unknown>;
      tasks: Record<string, string>;
    };
    config.providers.retry = {
      type: "custom",
      model: "retry-test",
      module: "./watch-provider.mjs",
      capabilities: ["chat", "structured"]
    };
    config.tasks.compileProvider = "retry";
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const controller = await watchVault(rootDir, { debounceMs: 100 });
    try {
      await fs.writeFile(
        path.join(rootDir, "inbox", "retry.md"),
        ["# Retry", "", "This should compile after one retry without another file event."].join("\n"),
        "utf8"
      );

      await waitFor(async () => {
        const logPath = path.join(rootDir, "state", "jobs.ndjson");
        const raw = await fs.readFile(logPath, "utf8").catch(() => "");
        const runs = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { success: boolean });
        return runs.length >= 2 && runs.some((run) => run.success === false) && runs.at(-1)?.success === true;
      });
    } finally {
      await controller.close();
    }
  }, 15_000);

  it("returns deep lint findings and optional web evidence", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "note.md"), "# Deep Lint\n\nThis note needs stronger citation coverage.", "utf8");
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "lint-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText() {",
        "      return { text: 'ok' };",
        "    },",
        "    async generateStructured() {",
        "      return {",
        "        findings: [",
        "          {",
        "            severity: 'warning',",
        "            code: 'coverage_gap',",
        "            message: 'Research coverage is thin here.',",
        "            relatedSourceIds: ['deep-lint-source'],",
        "            relatedPageIds: ['source:deep-lint-source'],",
        "            suggestedQuery: 'Find stronger coverage for this topic'",
        "          }",
        "        ]",
        "      };",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      path.join(rootDir, "web-search-provider.mjs"),
      [
        "export async function createAdapter(id) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    async search(query) {",
        "      return [{ title: 'External Evidence', url: 'https://example.com/evidence', snippet: 'Evidence for ' + query }];",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );

    const configPath = path.join(rootDir, "swarmvault.config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      providers: Record<string, unknown>;
      tasks: Record<string, string>;
      webSearch?: unknown;
    };
    config.providers.lintTest = {
      type: "custom",
      model: "lint-test",
      module: "./lint-provider.mjs",
      capabilities: ["chat", "structured"]
    };
    config.tasks.lintProvider = "lintTest";
    config.webSearch = {
      providers: {
        stub: {
          type: "custom",
          module: "./web-search-provider.mjs"
        }
      },
      tasks: {
        deepLintProvider: "stub"
      }
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const findings = await lintVault(rootDir, { deep: true, web: true });
    const coverageFinding = findings.find((finding) => finding.code === "coverage_gap");
    expect(coverageFinding).toBeTruthy();
    expect(coverageFinding?.evidence?.[0]?.url).toBe("https://example.com/evidence");
  });
});
