import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileVault,
  createMcpServer,
  getGitHookStatus,
  importInbox,
  ingestDirectory,
  ingestInput,
  initVault,
  installAgent,
  installGitHooks,
  lintVault,
  queryVault,
  uninstallGitHooks,
  watchVault
} from "../src/index.js";

const tempDirs: string[] = [];
type ToolContent = Array<{ type?: string; text?: string }>;

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-engine-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition.");
}

async function startFixtureServer(
  routes: Record<string, { status?: number; contentType?: string; body: string | Buffer }>
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const requestUrl = request.url ? new URL(request.url, "http://127.0.0.1") : null;
    const route = requestUrl ? routes[requestUrl.pathname] : undefined;
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const body = typeof route.body === "string" ? Buffer.from(route.body, "utf8") : route.body;
    response.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "text/plain; charset=utf-8",
      "content-length": String(body.length)
    });
    response.end(body);
  });

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const resolved = server.address();
      if (!resolved || typeof resolved === "string") {
        reject(new Error("Failed to bind fixture server."));
        return;
      }
      resolve({ port: resolved.port });
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

function attachmentRelativePath(sourceId: string, storedAttachmentPath: string): string {
  return storedAttachmentPath.replace(new RegExp(`^raw/assets/${sourceId}/`), "");
}

