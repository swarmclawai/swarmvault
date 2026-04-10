import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync } from "fflate";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { semanticGraphMatches } from "../src/embeddings.js";
import {
  addInput,
  addManagedSource,
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
  ingestInputDetailed,
  initVault,
  installAgent,
  installGitHooks,
  lintVault,
  listApprovals,
  queryGraphVault,
  queryVault,
  readApproval,
  readPage,
  runWatchCycle,
  searchVault,
  uninstallGitHooks,
  watchVault
} from "../src/index.js";
import { buildGraphReportArtifact } from "../src/markdown.js";
import type { GraphArtifact, SourceAnalysis, SourceExtractionArtifact } from "../src/types.js";

const tempDirs: string[] = [];
type ToolContent = Array<{ type?: string; text?: string }>;

async function runNodeScript(scriptPath: string, args: string[], input: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [scriptPath, ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`node ${scriptPath} exited with ${code}: ${stderr || stdout}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

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

async function withPrivateUrlAllowance<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SWARMVAULT_ALLOW_PRIVATE_URLS;
  process.env.SWARMVAULT_ALLOW_PRIVATE_URLS = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SWARMVAULT_ALLOW_PRIVATE_URLS;
    } else {
      process.env.SWARMVAULT_ALLOW_PRIVATE_URLS = previous;
    }
  }
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

  const listen = async (host?: string): Promise<{ port: number }> =>
    await new Promise<{ port: number }>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const resolved = server.address();
        if (!resolved || typeof resolved === "string") {
          reject(new Error("Failed to bind fixture server."));
          return;
        }
        resolve({ port: resolved.port });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      if (host) {
        server.listen(0, host);
      } else {
        server.listen(0);
      }
    });

  let address: { port: number };
  try {
    address = await listen("127.0.0.1");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("EPERM")) {
      throw error;
    }
    address = await listen();
  }

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
const MINIMAL_DOCX = Buffer.from(
  "UEsDBBQAAAAIAPiQiFzT44oSCAEAAC0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbJVRS07DMBDd9xSWtyhxYIEQStIFnyV0UQ4wciaJhX/yuKW9PZMWAkItUpfW+/pNvdw5K7aYyATfyOuykgK9Dp3xQyPf1s/FnRSUwXdgg8dG7pHksl3U631EEiz21Mgx53ivFOkRHVAZInpG+pAcZH6mQUXQ7zCguqmqW6WDz+hzkScP2S6EqB+xh43N4mnHyLFLQktSPBy5U1wjIUZrNGTG1dZ3f4KKr5CSlQcOjSbSFROkOhcygeczfqSvPFEyHYoVpPwCjonqI6ROdUFvHIvL/51OtA19bzTO+sktpqCRiLd3tpwRB8b/+sWpKsxdpRCJp014eZXv4SZ1wSUipmxwnq5Wh2u3n1BLAwQUAAAACAD4kIhcFfb2GtcAAADCAQAACwAAAF9yZWxzLy5yZWxzjZBLSwNBDIDv/RVD7t3Z9iAiO9uLCL2J1B8QZrIP3HmQiY/+e4OoWLHYY15fvqTbvcXFvBDXOScHm6YFQ8nnMKfRwePhbn0NpgqmgEtO5OBIFXb9qnugBUVn6jSXahSSqoNJpNxYW/1EEWuTCyWtDJkjioY82oL+CUey27a9svyTAf3KmBOs2QcHvA8bMIdj0d3/4/MwzJ5us3+OlOSPLb86lIw8kjh4zRxs+Ew3igV7Vmh7udD5e20kwYCC1memdWGdZpn1vd9OqnOv6frR8eXU2ZPX9+9QSwMEFAAAAAgA+JCIXB+BgtlYAQAAnQIAABEAAABkb2NQcm9wcy9jb3JlLnhtbKWSQWvCMBTH7/sUIWdrWh0iRetB8bSxgd0mu4XkqcEmKclztd9+abWdgrdBL+X/ez/eP7zZ4qwL8gPOK2vmNBnGlIARViqzn9OPfB1NKfHIjeSFNTCnNXi6yJ5mokyFdfDubAkOFXgSRManopzTA2KZMubFATT3w0CYEO6s0xzDr9uzkosj3wMbxfGEaUAuOXLWCKOyN9KrUopeWZ5c0QqkYFCABoOeJcOE/bEITvuHA21yQ2qFdRkqPUC7sKfPXvVgVVXDatyiYf+EbV9fNm3VSJnmqQTQ7ImQmRQpKiwgy5WpyeptuSUbe3ICZsF/ja6ccMDRumxTcac/+alAkoNH35Jd2LDh2Y9QV9ZJn0krzgOCQT4gO3XGk4MwcEtc7G3viwUkCU3SS+8u+RovV/maZqN4NIni5yie5skojePwfTcL3M3fOXW4k536h7QThINqFr+/qOwXUEsDBBQAAAAIAPiQiFwatoKR/AAAAKoBAAARAAAAd29yZC9kb2N1bWVudC54bWyNUMtqwzAQvOcrFt0bpT2UYmzn0NJToYW60Ota2sQCSWu0chz/feWE3ErpZdjXzCxT78/Bw4mSOI6Nut/uFFA0bF08Nuqre717UiAZo0XPkRq1kKh9u6nnyrKZAsUMRSFKNTdqyHmstBYzUEDZ8kix7A6cAubSpqOeOdkxsSGRYhC8ftjtHnVAF1W7ASiqPdtlLS/N2BZIK+S2c3GBl/fnb/jkKRmq9TpdsRwUHH9lvbFBf6UdnCcBGXjyFuicE5oMidBi7wlymUBP5VkCjOgXcbL9n0c30HLTRS8MYyKhdCLoUZyBQLmYZPxDTsjkjwT6EkLZXFNYq1vK7Q9QSwECFAAUAAAACAD4kIhc0+OKEggBAAAtAgAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAIAPiQiFwV9vYa1wAAAMIBAAALAAAAAAAAAAAAAAAAADkBAABfcmVscy8ucmVsc1BLAQIUABQAAAAIAPiQiFwfgYLZWAEAAJ0CAAARAAAAAAAAAAAAAAAAADkCAABkb2NQcm9wcy9jb3JlLnhtbFBLAQIUABQAAAAIAPiQiFwatoKR/AAAAKoBAAARAAAAAAAAAAAAAAAAAMADAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABAAEAPgAAADrBAAAAAA=",
  "base64"
);

async function createSimpleXlsx(): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const overview = XLSX.utils.aoa_to_sheet([
    ["Metric", "Value"],
    ["Users", 12],
    ["Status", "stable"]
  ]);
  const trends = XLSX.utils.aoa_to_sheet([
    ["Week", "Signups"],
    ["Week 1", 4],
    ["Week 2", 8]
  ]);
  XLSX.utils.book_append_sheet(workbook, overview, "Overview");
  XLSX.utils.book_append_sheet(workbook, trends, "Trends");
  workbook.Props = { Title: "Tiny Workbook" };
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function createSimplePptx(): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
          '<Default Extension="xml" ContentType="application/xml"/>',
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
          '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
          '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>',
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
          "</Types>"
        ].join(""),
        "utf8"
      ),
      "_rels/.rels": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>',
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
          "</Relationships>"
        ].join(""),
        "utf8"
      ),
      "docProps/core.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">',
          "<dc:title>Tiny Slide Deck</dc:title>",
          "<dc:creator>SwarmVault Tests</dc:creator>",
          "</cp:coreProperties>"
        ].join(""),
        "utf8"
      ),
      "ppt/presentation.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
          '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>',
          "</p:presentation>"
        ].join(""),
        "utf8"
      ),
      "ppt/_rels/presentation.xml.rels": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
          "</Relationships>"
        ].join(""),
        "utf8"
      ),
      "ppt/slides/slide1.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
          "<p:cSld><p:spTree>",
          "<p:sp><p:txBody><a:p><a:r><a:t>Tiny Slide Deck</a:t></a:r></a:p><a:p><a:r><a:t>Queue-backed deployments stay understandable.</a:t></a:r></a:p></p:txBody></p:sp>",
          "</p:spTree></p:cSld>",
          "</p:sld>"
        ].join(""),
        "utf8"
      ),
      "ppt/slides/_rels/slide1.xml.rels": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>',
          "</Relationships>"
        ].join(""),
        "utf8"
      ),
      "ppt/notesSlides/notesSlide1.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
          "<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker notes mention the queue between API and worker.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>",
          "</p:notes>"
        ].join(""),
        "utf8"
      )
    })
  );
}

function createSimpleEpub(chapters: Array<{ fileName: string; title: string; body: string }>): Buffer {
  const manifestItems = chapters
    .map((chapter, index) => `<item id="chapter-${index + 1}" href="${chapter.fileName}" media-type="application/xhtml+xml"/>`)
    .join("");
  const spineItems = chapters.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`).join("");
  const chapterEntries = Object.fromEntries(
    chapters.map((chapter) => [
      `OEBPS/${chapter.fileName}`,
      Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<html xmlns="http://www.w3.org/1999/xhtml"><head>',
          `<title>${chapter.title}</title>`,
          "</head><body>",
          `<h1>${chapter.title}</h1>`,
          `<p>${chapter.body}</p>`,
          "</body></html>"
        ].join(""),
        "utf8"
      )
    ])
  );

  return Buffer.from(
    zipSync({
      mimetype: Buffer.from("application/epub+zip", "utf8"),
      "META-INF/container.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>',
          "</container>"
        ].join(""),
        "utf8"
      ),
      "OEBPS/nav.xhtml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><h1>Table of Contents</h1></nav></body></html>'
        ].join(""),
        "utf8"
      ),
      "OEBPS/content.opf": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">',
          '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
          "<dc:title>Tiny EPUB</dc:title>",
          "<dc:creator>SwarmVault Tests</dc:creator>",
          "</metadata>",
          "<manifest>",
          '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
          manifestItems,
          "</manifest>",
          `<spine>${spineItems}</spine>`,
          "</package>"
        ].join(""),
        "utf8"
      ),
      ...chapterEntries
    })
  );
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

  it("installs agent instructions for goose, pi, opencode, aider, copilot, gemini, cursor, trae, claw, and droid targets", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const gooseTarget = await installAgent(rootDir, "goose");
    const piTarget = await installAgent(rootDir, "pi");
    const opencodeTarget = await installAgent(rootDir, "opencode");
    const aiderTarget = await installAgent(rootDir, "aider");
    const copilotTarget = await installAgent(rootDir, "copilot");
    const geminiTarget = await installAgent(rootDir, "gemini");
    const cursorTarget = await installAgent(rootDir, "cursor");
    const traeTarget = await installAgent(rootDir, "trae");
    const clawTarget = await installAgent(rootDir, "claw");
    const droidTarget = await installAgent(rootDir, "droid");

    expect(gooseTarget.target).toBe(path.join(rootDir, "AGENTS.md"));
    expect(piTarget.target).toBe(path.join(rootDir, "AGENTS.md"));
    expect(opencodeTarget.target).toBe(path.join(rootDir, "AGENTS.md"));
    expect(aiderTarget.target).toBe(path.join(rootDir, "CONVENTIONS.md"));
    expect(copilotTarget.target).toBe(path.join(rootDir, ".github", "copilot-instructions.md"));
    expect(geminiTarget.target).toBe(path.join(rootDir, "GEMINI.md"));
    expect(cursorTarget.target).toBe(path.join(rootDir, ".cursor", "rules", "swarmvault.mdc"));
    expect(traeTarget.target).toBe(path.join(rootDir, ".trae", "rules", "swarmvault.md"));
    expect(clawTarget.target).toBe(path.join(rootDir, ".claw", "skills", "swarmvault", "SKILL.md"));
    expect(droidTarget.target).toBe(path.join(rootDir, ".factory", "rules", "swarmvault.md"));
    expect(aiderTarget.targets).toContain(path.join(rootDir, ".aider.conf.yml"));
    expect(copilotTarget.targets).toContain(path.join(rootDir, "AGENTS.md"));

    const agentsContent = await fs.readFile(gooseTarget.target, "utf8");
    const geminiContent = await fs.readFile(geminiTarget.target, "utf8");
    const conventionsContent = await fs.readFile(aiderTarget.target, "utf8");
    const copilotContent = await fs.readFile(copilotTarget.target, "utf8");
    const cursorContent = await fs.readFile(cursorTarget.target, "utf8");
    const parsedCursor = matter(cursorContent);
    expect(agentsContent).toContain("# SwarmVault Rules");
    expect(agentsContent.match(/swarmvault:managed:start/g)?.length ?? 0).toBe(1);
    expect(geminiContent).toContain("# SwarmVault Rules");
    expect(conventionsContent).toContain("# SwarmVault Conventions");
    expect(copilotContent).toContain("# SwarmVault Repository Instructions");
    expect(parsedCursor.data.description).toBe("SwarmVault graph-first repository instructions.");
    expect(parsedCursor.data.alwaysApply).toBe(true);
    expect(parsedCursor.content).toContain("# SwarmVault Rules");
    expect(parsedCursor.content.match(/swarmvault:managed:start/g)?.length ?? 0).toBe(1);
    expect(await fs.readFile(path.join(rootDir, ".aider.conf.yml"), "utf8")).toContain("CONVENTIONS.md");

    const traeContent = await fs.readFile(traeTarget.target, "utf8");
    const clawContent = await fs.readFile(clawTarget.target, "utf8");
    const droidContent = await fs.readFile(droidTarget.target, "utf8");
    expect(traeContent).toContain("# SwarmVault Rules");
    expect(clawContent).toContain("# SwarmVault Rules");
    expect(droidContent).toContain("# SwarmVault Rules");

    await installAgent(rootDir, "cursor");
    const cursorContentAgain = await fs.readFile(cursorTarget.target, "utf8");
    expect(cursorContentAgain).toBe(cursorContent);
  });

  it("installs Claude rules with an optional graph-first pre-search hook", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const claudeTarget = await installAgent(rootDir, "claude", { hook: true });
    expect(claudeTarget.target).toBe(path.join(rootDir, "CLAUDE.md"));
    expect(claudeTarget.targets).toContain(path.join(rootDir, ".claude", "hooks", "swarmvault-graph-first.js"));

    const settingsPath = path.join(rootDir, ".claude", "settings.json");
    const scriptPath = path.join(rootDir, ".claude", "hooks", "swarmvault-graph-first.js");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      hooks?: {
        SessionStart?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
        PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
      };
    };
    expect(settings.hooks?.SessionStart?.some((entry) => entry.matcher === "startup")).toBe(true);
    expect(settings.hooks?.PreToolUse?.some((entry) => entry.matcher === "Glob|Grep")).toBe(true);
    expect(JSON.stringify(settings)).toContain("swarmvault-graph-first.js");
    expect(await fs.readFile(scriptPath, "utf8")).toContain("hookSpecificOutput");
    expect(await fs.readFile(scriptPath, "utf8")).toContain("additionalContext");

    await fs.mkdir(path.join(rootDir, "wiki", "graph"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "wiki", "graph", "report.md"), "# Graph report\n", "utf8");

    const sessionStart = JSON.parse(await runNodeScript(scriptPath, ["session-start"], JSON.stringify({ cwd: rootDir }), rootDir)) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(sessionStart.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(sessionStart.hookSpecificOutput?.additionalContext).toContain("wiki/graph/report.md");

    const firstSearch = JSON.parse(
      await runNodeScript(
        scriptPath,
        ["pre-tool-use"],
        JSON.stringify({ cwd: rootDir, tool_name: "Glob", tool_input: { pattern: "**/*.ts" } }),
        rootDir
      )
    ) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    expect(firstSearch.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(firstSearch.hookSpecificOutput?.additionalContext).toContain("wiki/graph/report.md");

    const reportRead = JSON.parse(
      await runNodeScript(
        scriptPath,
        ["pre-tool-use"],
        JSON.stringify({ cwd: rootDir, tool_name: "Read", tool_input: { file_path: "wiki/graph/report.md" } }),
        rootDir
      )
    ) as Record<string, never>;
    expect(reportRead).toEqual({});

    const secondSearch = JSON.parse(
      await runNodeScript(
        scriptPath,
        ["pre-tool-use"],
        JSON.stringify({ cwd: rootDir, tool_name: "Grep", tool_input: { pattern: "Widget" } }),
        rootDir
      )
    ) as Record<string, never>;
    expect(secondSearch).toEqual({});

    await installAgent(rootDir, "claude", { hook: true });
    const settingsAgain = await fs.readFile(settingsPath, "utf8");
    expect(settingsAgain.match(/Glob\|Grep/g)?.length ?? 0).toBe(1);
    expect(settingsAgain.match(/swarmvault-graph-first\.js/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("installs gemini and opencode graph-first hook artifacts when requested", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const geminiTarget = await installAgent(rootDir, "gemini", { hook: true });
    const opencodeTarget = await installAgent(rootDir, "opencode", { hook: true });

    expect(geminiTarget.targets).toContain(path.join(rootDir, ".gemini", "settings.json"));
    expect(geminiTarget.targets).toContain(path.join(rootDir, ".gemini", "hooks", "swarmvault-graph-first.js"));
    expect(opencodeTarget.targets).toContain(path.join(rootDir, ".opencode", "plugins", "swarmvault-graph-first.js"));

    const geminiSettings = JSON.parse(await fs.readFile(path.join(rootDir, ".gemini", "settings.json"), "utf8")) as {
      hooks?: { SessionStart?: Array<{ matcher?: string }>; BeforeTool?: Array<{ matcher?: string }> };
    };
    expect(geminiSettings.hooks?.SessionStart?.some((entry) => entry.matcher === "startup")).toBe(true);
    expect(geminiSettings.hooks?.BeforeTool?.some((entry) => entry.matcher === "glob|grep|search|find")).toBe(true);
    expect(await fs.readFile(path.join(rootDir, ".opencode", "plugins", "swarmvault-graph-first.js"), "utf8")).toContain(
      "tool.execute.before"
    );
  });

  it("installs copilot hook files and preserves invalid aider config with warnings", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.mkdir(path.join(rootDir, ".github", "hooks"), { recursive: true });
    await fs.writeFile(path.join(rootDir, ".aider.conf.yml"), "read: [keep-this\n", "utf8");

    const copilotTarget = await installAgent(rootDir, "copilot", { hook: true });
    const aiderTarget = await installAgent(rootDir, "aider");

    expect(copilotTarget.targets).toContain(path.join(rootDir, ".github", "hooks", "swarmvault-graph-first.json"));
    expect(copilotTarget.targets).toContain(path.join(rootDir, ".github", "hooks", "swarmvault-graph-first.js"));
    expect(await fs.readFile(path.join(rootDir, ".github", "hooks", "swarmvault-graph-first.json"), "utf8")).toContain('"version": 1');
    expect(aiderTarget.warnings).toEqual([
      "Could not parse .aider.conf.yml. Left the existing file unchanged; add `read: CONVENTIONS.md` manually."
    ]);
    expect(await fs.readFile(path.join(rootDir, ".aider.conf.yml"), "utf8")).toContain("keep-this");
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
    expect(postCommit).toContain("watch --repo --once");
    expect(postCommit).toContain("echo existing");
    expect(postCommit).toContain("swarmvault_bin=");
    expect(postCommit).toContain("command -v swarmvault");

    const status = await getGitHookStatus(rootDir);
    expect(status.postCommit).toBe("installed");
    expect(status.postCheckout).toBe("installed");

    await installGitHooks(rootDir);
    const postCommitAgain = await fs.readFile(path.join(rootDir, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommitAgain.match(/watch --repo --once/g)?.length ?? 0).toBe(1);

    const removed = await uninstallGitHooks(rootDir);
    expect(removed.postCommit).toBe("other_content");
    expect(removed.postCheckout).toBe("not_installed");
    const postCommitAfter = await fs.readFile(path.join(rootDir, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommitAfter).toContain("echo existing");
    expect(postCommitAfter).not.toContain("watch --repo --once");
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
    expect(parsedSourcePage.data.title).toBe("Local-First SwarmVault");
    expect(parsedSourcePage.content).toContain("# Local-First SwarmVault");
    expect(parsedSourcePage.content).not.toContain("# Local-First SwarmVault SwarmVault keeps raw sources immutable");
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

  it("extracts DOCX text and metadata into sidecars", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "brief.docx"), MINIMAL_DOCX);

    const manifest = await ingestInput(rootDir, "brief.docx");
    expect(manifest.sourceKind).toBe("docx");
    expect(manifest.title).toBe("Tiny DOCX Source");
    expect(manifest.extractedTextPath).toBeTruthy();
    expect(manifest.extractedMetadataPath).toBeTruthy();
    expect(manifest.extractionHash).toBeTruthy();

    const extractedText = await fs.readFile(path.join(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("Local DOCX files should extract readable text before analysis.");

    const extractionArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, manifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(extractionArtifact.extractor).toBe("docx_text");
    expect(extractionArtifact.metadata?.title).toBe("Tiny DOCX Source");
    expect(extractionArtifact.metadata?.author).toBe("SwarmVault Tests");

    await compileVault(rootDir);
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.summary).toContain("Local DOCX files should extract readable text before analysis.");
    expect(analysis.extractionHash).toBe(manifest.extractionHash);
  });

  it("extracts CSV and TSV datasets into bounded table summaries", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "metrics.csv"), ["Metric,Value,Status", "Users,12,stable", "Errors,1,watch"].join("\n"), "utf8");
    await fs.writeFile(path.join(rootDir, "milestones.tsv"), ["Week\tSignups", "Week 1\t4", "Week 2\t8"].join("\n"), "utf8");

    const csvManifest = await ingestInput(rootDir, "metrics.csv");
    const tsvManifest = await ingestInput(rootDir, "milestones.tsv");

    expect(csvManifest.sourceKind).toBe("csv");
    expect(tsvManifest.sourceKind).toBe("csv");
    expect(csvManifest.extractedTextPath).toBeTruthy();
    expect(tsvManifest.extractedTextPath).toBeTruthy();

    const csvExtract = await fs.readFile(path.join(rootDir, csvManifest.extractedTextPath as string), "utf8");
    const tsvExtract = await fs.readFile(path.join(rootDir, tsvManifest.extractedTextPath as string), "utf8");
    expect(csvExtract).toContain("Format: CSV");
    expect(csvExtract).toContain("| Metric | Value | Status |");
    expect(csvExtract).toContain("- Value: numeric");
    expect(tsvExtract).toContain("Format: TSV");
    expect(tsvExtract).toContain("| Week | Signups |");

    const csvArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, csvManifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(csvArtifact.extractor).toBe("csv_text");
    expect(csvArtifact.metadata?.format).toBe("csv");
    expect(csvArtifact.metadata?.row_count).toBe("2");

    await compileVault(rootDir);
    const searchResults = await searchVault(rootDir, "Signups", 5);
    expect(searchResults.some((result) => result.pageId === `source:${tsvManifest.sourceId}`)).toBe(true);
  });

  it("extracts XLSX workbooks into searchable sheet summaries", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "metrics.xlsx"), await createSimpleXlsx());

    const manifest = await ingestInput(rootDir, "metrics.xlsx");
    expect(manifest.sourceKind).toBe("xlsx");
    expect(manifest.title).toBe("Tiny Workbook");
    expect(manifest.extractedTextPath).toBeTruthy();
    expect(manifest.extractedMetadataPath).toBeTruthy();

    const extractedText = await fs.readFile(path.join(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("# Tiny Workbook");
    expect(extractedText).toContain("## Sheet: Overview");
    expect(extractedText).toContain("Sheet Names: Overview, Trends");

    const artifact = JSON.parse(
      await fs.readFile(path.join(rootDir, manifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(artifact.extractor).toBe("xlsx_text");
    expect(artifact.metadata?.sheet_count).toBe("2");

    await compileVault(rootDir);
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.summary).toContain("Tiny Workbook");
  });

  it("extracts PPTX slides and speaker notes into sidecars", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "deck.pptx"), createSimplePptx());

    const manifest = await ingestInput(rootDir, "deck.pptx");
    expect(manifest.sourceKind).toBe("pptx");
    expect(manifest.title).toBe("Tiny Slide Deck");
    expect(manifest.extractedTextPath).toBeTruthy();
    expect(manifest.extractedMetadataPath).toBeTruthy();

    const extractedText = await fs.readFile(path.join(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("Slides: 1");
    expect(extractedText).toContain("Queue-backed deployments stay understandable.");
    expect(extractedText).toContain("Speaker notes mention the queue between API and worker.");

    const artifact = JSON.parse(
      await fs.readFile(path.join(rootDir, manifest.extractedMetadataPath as string), "utf8")
    ) as SourceExtractionArtifact;
    expect(artifact.extractor).toBe("pptx_text");
    expect(artifact.metadata?.slide_count).toBe("1");
    expect(artifact.metadata?.title).toBe("Tiny Slide Deck");
  });

  it("splits EPUBs into chapter manifests and removes stale parts on re-ingest", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const epubPath = path.join(rootDir, "book.epub");
    await fs.writeFile(
      epubPath,
      createSimpleEpub([
        { fileName: "chapter-1.xhtml", title: "First Chapter", body: "Local-first wikis should keep chapter structure." },
        { fileName: "chapter-2.xhtml", title: "Second Chapter", body: "Graph summaries should stay readable for non-code research." }
      ])
    );

    const firstIngest = await ingestInputDetailed(rootDir, "book.epub");
    expect(firstIngest.created).toHaveLength(2);
    expect(firstIngest.removed).toHaveLength(0);
    const chapterManifest = firstIngest.created[0]!;
    expect(chapterManifest.sourceKind).toBe("epub");
    expect(chapterManifest.sourceGroupId).toBeTruthy();
    expect(chapterManifest.sourceGroupTitle).toBe("Tiny EPUB");
    expect(chapterManifest.partCount).toBe(2);
    expect(chapterManifest.partTitle).toBeTruthy();
    expect(chapterManifest.details?.book_title).toBe("Tiny EPUB");

    await compileVault(rootDir);
    const sourcePage = await fs.readFile(path.join(rootDir, "wiki", "sources", `${chapterManifest.sourceId}.md`), "utf8");
    expect(sourcePage).toContain("Source Group: Tiny EPUB");
    expect(sourcePage).toContain("Part: 1/2 - First Chapter");
    const searchResults = await searchVault(rootDir, "Second Chapter", 5);
    expect(searchResults.some((result) => result.path.startsWith("sources/"))).toBe(true);

    await fs.writeFile(
      epubPath,
      createSimpleEpub([{ fileName: "chapter-1.xhtml", title: "Only Chapter", body: "Re-ingest should prune removed chapter manifests." }])
    );

    const secondIngest = await ingestInputDetailed(rootDir, "book.epub");
    expect(secondIngest.created).toHaveLength(0);
    expect(secondIngest.updated).toHaveLength(1);
    expect(secondIngest.removed).toHaveLength(1);
    expect(secondIngest.updated[0]?.partCount).toBe(1);
    expect(secondIngest.updated[0]?.partTitle).toBe("Only Chapter");
  });

  it("treats .rst files as first-class text sources with normalized extracted text", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(
      path.join(rootDir, "guide.rst"),
      [
        "Guide Title",
        "===========",
        "",
        "SwarmVault should keep reStructuredText searchable.",
        "",
        ".. note:: Parser diagnostics stay local to the affected module."
      ].join("\n"),
      "utf8"
    );

    const manifest = await ingestInput(rootDir, "guide.rst");
    expect(manifest.sourceKind).toBe("text");
    expect(manifest.mimeType).toBe("text/x-rst");
    expect(manifest.title).toBe("Guide Title");
    expect(manifest.extractedTextPath).toBeTruthy();

    const extractedText = await fs.readFile(path.join(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("# Guide Title");
    expect(extractedText).toContain("Note: Parser diagnostics stay local to the affected module.");

    await compileVault(rootDir);

    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.summary).toContain("reStructuredText");

    const searchResults = await searchVault(rootDir, "Parser diagnostics", 5);
    expect(searchResults.some((result) => result.pageId === `source:${manifest.sourceId}`)).toBe(true);
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

  it("imports inbox HTML bundles with copied attachments and readable extracts", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const inboxDir = path.join(rootDir, "inbox");
    const assetsDir = path.join(inboxDir, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(
      path.join(inboxDir, "clip.html"),
      [
        "<html><head><title>Browser Clip HTML</title></head><body>",
        "<article>",
        "<h1>Browser Clip HTML</h1>",
        "<p>Inbox import should preserve local HTML image references.</p>",
        '<img alt="Diagram" src="assets/diagram.svg" />',
        "</article>",
        "</body></html>"
      ].join(""),
      "utf8"
    );
    await fs.writeFile(
      path.join(assetsDir, "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
      "utf8"
    );

    const result = await importInbox(rootDir);
    expect(result.imported).toHaveLength(1);
    expect(result.attachmentCount).toBe(1);
    expect(result.skipped.some((item) => item.reason === "referenced_attachment")).toBe(true);

    const manifest = result.imported[0];
    expect(manifest.sourceKind).toBe("html");
    expect(manifest.attachments).toHaveLength(1);
    expect(manifest.extractedTextPath).toBeTruthy();

    const storedHtml = await fs.readFile(path.join(rootDir, manifest.storedPath), "utf8");
    expect(storedHtml).toContain(`../assets/${manifest.sourceId}/assets/diagram.svg`);

    const extractedText = await fs.readFile(path.join(rootDir, manifest.extractedTextPath as string), "utf8");
    expect(extractedText).toContain("Inbox import should preserve local HTML image references.");
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

      const manifest = await withPrivateUrlAllowance(() => ingestInput(rootDir, articleUrl));
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
      const manifest = await withPrivateUrlAllowance(() => ingestInput(rootDir, `${server.baseUrl}/notes.md`));
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
      const manifest = await withPrivateUrlAllowance(() => ingestInput(rootDir, `${server.baseUrl}/notes.md`, { maxAssetSize: 8 }));
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
    expect(Number.isFinite(autoBenchmarkArtifact.summary.reductionRatio)).toBe(true);

    const autoGraphReportArtifact = JSON.parse(await fs.readFile(path.join(rootDir, "wiki", "graph", "report.json"), "utf8")) as {
      benchmark?: { stale: boolean; summary: { reductionRatio: number } };
      overview: { nodes: number };
      suggestedQuestions: string[];
    };
    expect(autoGraphReportArtifact.overview.nodes).toBeGreaterThan(0);
    expect(autoGraphReportArtifact.benchmark?.stale).toBe(false);
    expect(Number.isFinite(autoGraphReportArtifact.benchmark?.summary.reductionRatio ?? Number.NaN)).toBe(true);
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

  it("escapes hostile graph strings safely in svg and graphml exports", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const graph: GraphArtifact = {
      generatedAt: new Date().toISOString(),
      nodes: [
        {
          id: 'node:</script><img src=x onerror=alert("node")>',
          type: "concept",
          label: '</script><img src=x onerror=alert("label")>',
          pageId: 'page:</script><svg onload=alert("page")>',
          freshness: "fresh",
          confidence: 1,
          sourceIds: ["source:</script><b>one</b>"],
          projectIds: [],
          communityId: 'community:</script><math href="evil">'
        },
        {
          id: "node:beta",
          type: "entity",
          label: "Beta",
          freshness: "fresh",
          confidence: 1,
          sourceIds: ["source:two"],
          projectIds: []
        }
      ],
      edges: [
        {
          id: 'edge:</script><img src=x onerror=alert("edge")>',
          source: 'node:</script><img src=x onerror=alert("node")>',
          target: "node:beta",
          relation: '</script><img src=x onerror=alert("relation")>',
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: ['prov:</script><img src=x onerror=alert("prov")>']
        }
      ],
      hyperedges: [],
      communities: [
        {
          id: 'community:</script><math href="evil">',
          label: '</script><img src=x onerror=alert("community")>',
          nodeIds: ['node:</script><img src=x onerror=alert("node")>', "node:beta"]
        }
      ],
      sources: [],
      pages: [
        {
          id: 'page:</script><svg onload=alert("page")>',
          path: 'outputs/</script><img src=x onerror=alert("path")>.md',
          title: '</script><img src=x onerror=alert("title")>',
          kind: "output",
          sourceIds: ["source:</script><b>one</b>"],
          projectIds: [],
          nodeIds: ['node:</script><img src=x onerror=alert("node")>'],
          freshness: "fresh",
          status: "active",
          confidence: 1,
          backlinks: [],
          schemaHash: "schema",
          sourceHashes: {},
          sourceSemanticHashes: {},
          relatedPageIds: [],
          relatedNodeIds: [],
          relatedSourceIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          compiledFrom: [],
          managedBy: "system"
        }
      ]
    };

    await fs.writeFile(path.join(rootDir, "state", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const exportsDir = path.join(rootDir, "exports");
    const svg = await exportGraphFormat(rootDir, "svg", path.join(exportsDir, "graph.svg"));
    const graphml = await exportGraphFormat(rootDir, "graphml", path.join(exportsDir, "graph.graphml"));

    const svgContent = await fs.readFile(svg.outputPath, "utf8");
    const graphmlContent = await fs.readFile(graphml.outputPath, "utf8");

    expect(svgContent).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(&quot;label&quot;)&gt;");
    expect(svgContent).toContain("page=outputs/&lt;/script&gt;&lt;img src=x onerror=alert(&quot;path&quot;)&gt;.md");
    expect(svgContent).not.toContain('</script><img src=x onerror=alert("label")>');
    expect(svgContent).not.toContain('</script><img src=x onerror=alert("relation")>');

    expect(graphmlContent).toContain("&lt;/script&gt;&lt;img src=x onerror=alert(&quot;label&quot;)&gt;");
    expect(graphmlContent).toContain("outputs/&lt;/script&gt;&lt;img src=x onerror=alert(&quot;path&quot;)&gt;.md");
    expect(graphmlContent).not.toContain('</script><img src=x onerror=alert("label")>');
    expect(graphmlContent).not.toContain('</script><img src=x onerror=alert("relation")>');
  });

  it("escapes Cypher export string literals safely", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const graph: GraphArtifact = {
      generatedAt: new Date().toISOString(),
      nodes: [
        {
          id: "node:'alpha'\n",
          type: "concept",
          label: 'quote \' slash \\\\ newline\njson {"ok":true}',
          freshness: "fresh",
          confidence: 1,
          sourceIds: ["source:'one'"],
          projectIds: []
        },
        {
          id: "node:beta",
          type: "entity",
          label: "Beta",
          freshness: "fresh",
          confidence: 1,
          sourceIds: ["source:two"],
          projectIds: []
        }
      ],
      edges: [
        {
          id: "edge:'alpha'\n",
          source: "node:'alpha'\n",
          target: "node:beta",
          relation: "semantically_similar_to",
          status: "inferred",
          evidenceClass: "inferred",
          confidence: 0.84,
          provenance: ["prov:'one'\n"],
          similarityReasons: ["shared_concept"]
        }
      ],
      hyperedges: [
        {
          id: "group:'alpha'",
          label: "Group 'Alpha'",
          relation: "participate_in",
          nodeIds: ["node:'alpha'\n", "node:beta"],
          evidenceClass: "inferred",
          confidence: 0.72,
          sourcePageIds: ["page:'alpha'"],
          why: "Contains 'quotes', backslashes \\\\, and newlines\nfor export safety."
        }
      ],
      communities: [],
      sources: [],
      pages: []
    };

    await fs.writeFile(path.join(rootDir, "state", "graph.json"), `${JSON.stringify(graph, null, 2)}\n`, "utf8");

    const exported = await exportGraphFormat(rootDir, "cypher", path.join(rootDir, "exports", "graph.cypher"));
    const cypher = await fs.readFile(exported.outputPath, "utf8");

    expect(cypher).toContain("MERGE (n:SwarmNode");
    expect(cypher).toContain("node:\\'alpha\\'\\n");
    expect(cypher).toContain("quote \\' slash \\\\\\\\ newline\\njson");
    expect(cypher).toContain("why: 'Contains \\'quotes\\', backslashes \\\\\\\\, and newlines\\nfor export safety.'");
    expect(cypher).toContain("r:SEMANTICALLY_SIMILAR_TO");
    expect(cypher).toContain("GROUP_MEMBER");
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

  it("suggests an embedding-capable backend when embeddingProvider lacks embeddings support", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await updateConfig(rootDir, (config) => {
      config.tasks.embeddingProvider = "local";
    });

    await fs.writeFile(path.join(rootDir, "alpha.md"), "# Alpha\n\nDurable memory keeps agent context alive.\n", "utf8");
    await fs.writeFile(path.join(rootDir, "beta.md"), "# Beta\n\nPersistent context helps an agent resume prior work.\n", "utf8");
    await ingestInput(rootDir, "alpha.md");
    await ingestInput(rootDir, "beta.md");

    await compileVault(rootDir);
    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;

    await expect(semanticGraphMatches(rootDir, graph, "compounding memory")).rejects.toThrow(
      'Provider local does not support required capability "embeddings". Configure tasks.embeddingProvider to use an embedding-capable backend such as ollama or another openai-compatible embedding service.'
    );
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

  it("rolls up fragmented tiny communities in report presentation without mutating the graph", async () => {
    const now = "2026-04-08T00:00:00.000Z";
    const graph: GraphArtifact = {
      generatedAt: now,
      nodes: Array.from({ length: 8 }, (_, index) => ({
        id: `node:${index + 1}`,
        type: "source",
        label: `Source ${index + 1}`,
        pageId: `source:${index + 1}`,
        sourceIds: [`source-${index + 1}`],
        projectIds: [],
        sourceClass: "first_party"
      })),
      edges: [],
      hyperedges: [],
      communities: Array.from({ length: 8 }, (_, index) => ({
        id: `community:${index + 1}`,
        label: `Community ${index + 1}`,
        nodeIds: [`node:${index + 1}`]
      })),
      sources: Array.from({ length: 8 }, (_, index) => ({
        sourceId: `source-${index + 1}`,
        originType: "file",
        sourceKind: "markdown",
        sourceClass: "first_party",
        mimeType: "text/markdown",
        contentHash: `hash-${index + 1}`,
        semanticHash: `semantic-${index + 1}`,
        storedPath: `raw/sources/source-${index + 1}.md`,
        title: `Source ${index + 1}`,
        createdAt: now,
        updatedAt: now
      })),
      pages: Array.from({ length: 8 }, (_, index) => ({
        id: `source:${index + 1}`,
        path: `sources/source-${index + 1}.md`,
        title: `Source ${index + 1}`,
        kind: "source",
        sourceClass: "first_party",
        sourceIds: [`source-${index + 1}`],
        projectIds: [],
        nodeIds: [`node:${index + 1}`],
        freshness: "fresh",
        status: "active",
        confidence: 1,
        backlinks: [],
        schemaHash: "schema-hash",
        sourceHashes: { [`source-${index + 1}`]: `hash-${index + 1}` },
        sourceSemanticHashes: { [`source-${index + 1}`]: `semantic-${index + 1}` },
        relatedPageIds: [],
        relatedNodeIds: [],
        relatedSourceIds: [],
        createdAt: now,
        updatedAt: now,
        compiledFrom: [`source-${index + 1}`],
        managedBy: "system"
      }))
    };

    const communityPages =
      graph.communities?.map((community) => ({
        id: `community-page:${community.id}`,
        path: `graph/communities/${community.id}.md`,
        title: community.label
      })) ?? [];

    const report = buildGraphReportArtifact({
      graph,
      communityPages,
      graphHash: "graph-hash"
    });

    expect(graph.communities).toHaveLength(8);
    expect(report.thinCommunities).toHaveLength(6);
    expect(report.fragmentedCommunityRollup).toEqual({
      totalCommunities: 8,
      rolledUpCount: 2,
      rolledUpNodes: 2,
      exampleLabels: ["Community 7", "Community 8"]
    });
    expect(report.warnings.some((warning) => warning.includes("rolled up for readability"))).toBe(true);
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

    // A failing tool handler (e.g. get_node with an unknown target) must not
    // crash the server. The safeHandler wrapper should return an MCP error
    // response and the session should stay alive for subsequent tool calls.
    const unresolved = await client.callTool({ name: "get_node", arguments: { target: "definitely-not-in-the-graph" } });
    expect(unresolved.isError).toBe(true);
    const unresolvedContent = unresolved.content as ToolContent;
    expect(unresolvedContent[0]?.text).toMatch(/could not resolve/i);

    // After the failing call the server should still answer healthy tools.
    const postFailureInfo = await client.callTool({ name: "workspace_info", arguments: {} });
    const postFailureContent = postFailureInfo.content as ToolContent;
    expect(JSON.parse(postFailureContent[0]?.text ?? "{}").rootDir).toBe(rootDir);

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

    await addManagedSource(rootDir, path.join(rootDir, "repo"));
    const guideManifest = (
      await Promise.all(
        (
          await fs.readdir(path.join(rootDir, "state", "manifests"))
        ).map(async (name) => JSON.parse(await fs.readFile(path.join(rootDir, "state", "manifests", name), "utf8")))
      )
    ).find((manifest) => manifest.originalPath?.endsWith("docs/guide.md"));
    expect(guideManifest).toBeTruthy();

    await fs.writeFile(
      path.join(rootDir, "repo", "docs", "guide.md"),
      ["# Repo Guide", "", "Updated repo documentation that needs semantic refresh."].join("\n"),
      "utf8"
    );

    const cycle = await runWatchCycle(rootDir, { repo: true, debounceMs: 50 });
    expect(cycle.pendingSemanticRefreshCount).toBe(1);
    expect(cycle.pendingSemanticRefreshPaths.some((entry) => entry.endsWith("docs/guide.md"))).toBe(true);

    const watchStatus = await getWatchStatus(rootDir);
    expect(watchStatus.pendingSemanticRefresh).toHaveLength(1);
    expect(watchStatus.pendingSemanticRefresh[0]?.path).toBe("repo/docs/guide.md");

    const sourcePage = matter(await fs.readFile(path.join(rootDir, "wiki", "sources", `${guideManifest?.sourceId}.md`), "utf8"));
    expect(sourcePage.data.freshness).toBe("stale");
  });

  it("includes tags field in analysis and page frontmatter after compile", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "tags-test.md"),
      [
        "# Cryptography Primer",
        "",
        "This document covers symmetric encryption, public-key cryptography, and hash functions.",
        "Distributed systems rely on cryptographic protocols for secure communication."
      ].join("\n"),
      "utf8"
    );

    const manifest = await ingestInput(rootDir, "tags-test.md");
    await compileVault(rootDir);

    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis).toHaveProperty("tags");
    expect(Array.isArray(analysis.tags)).toBe(true);

    const sourcePagePath = path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`);
    const parsed = matter(await fs.readFile(sourcePagePath, "utf8"));
    expect(Array.isArray(parsed.data.tags)).toBe(true);
    expect(parsed.data.tags).toContain("source");
  });

  it("propagates tags from analysis onto source nodes in graph.json", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "graph-tags-test.md"),
      [
        "# Distributed Systems Overview",
        "",
        "This document covers consensus algorithms, fault tolerance, and distributed ledgers.",
        "Blockchain and peer-to-peer networks rely on cryptographic proofs for trust."
      ].join("\n"),
      "utf8"
    );

    const manifest = await ingestInput(rootDir, "graph-tags-test.md");
    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;

    const sourceNode = graph.nodes.find((node) => node.type === "source" && node.sourceIds.includes(manifest.sourceId));
    expect(sourceNode).toBeDefined();
    expect(sourceNode).toHaveProperty("tags");
    expect(Array.isArray(sourceNode?.tags)).toBe(true);
  });

  it("detects contradictions between opposing claims across sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "pro-encryption.md"),
      "# Encryption Policy\n\nEncryption for data at rest is enabled and active in production systems.",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "no-encryption.md"),
      "# Security Policy\n\nEncryption for data at rest is not enabled in production systems.",
      "utf8"
    );
    await ingestInput(rootDir, "pro-encryption.md");
    await ingestInput(rootDir, "no-encryption.md");
    await compileVault(rootDir);
    const graph: GraphArtifact = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8"));
    const conflictedEdges = graph.edges.filter((e) => e.relation === "contradicts");
    expect(conflictedEdges.length).toBeGreaterThan(0);
    expect(conflictedEdges[0].evidenceClass).toBe("ambiguous");
    const report = await fs.readFile(path.join(rootDir, "wiki", "graph", "report.md"), "utf8");
    expect(report).toContain("Contradictions");
  });

  it("lint --conflicts surfaces deterministic contradiction findings", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "yes.md"),
      "# Auth\n\nAuthentication is required for all API endpoints. The system enforces strict authentication.",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "no.md"),
      "# Auth\n\nAuthentication is not required for API endpoints. The system does not enforce authentication.",
      "utf8"
    );
    await ingestInput(rootDir, "yes.md");
    await ingestInput(rootDir, "no.md");
    await compileVault(rootDir);
    const findings = await lintVault(rootDir, { deep: false, web: false, conflicts: true });
    const contradictionFindings = findings.filter((f) => f.code === "contradiction");
    expect(contradictionFindings.length).toBeGreaterThan(0);
  });

  it("review show includes a change summary for approval entries", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "evolving.md"), "# Topic\n\nOriginal content about the topic.", "utf8");
    await ingestInput(rootDir, "evolving.md");
    await compileVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "evolving.md"),
      "# Topic\n\nUpdated content about the topic with new details and expanded coverage.",
      "utf8"
    );
    await ingestInput(rootDir, "evolving.md");
    await compileVault(rootDir, { approve: true });
    const approvals = await listApprovals(rootDir);
    expect(approvals.length).toBeGreaterThan(0);
    const detail = await readApproval(rootDir, approvals[0].approvalId);
    const updatedEntries = detail.entries.filter((e) => e.changeType === "update");
    expect(updatedEntries.length).toBeGreaterThan(0);
    expect(updatedEntries[0].changeSummary).toBeDefined();
    expect(typeof updatedEntries[0].changeSummary).toBe("string");
    expect(updatedEntries[0].changeSummary!.length).toBeGreaterThan(0);
  });

  it("review show with diff option includes unified diff output", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "diffme.md"), "# Original\n\nLine one.\nLine two.", "utf8");
    await ingestInput(rootDir, "diffme.md");
    await compileVault(rootDir);
    await fs.writeFile(path.join(rootDir, "diffme.md"), "# Original\n\nLine one changed.\nLine two.\nLine three added.", "utf8");
    await ingestInput(rootDir, "diffme.md");
    await compileVault(rootDir, { approve: true });
    const approvals = await listApprovals(rootDir);
    const detail = await readApproval(rootDir, approvals[0].approvalId, { diff: true });
    const updatedEntries = detail.entries.filter((e) => e.changeType === "update");
    expect(updatedEntries.length).toBeGreaterThan(0);
    expect(updatedEntries[0].diff).toBeDefined();
    expect(updatedEntries[0].diff).toContain("---");
    expect(updatedEntries[0].diff).toContain("+++");
  });

  it("ignores operational markdown frontmatter changes when semantic content is unchanged", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const sourcePath = path.join(rootDir, "semantic-cache.md");
    await fs.writeFile(sourcePath, "---\nlayout: compact\n---\n# Semantic Cache\n\nStable body.\n", "utf8");

    const manifest = await ingestInput(rootDir, "semantic-cache.md");
    await compileVault(rootDir);
    await compileVault(rootDir);
    const manifestPath = path.join(rootDir, "state", "manifests", `${manifest.sourceId}.json`);
    const firstManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { contentHash: string; semanticHash: string };
    const sourcePagePath = path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`);
    const compiledSourcePage = matter(await fs.readFile(sourcePagePath, "utf8"));
    expect(compiledSourcePage.data.source_semantic_hashes).toBeDefined();

    await fs.writeFile(sourcePath, "---\nlayout: expanded\n---\n# Semantic Cache\n\nStable body.\n", "utf8");
    await ingestInput(rootDir, "semantic-cache.md");
    const secondManifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { contentHash: string; semanticHash: string };
    expect(secondManifest.contentHash).not.toBe(firstManifest.contentHash);
    expect(secondManifest.semanticHash).toBe(firstManifest.semanticHash);

    const compile = await compileVault(rootDir);
    expect(compile.changedPages).toEqual([]);
  });

  it("falls back to legacy source_hashes when source_semantic_hashes are absent", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const sourcePath = path.join(rootDir, "legacy-page.md");
    await fs.writeFile(sourcePath, "---\ntags:\n  - alpha\n---\n# Legacy Page\n\nStable body.\n", "utf8");

    const manifest = await ingestInput(rootDir, "legacy-page.md");
    await compileVault(rootDir);

    const sourcePagePath = path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`);
    const parsedPage = matter(await fs.readFile(sourcePagePath, "utf8"));
    delete parsedPage.data.source_semantic_hashes;
    await fs.writeFile(sourcePagePath, matter.stringify(parsedPage.content, parsedPage.data), "utf8");

    await fs.writeFile(sourcePath, "---\ntags:\n  - beta\n---\n# Legacy Page\n\nStable body.\n", "utf8");
    await ingestInput(rootDir, "legacy-page.md");

    const findings = await lintVault(rootDir);
    expect(findings.some((finding) => finding.code === "stale_page" && finding.pagePath === sourcePagePath)).toBe(true);
  });

  it("scopes uncited_claims lint to the Claims section only", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const sourcePath = path.join(rootDir, "cited.md");
    await fs.writeFile(sourcePath, "# Cited Page\n\nThis page describes something.\n", "utf8");

    const manifest = await ingestInput(rootDir, "cited.md");
    await compileVault(rootDir);

    const sourcePagePath = path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`);
    const parsed = matter(await fs.readFile(sourcePagePath, "utf8"));

    // Replace the body with a fully cited Claims section plus other bullets in
    // other sections. The old linter incorrectly flagged these as uncited.
    parsed.content = [
      "# Cited Page",
      "",
      "## Concepts",
      "",
      "- auth: referenced",
      "- session: referenced",
      "",
      "## Claims",
      "",
      `- Fully cited claim one. [source:${manifest.sourceId}]`,
      `- Fully cited claim two. [source:${manifest.sourceId}]`,
      "",
      "## Questions",
      "",
      "- What about edge cases?",
      "",
      "## Related Outputs",
      "",
      "- [[outputs/irrelevant|irrelevant]]",
      ""
    ].join("\n");
    await fs.writeFile(sourcePagePath, matter.stringify(parsed.content, parsed.data), "utf8");

    const cleanFindings = await lintVault(rootDir);
    expect(cleanFindings.some((finding) => finding.code === "uncited_claims" && finding.pagePath === sourcePagePath)).toBe(false);

    // Now inject an actually uncited claim bullet into the Claims section and
    // confirm the linter still catches it.
    parsed.content = parsed.content.replace(`- Fully cited claim one. [source:${manifest.sourceId}]`, "- This claim has no citation.");
    await fs.writeFile(sourcePagePath, matter.stringify(parsed.content, parsed.data), "utf8");

    const dirtyFindings = await lintVault(rootDir);
    expect(dirtyFindings.some((finding) => finding.code === "uncited_claims" && finding.pagePath === sourcePagePath)).toBe(true);
  });

  it("does not fire uncited_claims on the 'No claims extracted.' placeholder bullet", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const sourcePath = path.join(rootDir, "placeholder.md");
    await fs.writeFile(sourcePath, "# Placeholder\n\nbody\n", "utf8");

    const manifest = await ingestInput(rootDir, "placeholder.md");
    await compileVault(rootDir);

    const sourcePagePath = path.join(rootDir, "wiki", "sources", `${manifest.sourceId}.md`);
    const parsed = matter(await fs.readFile(sourcePagePath, "utf8"));

    // Rewrite the body so the Claims section contains only the no-claims
    // placeholder bullet that the compiler emits when extraction yields
    // nothing. The linter used to flag this as uncited.
    parsed.content = [
      "# Placeholder",
      "",
      "## Claims",
      "",
      "- No claims extracted.",
      "",
      "## Questions",
      "",
      "- What does this page say?",
      ""
    ].join("\n");
    await fs.writeFile(sourcePagePath, matter.stringify(parsed.content, parsed.data), "utf8");

    const findings = await lintVault(rootDir);
    expect(findings.some((finding) => finding.code === "uncited_claims" && finding.pagePath === sourcePagePath)).toBe(false);
  });

  it("does not fire uncited_claims when ## Claims appears only inside embedded source text", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const sourcePath = path.join(rootDir, "embedded.md");
    await fs.writeFile(sourcePath, "# Embedded\n\nnothing to see.\n", "utf8");

    const manifest = await ingestInput(rootDir, "embedded.md");
    await compileVault(rootDir);

    // Write an output-style page where the substring "## Claims" only appears
    // inside a collapsed single-line block of embedded source material (no
    // Claims section of its own) and has some bullet lists in other sections.
    const outputPath = path.join(rootDir, "wiki", "outputs", "embedded-output.md");
    const frontmatter = {
      page_id: "output:embedded-output",
      kind: "output",
      title: "Embedded Output",
      tags: ["output"],
      source_ids: [manifest.sourceId],
      project_ids: [],
      node_ids: [`source:${manifest.sourceId}`],
      freshness: "fresh",
      status: "active",
      confidence: 1,
      created_at: "2026-04-09T00:00:00.000Z",
      updated_at: "2026-04-09T00:00:00.000Z",
      compiled_from: [manifest.sourceId],
      managed_by: "system",
      backlinks: [],
      schema_hash: "placeholder",
      source_hashes: {},
      source_semantic_hashes: {}
    };
    const body = [
      "# Embedded Output",
      "",
      "Relevant pages:",
      "- Page A (sources/page-a.md)",
      "- Page B (sources/page-b.md)",
      "",
      "# Embedded",
      "# Embedded Source text ## Summary Something. ## Claims - inline bullet with no citation - another inline bullet",
      ""
    ].join("\n");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, matter.stringify(body, frontmatter), "utf8");

    const findings = await lintVault(rootDir);
    expect(findings.some((finding) => finding.code === "uncited_claims" && finding.pagePath === outputPath)).toBe(false);
  });

  it("rejects sibling-prefix path traversal in readPage", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    // Create a sibling directory whose name shares a prefix with the wiki
    // directory. A naive startsWith(wikiDir) fence would be bypassed here.
    const siblingDir = path.join(rootDir, "wiki-evil");
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(siblingDir, "secret.md"), "top-secret-content", "utf8");

    const page = await readPage(rootDir, "../wiki-evil/secret.md");
    expect(page).toBeNull();
  });

  it("returns null from readPage for empty or directory paths", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    // Empty relative path would otherwise resolve to the wiki root directory
    // and surface EISDIR when trying to read it.
    expect(await readPage(rootDir, "")).toBeNull();
    expect(await readPage(rootDir, "sources")).toBeNull();
  });
});
