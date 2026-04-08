import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import {
  addInput,
  benchmarkVault,
  compileVault,
  createMcpServer,
  explainGraphVault,
  exportGraphFormat,
  getGitHookStatus,
  getWatchStatus,
  importInbox,
  ingestDirectory,
  ingestInput,
  initVault,
  installAgent,
  installGitHooks,
  lintVault,
  queryGraphVault,
  queryVault,
  runWatchCycle,
  uninstallGitHooks,
  watchVault
} from "../src/index.js";
import type { GraphArtifact, SourceAnalysis, SourceExtractionArtifact } from "../src/types.js";

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

async function updateConfig(
  rootDir: string,
  mutate: (config: { providers: Record<string, unknown>; tasks: Record<string, string> }) => void
): Promise<void> {
  const configPath = path.join(rootDir, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    providers: Record<string, unknown>;
    tasks: Record<string, string>;
  };
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function createSimplePdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

const MINIMAL_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

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

  it("extracts PDF text into markdown and extraction metadata sidecars", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const pdfPath = path.join(rootDir, "paper.pdf");
    await fs.writeFile(pdfPath, createSimplePdf("SwarmVault PDF extraction turns papers into searchable text."), "binary");

    const manifest = await ingestInput(rootDir, "paper.pdf");
    expect(manifest.sourceKind).toBe("pdf");
    expect(manifest.extractedTextPath).toBeTruthy();
    expect(manifest.extractedMetadataPath).toBeTruthy();
    expect(manifest.extractionHash).toBeTruthy();

    const extractedText = await fs.readFile(path.join(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("SwarmVault PDF extraction");

    const extractionArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, manifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(extractionArtifact.extractor).toBe("pdf_text");
    expect(extractionArtifact.pageCount).toBe(1);

    await compileVault(rootDir);
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.summary).not.toContain("Text extraction is not yet available");
    expect(analysis.summary).toContain("SwarmVault PDF extraction");
    expect(analysis.extractionHash).toBe(manifest.extractionHash);
  });

  it("uses the configured vision provider to analyze image sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "vision-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['structured', 'vision']),",
        "    async generateText() {",
        "      return { text: 'vision-provider-text' };",
        "    },",
        "    async generateStructured(_request, schema) {",
        "      return schema.parse({",
        "        title: 'Deployment Diagram',",
        "        summary: 'The image shows a queue-backed deployment pipeline.',",
        "        text: 'Browser -> API -> Queue -> Worker',",
        "        concepts: [{ name: 'Queue', description: 'A queue connecting the API and worker.' }],",
        "        entities: [{ name: 'API', description: 'The visible API node.' }],",
        "        claims: [{ text: 'The pipeline routes work through a queue.', confidence: 0.88, polarity: 'positive' }],",
        "        questions: ['What system drains the queue?']",
        "      });",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );

    await updateConfig(rootDir, (config) => {
      config.providers.visionTest = {
        type: "custom",
        model: "vision-test",
        module: "./vision-provider.mjs",
        capabilities: ["structured", "vision"]
      };
      config.tasks.visionProvider = "visionTest";
    });

    await fs.writeFile(path.join(rootDir, "diagram.png"), MINIMAL_PNG);
    const manifest = await ingestInput(rootDir, "diagram.png");
    expect(manifest.sourceKind).toBe("image");
    expect(manifest.title).toBe("Deployment Diagram");
    expect(manifest.extractedTextPath).toBeTruthy();
    expect(manifest.extractedMetadataPath).toBeTruthy();
    expect(manifest.extractionHash).toBeTruthy();

    const extractionArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, manifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(extractionArtifact.extractor).toBe("image_vision");
    expect(extractionArtifact.providerId).toBe("visionTest");
    expect(extractionArtifact.vision?.summary).toContain("queue-backed deployment pipeline");

    await compileVault(rootDir);
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.title).toBe("Deployment Diagram");
    expect(analysis.summary).toContain("queue-backed deployment pipeline");
    expect(analysis.claims.some((claim) => claim.text.includes("routes work through a queue"))).toBe(true);
    expect(analysis.entities.some((entity) => entity.name === "API")).toBe(true);
    expect(analysis.extractionHash).toBe(manifest.extractionHash);
  });

  it("records explicit extraction warnings when no real vision provider is configured", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "whiteboard.png"), MINIMAL_PNG);
    const manifest = await ingestInput(rootDir, "whiteboard.png");
    expect(manifest.sourceKind).toBe("image");
    expect(manifest.extractedTextPath).toBeUndefined();
    expect(manifest.extractedMetadataPath).toBeTruthy();

    const extractionArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, manifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(extractionArtifact.warnings?.[0]).toContain("Vision extraction unavailable");

    await compileVault(rootDir);
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.summary).toContain("Vision extraction unavailable");
    expect(analysis.summary).not.toContain("Text extraction is not yet available");
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

  it("captures arXiv ids, DOI/article URLs, and tweet URLs through the add workflow", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://arxiv.org/abs/2401.12345") {
        return new Response(
          [
            "<html><head>",
            '<meta name="citation_title" content="Parser-First Vaults" />',
            '<meta name="citation_author" content="Ada Lovelace" />',
            '<meta name="citation_author" content="Grace Hopper" />',
            "</head><body>",
            '<blockquote class="abstract">Abstract: Parser-backed ingest keeps graphs grounded.</blockquote>',
            "</body></html>"
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      if (url === "https://doi.org/10.5555/swarmvault-doi" || url === "https://doi.org/10.5555%2Fswarmvault-doi") {
        return new Response(
          [
            "<html><head>",
            '<link rel="canonical" href="https://papers.example/swarmvault-study" />',
            '<meta name="citation_title" content="SwarmVault DOI Capture" />',
            '<meta name="citation_author" content="Leslie Lamport" />',
            '<meta name="citation_doi" content="10.5555/swarmvault-doi" />',
            '<meta name="keywords" content="knowledge graphs, parser-first" />',
            "</head><body>",
            "<article><p>DOI redirects should normalize into research captures.</p></article>",
            "</body></html>"
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      if (url === "https://papers.example/swarmvault-study") {
        return new Response(
          [
            "<html><head>",
            '<link rel="canonical" href="https://papers.example/swarmvault-study" />',
            '<meta property="og:title" content="SwarmVault DOI Capture" />',
            '<meta name="citation_author" content="Leslie Lamport" />',
            '<meta name="citation_doi" content="10.5555/swarmvault-doi" />',
            '<meta name="keywords" content="knowledge graphs, parser-first" />',
            "</head><body>",
            "<article><p>Resolved DOI landing pages should become normalized markdown captures.</p></article>",
            "</body></html>"
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      if (url === "https://example.test/article") {
        return new Response(
          [
            "<html><head>",
            '<link rel="canonical" href="https://example.test/article" />',
            '<meta property="og:title" content="Article Capture" />',
            '<meta name="author" content="Grace Hopper" />',
            '<meta property="article:published_time" content="2026-04-08T09:00:00Z" />',
            '<meta name="keywords" content="agents, vaults" />',
            "</head><body>",
            "<article><p>Generic research article URLs should become normalized markdown captures too.</p></article>",
            "</body></html>"
          ].join(""),
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      if (url.startsWith("https://publish.twitter.com/oembed")) {
        return new Response(
          JSON.stringify({
            author_name: "Graph Agent",
            html: "<blockquote><p>Watch mode should flag semantic refresh instead of silently ingesting docs.</p></blockquote>"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" }
          }
        );
      }
      return originalFetch(input as never);
    }) as typeof globalThis.fetch;

    try {
      const arxiv = await addInput(rootDir, "2401.12345", { author: "Wayde" });
      const doi = await addInput(rootDir, "10.5555/swarmvault-doi");
      const article = await addInput(rootDir, "https://example.test/article", { contributor: "SwarmVault" });
      const tweet = await addInput(rootDir, "https://x.com/example/status/1234567890", { contributor: "SwarmVault" });

      expect(arxiv.captureType).toBe("arxiv");
      expect(arxiv.fallback).toBe(false);
      expect(arxiv.normalizedUrl).toBe("https://arxiv.org/abs/2401.12345");
      const arxivStored = matter(await fs.readFile(path.join(rootDir, arxiv.manifest.storedPath), "utf8"));
      expect(arxivStored.data.source_type).toBe("arxiv");
      expect(arxivStored.content).toContain("## Abstract");

      expect(doi.captureType).toBe("doi");
      expect(doi.fallback).toBe(false);
      expect(doi.normalizedUrl).toBe("https://papers.example/swarmvault-study");
      const doiStored = matter(await fs.readFile(path.join(rootDir, doi.manifest.storedPath), "utf8"));
      expect(doiStored.data.source_type).toBe("doi");
      expect(doiStored.data.doi).toBe("10.5555/swarmvault-doi");
      expect(doiStored.data.canonical_url).toBe("https://papers.example/swarmvault-study");
      expect(doiStored.data.tags).toEqual(["knowledge graphs", "parser-first"]);

      expect(article.captureType).toBe("article");
      expect(article.fallback).toBe(false);
      const articleStored = matter(await fs.readFile(path.join(rootDir, article.manifest.storedPath), "utf8"));
      expect(articleStored.data.source_type).toBe("article");
      expect(articleStored.data.authors).toEqual(["Grace Hopper"]);
      expect(articleStored.data.tags).toEqual(["agents", "vaults"]);

      expect(tweet.captureType).toBe("tweet");
      expect(tweet.fallback).toBe(false);
      const tweetStored = matter(await fs.readFile(path.join(rootDir, tweet.manifest.storedPath), "utf8"));
      expect(tweetStored.data.source_type).toBe("tweet");
      expect(tweetStored.content).toContain("## Content");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("can save a query after add fallback without compiling the captured source first", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://example.test/capture.md") {
        return new Response(["# Captured Link", "", "Durable outputs should stay on disk."].join("\n"), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      }
      return originalFetch(input as never);
    }) as typeof globalThis.fetch;

    try {
      await fs.writeFile(path.join(rootDir, "note.md"), "# Existing Note\n\nSwarmVault saves outputs into wiki/outputs.\n", "utf8");
      await ingestInput(rootDir, "note.md");
      await compileVault(rootDir);

      const added = await addInput(rootDir, "https://example.test/capture.md");
      expect(added.captureType).toBe("url");
      expect(added.fallback).toBe(true);

      const result = await queryVault(rootDir, {
        question: "What does this vault say about durable outputs?"
      });
      expect(result.savedPath).toBeTruthy();
      expect(await fs.readFile(result.savedPath ?? "", "utf8")).toContain("durable outputs");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("writes benchmark artifacts and exports svg, graphml, and cypher graph files", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "note.md"),
      ["# Durable Graphs", "", "SwarmVault benchmarks graph-guided context against whole-corpus reads."].join("\n"),
      "utf8"
    );
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    const autoBenchmarkArtifact = JSON.parse(await fs.readFile(path.join(rootDir, "state", "benchmark.json"), "utf8")) as {
      graphHash: string;
      sampleQuestions: string[];
      summary: { reductionRatio: number };
    };
    expect(autoBenchmarkArtifact.graphHash).toBeTruthy();
    expect(autoBenchmarkArtifact.sampleQuestions.length).toBeGreaterThan(0);
    expect(autoBenchmarkArtifact.summary.reductionRatio).toBeGreaterThanOrEqual(0);

    const autoGraphReportArtifact = JSON.parse(await fs.readFile(path.join(rootDir, "wiki", "graph", "report.json"), "utf8")) as {
      benchmark?: { stale: boolean; summary: { reductionRatio: number } };
      overview: { nodes: number };
      suggestedQuestions: string[];
    };
    expect(autoGraphReportArtifact.overview.nodes).toBeGreaterThan(0);
    expect(autoGraphReportArtifact.benchmark?.stale).toBe(false);
    expect(autoGraphReportArtifact.benchmark?.summary.reductionRatio).toBeGreaterThanOrEqual(0);
    expect(autoGraphReportArtifact.suggestedQuestions.length).toBeGreaterThan(0);

    const benchmark = await benchmarkVault(rootDir, {
      questions: ["How does this vault describe graph-guided context reduction?"]
    });
    expect(benchmark.sampleQuestions).toHaveLength(1);
    expect(benchmark.avgQueryTokens).toBeGreaterThan(0);

    const benchmarkArtifact = JSON.parse(await fs.readFile(path.join(rootDir, "state", "benchmark.json"), "utf8")) as {
      sampleQuestions: string[];
    };
    expect(benchmarkArtifact.sampleQuestions).toEqual(benchmark.sampleQuestions);

    const graphReport = await fs.readFile(path.join(rootDir, "wiki", "graph", "report.md"), "utf8");
    expect(graphReport).toContain("## Benchmark Summary");
    expect(graphReport).toContain("Reduction Ratio");
    expect(graphReport).toContain("## Suggested Questions");

    const exportsDir = path.join(rootDir, "exports");
    const svg = await exportGraphFormat(rootDir, "svg", path.join(exportsDir, "graph.svg"));
    const graphml = await exportGraphFormat(rootDir, "graphml", path.join(exportsDir, "graph.graphml"));
    const cypher = await exportGraphFormat(rootDir, "cypher", path.join(exportsDir, "graph.cypher"));

    expect(await fs.readFile(svg.outputPath, "utf8")).toContain("<svg");
    expect(await fs.readFile(graphml.outputPath, "utf8")).toContain("<graphml");
    expect(await fs.readFile(cypher.outputPath, "utf8")).toContain("MERGE (n:SwarmNode");
  });

  it("enriches the graph with semantic similarity, group patterns, and richer graph-tool metadata", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "graph-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  function payload(title) {",
        "    if (title.includes('Alpha')) {",
        "      return { title, summary: 'Alpha summary.', concepts: [{ name: 'Parser First', description: 'Parser-first workflow.' }, { name: 'Trust Surfaces', description: 'Trust-oriented reporting.' }], entities: [{ name: 'SwarmVault', description: 'SwarmVault project.' }], claims: [{ text: 'Alpha links parser-first analysis to trust surfaces.', confidence: 0.92, status: 'extracted', polarity: 'positive', citation: 'alpha' }], questions: ['How do parser-first trust surfaces improve graph quality?'] };",
        "    }",
        "    if (title.includes('Beta')) {",
        "      return { title, summary: 'Beta summary.', concepts: [{ name: 'Parser First', description: 'Parser-first workflow.' }, { name: 'Graph Reports', description: 'Graph report generation.' }], entities: [{ name: 'SwarmVault', description: 'SwarmVault project.' }], claims: [{ text: 'Beta links parser-first analysis to graph reports.', confidence: 0.9, status: 'extracted', polarity: 'positive', citation: 'beta' }], questions: ['What makes graph reports trustworthy?'] };",
        "    }",
        "    return { title, summary: 'Gamma summary.', concepts: [{ name: 'Parser First', description: 'Parser-first workflow.' }, { name: 'Watch Reporting', description: 'Watch-driven reporting.' }], entities: [{ name: 'SwarmVault', description: 'SwarmVault project.' }], claims: [{ text: 'Gamma links parser-first analysis to watch reporting.', confidence: 0.91, status: 'extracted', polarity: 'positive', citation: 'gamma' }], questions: ['Which watch signals are structural?'] };",
        "  }",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
        "    async generateText() { return { text: 'ok' }; },",
        "    async generateStructured(request, schema) {",
        "      const match = request.prompt.match(/Source title: (.+)/);",
        "      const title = match ? match[1].trim() : 'Unknown';",
        "      return schema.parse(payload(title));",
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
    config.providers.graphTest = {
      type: "custom",
      model: "graph-test",
      module: "./graph-provider.mjs",
      capabilities: ["chat", "structured"]
    };
    config.tasks.compileProvider = "graphTest";
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    for (const [name, body] of [
      ["alpha.md", "# Alpha Source\n\nParser-first trust surfaces create durable graph reports."],
      ["beta.md", "# Beta Source\n\nParser-first graph reports reveal cross-community structure."],
      ["gamma.md", "# Gamma Source\n\nParser-first watch reporting improves graph trust."]
    ] as const) {
      await fs.writeFile(path.join(rootDir, name), body, "utf8");
      await ingestInput(rootDir, name);
    }

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const similarityEdges = graph.edges.filter((edge) => edge.relation === "semantically_similar_to");
    expect(similarityEdges.length).toBeGreaterThan(0);
    expect(similarityEdges[0]?.similarityReasons?.length).toBeGreaterThan(0);
    expect(graph.hyperedges.length).toBeGreaterThan(0);
    expect(graph.hyperedges.some((hyperedge) => hyperedge.relation === "participate_in")).toBe(true);

    const report = JSON.parse(await fs.readFile(path.join(rootDir, "wiki", "graph", "report.json"), "utf8")) as {
      groupPatterns: Array<{ why: string; nodeIds: string[] }>;
      surprisingConnections: Array<{ why: string; pathRelations: string[]; pathEvidenceClasses: string[] }>;
    };
    expect(report.groupPatterns.length).toBeGreaterThan(0);
    expect(report.groupPatterns[0]?.why).toContain("source nodes");
    expect(report.surprisingConnections.some((connection) => connection.why.length > 0 && connection.pathRelations.length > 0)).toBe(true);

    const queryResult = await queryGraphVault(rootDir, "parser-first graph trust", { budget: 10 });
    expect(queryResult.hyperedgeIds.length).toBeGreaterThan(0);

    const explainResult = await explainGraphVault(rootDir, similarityEdges[0]?.source ?? "");
    expect(explainResult.hyperedges.length).toBeGreaterThan(0);

    const exportsDir = path.join(rootDir, "exports");
    const graphml = await exportGraphFormat(rootDir, "graphml", path.join(exportsDir, "graph.graphml"));
    const cypher = await exportGraphFormat(rootDir, "cypher", path.join(exportsDir, "graph.cypher"));
    expect(await fs.readFile(graphml.outputPath, "utf8")).toContain("hyperedge:");
    expect(await fs.readFile(graphml.outputPath, "utf8")).toContain("group_member");
    expect(await fs.readFile(cypher.outputPath, "utf8")).toContain("GROUP_MEMBER");
    expect(await fs.readFile(cypher.outputPath, "utf8")).toContain("similarityReasons");

    const server = await createMcpServer(rootDir);
    const client = new Client({ name: "swarmvault-graph-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "graph_report")).toBe(true);
    expect(tools.tools.some((tool) => tool.name === "get_hyperedges")).toBe(true);

    const graphReport = await client.callTool({ name: "graph_report", arguments: {} });
    const graphReportContent = graphReport.content as ToolContent;
    expect(JSON.parse(graphReportContent[0]?.text ?? "{}").groupPatterns.length).toBeGreaterThan(0);

    const hyperedgeTool = await client.callTool({ name: "get_hyperedges", arguments: { limit: 5 } });
    const hyperedgeContent = hyperedgeTool.content as ToolContent;
    expect(JSON.parse(hyperedgeContent[0]?.text ?? "[]").length).toBeGreaterThan(0);

    await client.close();
    await server.close();
  });

  it("uses configured embeddings for semantic graph query, cache artifacts, and inferred similarity edges", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "embedding-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  function payload(title) {",
        "    if (title.includes('Alpha')) {",
        "      return { title, summary: 'Durable memory keeps agent context persistent.', concepts: [{ name: 'Long-Term Recall', description: 'A durable memory loop.' }], entities: [], claims: [{ text: 'Alpha documents durable memory behavior.', confidence: 0.9, status: 'extracted', polarity: 'positive', citation: 'alpha' }], questions: [] };",
        "    }",
        "    if (title.includes('Beta')) {",
        "      return { title, summary: 'Persistent context helps agents recover prior work.', concepts: [{ name: 'Context Continuity', description: 'Recovering prior context.' }], entities: [], claims: [{ text: 'Beta documents persistent context behavior.', confidence: 0.91, status: 'extracted', polarity: 'positive', citation: 'beta' }], questions: [] };",
        "    }",
        "    return { title, summary: 'Review queues keep edits inspectable.', concepts: [{ name: 'Review Queue', description: 'Review gates for generated edits.' }], entities: [], claims: [{ text: 'Gamma documents review queues.', confidence: 0.88, status: 'extracted', polarity: 'positive', citation: 'gamma' }], questions: [] };",
        "  }",
        "  function vectorFor(text) {",
        "    const normalized = String(text).toLowerCase();",
        "    if (normalized.includes('durable memory') || normalized.includes('persistent context') || normalized.includes('compounding memory')) {",
        "      return [1, 0, 0];",
        "    }",
        "    if (normalized.includes('review queue')) {",
        "      return [0, 1, 0];",
        "    }",
        "    return [0, 0, 1];",
        "  }",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(config.capabilities ?? ['chat', 'structured', 'embeddings']),",
        "    async generateText() { return { text: 'ok' }; },",
        "    async generateStructured(request, schema) {",
        "      const match = request.prompt.match(/Source title: (.+)/);",
        "      const title = match ? match[1].trim() : 'Unknown';",
        "      return schema.parse(payload(title));",
        "    },",
        "    async embedTexts(texts) {",
        "      return texts.map((text) => vectorFor(text));",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );

    await updateConfig(rootDir, (config) => {
      config.providers.semanticTest = {
        type: "custom",
        model: "semantic-test",
        module: "./embedding-provider.mjs",
        capabilities: ["chat", "structured", "embeddings"]
      };
      config.tasks.compileProvider = "semanticTest";
      config.tasks.embeddingProvider = "semanticTest";
    });

    for (const [name, body] of [
      ["alpha.md", "# Alpha Source\n\nDurable memory keeps agent context alive."],
      ["beta.md", "# Beta Source\n\nPersistent context helps an agent resume prior work."],
      ["gamma.md", "# Gamma Source\n\nReview queue gates keep edits inspectable."]
    ] as const) {
      await fs.writeFile(path.join(rootDir, name), body, "utf8");
      await ingestInput(rootDir, name);
    }

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.edges.some((edge) => edge.relation === "semantically_similar_to" && edge.similarityBasis === "embeddings")).toBe(true);

    const embeddingCache = JSON.parse(await fs.readFile(path.join(rootDir, "state", "embeddings.json"), "utf8")) as {
      entries?: Array<{ id: string; hash: string }>;
    };
    expect(Array.isArray(embeddingCache.entries)).toBe(true);
    expect(embeddingCache.entries?.length ?? 0).toBeGreaterThan(0);

    const semanticQuery = await queryGraphVault(rootDir, "compounding memory", { budget: 8 });
    expect(semanticQuery.matches.some((match) => match.label.includes("Alpha Source") || match.label.includes("Beta Source"))).toBe(true);
  });

  it("classifies repo material by source class and keeps graph reporting focused on first-party content", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "repo", "src"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "Pods"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "App.xcassets"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "dist"), { recursive: true });

    await fs.writeFile(path.join(rootDir, "repo", "src", "app.ts"), "export function main(): string { return 'ok'; }\n", "utf8");
    await fs.writeFile(path.join(rootDir, "repo", "Pods", "vendor.ts"), "export const vendorValue = 1;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "repo", "App.xcassets", "Reference.pdf"), createSimplePdf("Bundled PDF resource"));
    await fs.writeFile(path.join(rootDir, "repo", "dist", "generated.js"), "console.log('generated');\n", "utf8");

    const defaultIngest = await ingestDirectory(rootDir, "repo");
    expect(defaultIngest.imported).toHaveLength(1);
    expect(defaultIngest.imported[0]?.repoRelativePath).toBe("src/app.ts");
    expect(defaultIngest.imported[0]?.sourceClass).toBe("first_party");
    expect(
      defaultIngest.skipped.some((entry) => entry.path.endsWith("repo/Pods/vendor.ts") && entry.reason === "source_class:third_party")
    ).toBe(true);
    expect(
      defaultIngest.skipped.some(
        (entry) => entry.path.endsWith("repo/App.xcassets/Reference.pdf") && entry.reason === "source_class:resource"
      )
    ).toBe(true);
    expect(
      defaultIngest.skipped.some((entry) => entry.path.endsWith("repo/dist/generated.js") && entry.reason === "source_class:generated")
    ).toBe(true);

    const fullIngest = await ingestDirectory(rootDir, "repo", {
      extractClasses: ["first_party", "third_party", "resource", "generated"]
    });
    const manifestsByRepoPath = new Map(
      [...fullIngest.imported, ...fullIngest.updated].map((manifest) => [manifest.repoRelativePath, manifest] as const)
    );
    expect(manifestsByRepoPath.get("Pods/vendor.ts")?.sourceClass).toBe("third_party");
    expect(manifestsByRepoPath.get("App.xcassets/Reference.pdf")?.sourceClass).toBe("resource");
    expect(manifestsByRepoPath.get("dist/generated.js")?.sourceClass).toBe("generated");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.sources.some((source) => source.sourceClass === "third_party")).toBe(true);
    expect(graph.sources.some((source) => source.sourceClass === "resource")).toBe(true);
    expect(graph.sources.some((source) => source.sourceClass === "generated")).toBe(true);

    const report = JSON.parse(await fs.readFile(path.join(rootDir, "wiki", "graph", "report.json"), "utf8")) as {
      overview: { nodes: number };
      firstPartyOverview: { nodes: number };
      sourceClassBreakdown: Record<string, { sources: number }>;
      warnings: string[];
    };
    expect(report.firstPartyOverview.nodes).toBeLessThan(report.overview.nodes);
    expect(report.sourceClassBreakdown.third_party.sources).toBeGreaterThan(0);
    expect(report.sourceClassBreakdown.resource.sources).toBeGreaterThan(0);
    expect(report.sourceClassBreakdown.generated.sources).toBeGreaterThan(0);
    expect(report.warnings.length).toBeGreaterThan(0);
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
        const jobsLog = await fs
          .readFile(path.join(rootDir, "state", "jobs.ndjson"), "utf8")
          .then((value) => value.trim())
          .catch(() => "");
        return modulePage.includes("watched") && jobsLog.length > 0;
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

  it("flags pending semantic refresh for tracked non-code repo changes", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "repo", ".git"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "docs"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "repo", "docs", "guide.md"),
      ["# Repo Guide", "", "Initial repo documentation."].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, "repo");
    const guideManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("docs/guide.md"));
    expect(guideManifest).toBeTruthy();
    await compileVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "repo", "docs", "guide.md"),
      ["# Repo Guide", "", "Updated repo documentation that needs semantic refresh."].join("\n"),
      "utf8"
    );

    const cycle = await runWatchCycle(rootDir, { repo: true, debounceMs: 50 });
    expect(cycle.pendingSemanticRefreshCount).toBe(1);
    expect(cycle.pendingSemanticRefreshPaths.some((entry) => entry.endsWith("repo/docs/guide.md"))).toBe(true);

    const watchStatus = await getWatchStatus(rootDir);
    expect(watchStatus.pendingSemanticRefresh).toHaveLength(1);
    expect(watchStatus.pendingSemanticRefresh[0]?.path).toBe("repo/docs/guide.md");

    const sourcePage = matter(await fs.readFile(path.join(rootDir, "wiki", "sources", `${guideManifest?.sourceId}.md`), "utf8"));
    expect(sourcePage.data.freshness).toBe("stale");
  });
});