describe("swarmvault workflow", () => {
  it("initializes the workspace and installs agent instructions", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await expect(fs.access(path.join(rootDir, "swarmvault.config.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "swarmvault.schema.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "inbox"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "wiki", "insights", "index.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "state", "sessions"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "AGENTS.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "CLAUDE.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, ".cursor", "rules", "swarmvault.mdc"))).resolves.toBeUndefined();
  });

  it("can initialize an obsidian workspace layout", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir, { obsidian: true });

    await expect(fs.access(path.join(rootDir, ".obsidian", "app.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, ".obsidian", "core-plugins.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, ".obsidian", "graph.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, ".obsidian", "workspace.json"))).resolves.toBeUndefined();
  });

  it("installs agent instructions for goose, pi, opencode, and gemini targets", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const gooseTarget = await installAgent(rootDir, "goose");
    const piTarget = await installAgent(rootDir, "pi");
    const opencodeTarget = await installAgent(rootDir, "opencode");
    const geminiTarget = await installAgent(rootDir, "gemini");

    expect(gooseTarget).toBe(path.join(rootDir, "AGENTS.md"));
    expect(piTarget).toBe(path.join(rootDir, "AGENTS.md"));
    expect(opencodeTarget).toBe(path.join(rootDir, "AGENTS.md"));
    expect(geminiTarget).toBe(path.join(rootDir, "GEMINI.md"));

    const agentsContent = await fs.readFile(gooseTarget, "utf8");
    const geminiContent = await fs.readFile(geminiTarget, "utf8");
    expect(agentsContent).toContain("# SwarmVault Rules");
    expect(agentsContent.match(/swarmvault:managed:start/g)?.length ?? 0).toBe(1);
    expect(geminiContent).toContain("# SwarmVault Rules");
  });

  it("installs Claude rules with an optional graph-first pre-search hook", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const claudeTarget = await installAgent(rootDir, "claude", { claudeHook: true });
    expect(claudeTarget).toBe(path.join(rootDir, "CLAUDE.md"));

    const settingsPath = path.join(rootDir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    expect(settings.hooks?.PreToolUse?.some((entry) => entry.matcher === "Glob|Grep")).toBe(true);
    expect(JSON.stringify(settings)).toContain("wiki/graph/report.md");

    await installAgent(rootDir, "claude", { claudeHook: true });
    const settingsAgain = await fs.readFile(settingsPath, "utf8");
    expect(settingsAgain.match(/Glob\|Grep/g)?.length ?? 0).toBe(1);
  });

  it("installs, reports, and removes git hook blocks idempotently", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.mkdir(path.join(rootDir, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(rootDir, ".git", "hooks", "post-commit"), "#!/bin/sh\necho existing\n", "utf8");

    const installed = await installGitHooks(rootDir);
    expect(installed.repoRoot).toBe(rootDir);
    expect(installed.postCommit).toBe("installed");
    expect(installed.postCheckout).toBe("installed");

    const postCommit = await fs.readFile(path.join(rootDir, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommit).toContain("swarmvault watch --repo --once");
    expect(postCommit).toContain("echo existing");

    const status = await getGitHookStatus(rootDir);
    expect(status.postCommit).toBe("installed");
    expect(status.postCheckout).toBe("installed");

    await installGitHooks(rootDir);
    const postCommitAgain = await fs.readFile(path.join(rootDir, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommitAgain.match(/swarmvault watch --repo --once/g)?.length ?? 0).toBe(1);

    const removed = await uninstallGitHooks(rootDir);
    expect(removed.postCommit).toBe("other_content");
    expect(removed.postCheckout).toBe("not_installed");
    const postCommitAfter = await fs.readFile(path.join(rootDir, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommitAfter).toContain("echo existing");
    expect(postCommitAfter).not.toContain("swarmvault watch --repo --once");
  });

  it("ingests, compiles, queries, and lints using the heuristic provider", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const notePath = path.join(rootDir, "notes.md");
    await fs.writeFile(
      notePath,
      [
        "# Local-First SwarmVault",
        "",
        "SwarmVault keeps raw sources immutable while compiling a linked markdown wiki.",
        "The system does not rely on a hosted backend.",
        "Graph exports make provenance visible."
      ].join("\n"),
      "utf8"
    );

    const manifest = await ingestInput(rootDir, "notes.md");
    expect(manifest.sourceId).toContain("local-first-swarmvault");

    const compile = await compileVault(rootDir);
    expect(compile.pageCount).toBeGreaterThan(0);
    const sourcePagePath = path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`);
    const parsedSourcePage = matter(await fs.readFile(sourcePagePath, "utf8"));
    expect(parsedSourcePage.data.status).toBe("active");
    expect(parsedSourcePage.data.managed_by).toBe("system");
    expect(parsedSourcePage.data.created_at).toBeTruthy();
    expect(parsedSourcePage.data.updated_at).toBeTruthy();
    expect(parsedSourcePage.data.compiled_from).toContain(manifest.sourceId);

    await compileVault(rootDir);
    const reparsedSourcePage = matter(await fs.readFile(sourcePagePath, "utf8"));
    expect(reparsedSourcePage.data.created_at).toBe(parsedSourcePage.data.created_at);

    const query = await queryVault(rootDir, { question: "What does SwarmVault optimize for?" });
    expect(query.answer).toContain("Question:");
    expect(query.savedPath).toBeTruthy();
    expect(query.saved).toBe(true);

    const findings = await lintVault(rootDir);
    expect(findings.some((finding) => finding.code === "graph_missing")).toBe(false);

    const sessionFiles = (await fs.readdir(path.join(rootDir, "state", "sessions"))).filter((file) => file.endsWith(".md"));
    expect(sessionFiles.some((file) => file.includes("-compile-"))).toBe(true);
    expect(sessionFiles.some((file) => file.includes("-query-"))).toBe(true);
    expect(sessionFiles.some((file) => file.includes("-lint-"))).toBe(true);
  });

  it("imports inbox markdown bundles with copied attachments", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const inboxDir = path.join(rootDir, "inbox");
    const assetsDir = path.join(inboxDir, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(
      path.join(inboxDir, "clip.md"),
      ["# Browser Clip", "", "SwarmVault can preserve image references from captured markdown.", "", "![Diagram](assets/diagram.png)"].join(
        "\n"
      ),
      "utf8"
    );
    await fs.writeFile(path.join(assetsDir, "diagram.png"), Buffer.from([0, 1, 2, 3]));

    const result = await importInbox(rootDir);
    expect(result.imported).toHaveLength(1);
    expect(result.attachmentCount).toBe(1);
    expect(result.skipped.some((item) => item.reason === "referenced_attachment")).toBe(true);

    const manifest = result.imported[0];
    expect(manifest.attachments).toHaveLength(1);

    const storedMarkdown = await fs.readFile(path.join(rootDir, manifest.storedPath), "utf8");
    expect(storedMarkdown).toContain(`../assets/${manifest.sourceId}/assets/diagram.png`);
  });

  it("ingests HTML URLs with localized remote image assets", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const routes = {
      "/article": {
        contentType: "text/html; charset=utf-8",
        body: ""
      },
      "/images/relative.png": {
        contentType: "image/png",
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
      },
      "/images/absolute.png": {
        contentType: "image/png",
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6, 7])
      }
    } satisfies Record<string, { status?: number; contentType?: string; body: string | Buffer }>;
    const server = await startFixtureServer(routes);

    try {
      const articleUrl = `${server.baseUrl}/article`;
      routes["/article"].body = [
        "<html><head><title>Remote Article</title></head><body>",
        "<article>",
        "<h1>Remote Article</h1>",
        "<p>SwarmVault localizes remote images during URL ingest.</p>",
        '<img alt="Relative" src="/images/relative.png" />',
        `<img alt="Absolute" src="${server.baseUrl}/images/absolute.png" />`,
        "</article>",
        "</body></html>"
      ].join("");

      const manifest = await ingestInput(rootDir, articleUrl);
      expect(manifest.attachments).toHaveLength(2);

      const storedMarkdown = await fs.readFile(path.join(rootDir, manifest.storedPath), "utf8");
      const attachmentUrls = new Set(manifest.attachments?.map((attachment) => attachment.originalPath));
      expect(attachmentUrls).toEqual(new Set([`${server.baseUrl}/images/relative.png`, `${server.baseUrl}/images/absolute.png`]));
      for (const attachment of manifest.attachments ?? []) {
        expect(storedMarkdown).toContain(`../assets/${manifest.sourceId}/${attachmentRelativePath(manifest.sourceId, attachment.path)}`);
        await expect(fs.access(path.join(rootDir, attachment.path))).resolves.toBeUndefined();
      }
      expect(storedMarkdown).not.toContain("/images/relative.png");
      expect(storedMarkdown).not.toContain(`${server.baseUrl}/images/absolute.png`);
    } finally {
      await server.close();
    }
  });

  it("ingests markdown URLs with localized remote image assets", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const server = await startFixtureServer({
      "/notes.md": {
        contentType: "text/plain; charset=utf-8",
        body: ["# Remote Notes", "", "![Diagram](./images/diagram.png)"].join("\n")
      },
      "/images/diagram.png": {
        contentType: "image/png",
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 8, 9, 10, 11])
      }
    });

    try {
      const manifest = await ingestInput(rootDir, `${server.baseUrl}/notes.md`);
      expect(manifest.sourceKind).toBe("markdown");
      expect(manifest.attachments).toHaveLength(1);

      const attachment = manifest.attachments?.[0];
      const storedMarkdown = await fs.readFile(path.join(rootDir, manifest.storedPath), "utf8");
      expect(storedMarkdown).toContain(
        `../assets/${manifest.sourceId}/${attachmentRelativePath(manifest.sourceId, attachment?.path ?? "")}`
      );
      expect(storedMarkdown).not.toContain("./images/diagram.png");
      await expect(fs.access(path.join(rootDir, attachment?.path ?? ""))).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("skips oversized remote assets without failing URL ingest", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const server = await startFixtureServer({
      "/notes.md": {
        contentType: "text/plain; charset=utf-8",
        body: ["# Large Asset Note", "", "![Oversized](./images/large.png)"].join("\n")
      },
      "/images/large.png": {
        contentType: "image/png",
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      }
    });

    try {
      const manifest = await ingestInput(rootDir, `${server.baseUrl}/notes.md`, { maxAssetSize: 8 });
      expect(manifest.attachments).toBeUndefined();

      const storedMarkdown = await fs.readFile(path.join(rootDir, manifest.storedPath), "utf8");
      expect(storedMarkdown).toContain("./images/large.png");
    } finally {
      await server.close();
    }
  });

  it("threads the schema through compile and query and marks pages stale when the schema changes", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const schemaMarker = "SCHEMA_SENTINEL_RULE";
    await fs.writeFile(
      path.join(rootDir, "swarmvault.schema.md"),
      [
        "# SwarmVault Schema",
        "",
        "## Vault Purpose",
        "",
        "- Track AI governance research.",
        "",
        "## Grounding Rules",
        "",
        `- Always honor ${schemaMarker} during compile and query work.`,
        ""
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      path.join(rootDir, "schema-test-provider.mjs"),
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "",
        "export async function createAdapter(id, config, rootDir) {",
        "  const logDir = path.join(rootDir, 'state');",
        "  async function append(name, payload) {",
        "    await fs.mkdir(logDir, { recursive: true });",
        "    await fs.appendFile(path.join(logDir, name), JSON.stringify(payload) + '\\n', 'utf8');",
        "  }",
        "",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText(request) {",
        "      await append('provider-text.ndjson', request);",
        "      return { text: 'Schema-aware response.' };",
        "    },",
        "    async generateStructured(request) {",
        "      await append('provider-structured.ndjson', request);",
        "      return {",
        "        title: 'Schema Source',",
        "        summary: 'Schema-driven summary.',",
        "        concepts: [{ name: 'Governance', description: 'Governance concept from schema-aware provider.' }],",
        "        entities: [],",
        "        claims: [{ text: 'Schema-aware claim.', confidence: 0.9, status: 'extracted', polarity: 'positive', citation: 'schema-source' }],",
        "        questions: ['What policy applies?']",
        "      };",
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
    };
    config.providers.schemaTest = {
      type: "custom",
      model: "schema-test",
      module: "./schema-test-provider.mjs",
      capabilities: ["chat", "structured"]
    };
    config.tasks.compileProvider = "schemaTest";
    config.tasks.queryProvider = "schemaTest";
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const notePath = path.join(rootDir, "notes.md");
    await fs.writeFile(
      notePath,
      ["# Schema Test", "", "This source exists to verify schema-guided compile and query behavior."].join("\n"),
      "utf8"
    );

    const manifest = await ingestInput(rootDir, "notes.md");
    const compile = await compileVault(rootDir);
    expect(compile.pageCount).toBeGreaterThan(0);

    const structuredLog = await fs.readFile(path.join(rootDir, "state", "provider-structured.ndjson"), "utf8");
    expect(structuredLog).toContain(schemaMarker);

    const sourcePage = await fs.readFile(path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`), "utf8");
    expect(sourcePage).toContain("schema_hash:");

    const query = await queryVault(rootDir, { question: "How should this vault behave?" });
    expect(query.savedPath).toBeTruthy();

    const textLog = await fs.readFile(path.join(rootDir, "state", "provider-text.ndjson"), "utf8");
    expect(textLog).toContain(schemaMarker);

    const savedOutput = await fs.readFile(query.savedPath as string, "utf8");
    expect(savedOutput).toContain("schema_hash:");

    await fs.writeFile(
      path.join(rootDir, "swarmvault.schema.md"),
      [
        "# SwarmVault Schema",
        "",
        "## Vault Purpose",
        "",
        "- Track AI governance research.",
        "",
        "## Grounding Rules",
        "",
        "- Use a different schema revision now.",
        ""
      ].join("\n"),
      "utf8"
    );

    const findings = await lintVault(rootDir);
    expect(findings.some((finding) => finding.code === "stale_page" && finding.message.includes("vault schema changed"))).toBe(true);
  });

  it("normalizes non-canonical deep-lint severity labels from provider output", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "lint-provider.mjs"),
      [
        "import { z } from 'zod';",
        "export async function createAdapter(id, config) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText() { return { text: 'ok' }; },",
        "    async generateStructured(_request, schema) {",
        "      z.toJSONSchema(schema);",
        "      return schema.parse({",
        "        findings: [",
        "          { severity: 'medium', code: 'coverage_gap', message: 'Needs broader coverage.' },",
        "          { severity: 'critical', code: 'missing_citation', message: 'A citation is required.' },",
        "          { severity: 'low', code: 'follow_up_question', message: 'Investigate a related angle.' }",
        "        ]",
        "      });",
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
    };
    config.providers.lintTest = {
      type: "custom",
      model: "lint-test",
      module: "./lint-provider.mjs",
      capabilities: ["chat", "structured"]
    };
    config.tasks.lintProvider = "lintTest";
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    await fs.writeFile(path.join(rootDir, "notes.md"), "# Deep Lint\n\nThis note exists for deep lint severity normalization.", "utf8");
    await ingestInput(rootDir, "notes.md");
    await compileVault(rootDir);

    const findings = await lintVault(rootDir, { deep: true });
    expect(findings.some((finding) => finding.message === "Needs broader coverage." && finding.severity === "warning")).toBe(true);
    expect(findings.some((finding) => finding.message === "A citation is required." && finding.severity === "error")).toBe(true);
    expect(findings.some((finding) => finding.message === "Investigate a related angle." && finding.severity === "info")).toBe(true);
  });

  it("exposes vault operations through the MCP server", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const notePath = path.join(rootDir, "notes.md");
    await fs.writeFile(
      notePath,
      ["# MCP Test Note", "", "SwarmVault exposes wiki search and read operations through MCP."].join("\n"),
      "utf8"
    );

    await ingestInput(rootDir, "notes.md");
    await compileVault(rootDir);

    const server = await createMcpServer(rootDir);
    const client = new Client({ name: "swarmvault-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "workspace_info")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "query_vault")).toBe(true);

    const workspaceInfo = await client.callTool({ name: "workspace_info", arguments: {} });
    const workspaceContent = workspaceInfo.content as ToolContent;
    expect(workspaceContent[0]?.type).toBe("text");
    expect(JSON.parse(workspaceContent[0]?.text ?? "{}").rootDir).toBe(rootDir);
    expect(JSON.parse(workspaceContent[0]?.text ?? "{}").schemaPath).toBe(path.join(rootDir, "swarmvault.schema.md"));

    const searchResults = await client.callTool({ name: "search_pages", arguments: { query: "wiki search", limit: 5 } });
    const searchContent = searchResults.content as ToolContent;
    const parsedSearchResults = JSON.parse(searchContent[0]?.text ?? "[]") as Array<{ title?: string; path?: string }>;
    expect(parsedSearchResults.length).toBeGreaterThan(0);
    expect(typeof parsedSearchResults[0]?.title).toBe("string");
    expect(typeof parsedSearchResults[0]?.path).toBe("string");

    const chartQuery = await client.callTool({
      name: "query_vault",
      arguments: { question: "Show this note as a chart", save: false, format: "chart" }
    });
    const chartContent = chartQuery.content as ToolContent;
    expect(JSON.parse(chartContent[0]?.text ?? "{}").outputFormat).toBe("chart");

    const configResource = await client.readResource({ uri: "swarmvault://config" });
    expect(configResource.contents[0]?.uri).toBe("swarmvault://config");
    expect((configResource.contents[0] as { text: string }).text).toContain('"inboxDir"');

    const schemaResource = await client.readResource({ uri: "swarmvault://schema" });
    expect(schemaResource.contents[0]?.uri).toBe("swarmvault://schema");
    expect((schemaResource.contents[0] as { text: string }).text).toContain("# SwarmVault Schema");

    const sessionsResource = await client.readResource({ uri: "swarmvault://sessions" });
    expect((sessionsResource.contents[0] as { text: string }).text).toContain("compile");

    await client.close();
    await server.close();
  });

  it("watches the inbox and records automation runs", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const controller = await watchVault(rootDir, { lint: true, debounceMs: 100 });

    try {
      await fs.writeFile(
        path.join(rootDir, "inbox", "watch.md"),
        ["# Watch Note", "", "SwarmVault should import and compile this file when watch mode is running."].join("\n"),
        "utf8"
      );

      await waitFor(async () => {
        const graphPath = path.join(rootDir, "state", "graph.json");
        const jobsPath = path.join(rootDir, "state", "jobs.ndjson");
        return (
          (await fs
            .stat(graphPath)
            .then(() => true)
            .catch(() => false)) &&
          (await fs
            .stat(jobsPath)
            .then(() => true)
            .catch(() => false))
        );
      }, 19_000);

      const jobsLog = await fs.readFile(path.join(rootDir, "state", "jobs.ndjson"), "utf8");
      const runs = jobsLog
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { success: boolean; importedCount: number });

      expect(runs.length).toBeGreaterThan(0);
      expect(runs.at(-1)?.success).toBe(true);
      expect(runs.at(-1)?.importedCount).toBe(1);

      const sessionFiles = (await fs.readdir(path.join(rootDir, "state", "sessions"))).filter((file) => file.endsWith(".md"));
      expect(sessionFiles.some((file) => file.includes("-watch-"))).toBe(true);
    } finally {
      await controller.close();
    }
  }, 25_000);

  it("watches tracked repos and recompiles code changes", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.mkdir(path.join(rootDir, "repo", ".git"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "repo", "src", "util.py"), "def helper(name):\n    return name.upper()\n", "utf8");
    await fs.writeFile(
      path.join(rootDir, "repo", "src", "app.py"),
      ["from .util import helper", "", "def run(name):", "    return helper(name)"].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, "repo");
    const utilManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("src/util.py"));
    await compileVault(rootDir);

    const controller = await watchVault(rootDir, { repo: true, debounceMs: 100 });
    try {
      await fs.writeFile(path.join(rootDir, "repo", "src", "util.py"), "def helper(name):\n    return f'watched:{name}'\n", "utf8");

      await waitFor(async () => {
        const modulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${utilManifest?.sourceId}.md`), "utf8");
        return modulePage.includes("watched");
      }, 19_000);

      const jobsLog = await fs.readFile(path.join(rootDir, "state", "jobs.ndjson"), "utf8");
      const runs = jobsLog
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { success: boolean; importedCount: number });
      expect(runs.at(-1)?.success).toBe(true);
      expect((runs.at(-1)?.importedCount ?? 0) > 0).toBe(true);
    } finally {
      await controller.close();
    }
  }, 25_000);
});
