import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import mime from "mime-types";
import { loadVaultConfig } from "./config.js";
import { buildViewerGraphArtifact } from "./graph-presentation.js";
import { ingestInput } from "./ingest.js";
import { normalizeOutputAssets } from "./pages.js";
import { searchPages } from "./search.js";
import type { GraphArtifact, GraphReportArtifact } from "./types.js";
import { fileExists, isPathWithin, readJsonFile } from "./utils.js";
import {
  acceptApproval,
  archiveCandidate,
  explainGraphVault,
  listApprovals,
  listCandidates,
  pathGraphVault,
  promoteCandidate,
  queryGraphVault,
  readApproval,
  rejectApproval
} from "./vault.js";
import { getWatchStatus } from "./watch.js";

const execFileAsync = promisify(execFile);

async function isReadableFile(absolutePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(absolutePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function readViewerPage(
  rootDir: string,
  relativePath: string
): Promise<{
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  content: string;
  assets: ReturnType<typeof normalizeOutputAssets>;
} | null> {
  if (!relativePath) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const absolutePath = path.resolve(paths.wikiDir, relativePath);
  if (!isPathWithin(paths.wikiDir, absolutePath) || !(await isReadableFile(absolutePath))) {
    return null;
  }

  const raw = await fs.readFile(absolutePath, "utf8");
  const parsed = matter(raw);
  return {
    path: relativePath,
    title: typeof parsed.data.title === "string" ? parsed.data.title : path.basename(relativePath, path.extname(relativePath)),
    frontmatter: parsed.data,
    content: parsed.content,
    assets: normalizeOutputAssets(parsed.data.output_assets)
  };
}

async function readViewerAsset(rootDir: string, relativePath: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!relativePath) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const absolutePath = path.resolve(paths.wikiDir, relativePath);
  if (!isPathWithin(paths.wikiDir, absolutePath) || !(await isReadableFile(absolutePath))) {
    return null;
  }
  return {
    buffer: await fs.readFile(absolutePath),
    mimeType: mime.lookup(absolutePath) || "application/octet-stream"
  };
}

async function assetDataUrl(rootDir: string, relativePath: string): Promise<string | undefined> {
  const asset = await readViewerAsset(rootDir, relativePath);
  if (!asset) {
    return undefined;
  }
  return `data:${asset.mimeType};base64,${asset.buffer.toString("base64")}`;
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function ensureViewerDist(viewerDistDir: string): Promise<void> {
  const indexPath = path.join(viewerDistDir, "index.html");
  if (await fileExists(indexPath)) {
    return;
  }

  const viewerProjectDir = path.dirname(viewerDistDir);
  if (await fileExists(path.join(viewerProjectDir, "package.json"))) {
    await execFileAsync("pnpm", ["build"], { cwd: viewerProjectDir });
  }
}

export async function startGraphServer(
  rootDir: string,
  port?: number,
  options: { full?: boolean } = {}
): Promise<{ port: number; close: () => Promise<void> }> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const effectivePort = port ?? config.viewer.port;
  await ensureViewerDist(paths.viewerDistDir);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${effectivePort}`}`);
    try {
      if (url.pathname === "/api/graph") {
        if (!(await fileExists(paths.graphPath))) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Graph artifact not found. Run `swarmvault compile` first." }));
          return;
        }
        const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
        if (!graph) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Graph artifact not found. Run `swarmvault compile` first." }));
          return;
        }
        const reportPath = path.join(paths.wikiDir, "graph", "report.json");
        const report = (await readJsonFile<GraphReportArtifact>(reportPath)) ?? null;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(buildViewerGraphArtifact(graph, { report, full: options.full ?? false })));
        return;
      }

      if (url.pathname === "/api/graph/query") {
        const question = url.searchParams.get("q") ?? "";
        const traversal = url.searchParams.get("traversal");
        const budget = Number.parseInt(url.searchParams.get("budget") ?? "12", 10);
        const result = await queryGraphVault(rootDir, question, {
          traversal: traversal === "dfs" ? "dfs" : "bfs",
          budget: Number.isFinite(budget) ? budget : 12
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/graph/path") {
        const from = url.searchParams.get("from") ?? "";
        const to = url.searchParams.get("to") ?? "";
        const result = await pathGraphVault(rootDir, from, to);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/graph/explain") {
        const target = url.searchParams.get("target") ?? "";
        if (!target) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing explain target." }));
          return;
        }
        const result = await explainGraphVault(rootDir, target);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/search") {
        if (!(await fileExists(paths.searchDbPath))) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Search index not found. Run `swarmvault compile` first." }));
          return;
        }
        const query = url.searchParams.get("q") ?? "";
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
        const kind = url.searchParams.get("kind") ?? "all";
        const status = url.searchParams.get("status") ?? "all";
        const project = url.searchParams.get("project") ?? "all";
        const sourceType = url.searchParams.get("sourceType") ?? "all";
        const sourceClass = url.searchParams.get("sourceClass") ?? "all";
        const results = searchPages(paths.searchDbPath, query, {
          limit: Number.isFinite(limit) ? limit : 10,
          kind,
          status,
          project,
          sourceType,
          sourceClass
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(results));
        return;
      }

      if (url.pathname === "/api/graph-report") {
        const reportPath = path.join(paths.wikiDir, "graph", "report.json");
        if (!(await fileExists(reportPath))) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Graph report artifact not found. Run `swarmvault compile` first." }));
          return;
        }
        const body = await fs.readFile(reportPath, "utf8");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }

      if (url.pathname === "/api/watch-status") {
        const watchStatus = await getWatchStatus(rootDir);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(watchStatus));
        return;
      }

      if (url.pathname === "/api/page") {
        const relativePath = url.searchParams.get("path") ?? "";
        const page = await readViewerPage(rootDir, relativePath);
        if (!page) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: `Page not found: ${relativePath}` }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(page));
        return;
      }

      if (url.pathname === "/api/asset") {
        const relativePath = url.searchParams.get("path") ?? "";
        const asset = await readViewerAsset(rootDir, relativePath);
        if (!asset) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: `Asset not found: ${relativePath}` }));
          return;
        }
        response.writeHead(200, { "content-type": asset.mimeType });
        response.end(asset.buffer);
        return;
      }

      if (url.pathname === "/api/reviews" && request.method === "GET") {
        const approvals = await listApprovals(rootDir);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(approvals));
        return;
      }

      if (url.pathname === "/api/review" && request.method === "GET") {
        const approvalId = url.searchParams.get("id") ?? "";
        if (!approvalId) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing approval id." }));
          return;
        }
        const approval = await readApproval(rootDir, approvalId);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(approval));
        return;
      }

      if (url.pathname === "/api/review" && request.method === "POST") {
        const body = await readJsonBody(request);
        const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
        const targets = Array.isArray(body.targets) ? body.targets.filter((item): item is string => typeof item === "string") : [];
        const action = url.searchParams.get("action") ?? "";
        if (!approvalId || (action !== "accept" && action !== "reject")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing approval id or invalid review action." }));
          return;
        }
        const result =
          action === "accept" ? await acceptApproval(rootDir, approvalId, targets) : await rejectApproval(rootDir, approvalId, targets);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/candidates" && request.method === "GET") {
        const candidates = await listCandidates(rootDir);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(candidates));
        return;
      }

      if (url.pathname === "/api/candidate" && request.method === "POST") {
        const body = await readJsonBody(request);
        const target = typeof body.target === "string" ? body.target : "";
        const action = url.searchParams.get("action") ?? "";
        if (!target || (action !== "promote" && action !== "archive")) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing candidate target or invalid candidate action." }));
          return;
        }
        const result = action === "promote" ? await promoteCandidate(rootDir, target) : await archiveCandidate(rootDir, target);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/clip" && request.method === "POST") {
        const body = await readJsonBody(request);
        const clipUrl = typeof body.url === "string" ? body.url.trim() : "";
        if (!clipUrl) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing url field." }));
          return;
        }
        const manifest = await ingestInput(rootDir, clipUrl);
        response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        response.end(JSON.stringify({ ok: true, sourceId: manifest.sourceId, title: manifest.title }));
        return;
      }

      if (url.pathname === "/api/clip" && request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type"
        });
        response.end();
        return;
      }

      if (url.pathname === "/api/bookmarklet") {
        const script = `javascript:void(fetch('http://localhost:${effectivePort}/api/clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:location.href})}).then(r=>r.json()).then(d=>alert('Clipped: '+(d.title||d.sourceId))).catch(e=>alert('Clip failed: '+e.message)))`;
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          [
            "<!doctype html><html><head><title>SwarmVault Clipper</title></head><body>",
            "<h1>SwarmVault Clipper</h1>",
            `<p>Drag this link to your bookmarks bar:</p>`,
            `<p style="font-size:1.5em"><a href="${script.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Clip to SwarmVault</a></p>`,
            `<p>When clicked on any page, it sends the URL to your running SwarmVault instance for ingestion.</p>`,
            `<p>Server: <code>http://localhost:${effectivePort}</code></p>`,
            "</body></html>"
          ].join("\n")
        );
        return;
      }

      const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const target = path.join(paths.viewerDistDir, relativePath);
      const fallback = path.join(paths.viewerDistDir, "index.html");
      const filePath = (await fileExists(target)) ? target : fallback;
      if (!(await fileExists(filePath))) {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("Viewer build not found. Run `pnpm build` first.");
        return;
      }

      const staticBody = await fs.readFile(filePath);
      response.writeHead(200, { "content-type": mime.lookup(filePath) || "text/plain" });
      response.end(staticBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[viewer] ${request.method ?? "GET"} ${url.pathname} failed: ${message}`);
      if (!response.headersSent) {
        const status = /not found|could not resolve|cannot resolve/i.test(message) ? 404 : 500;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      } else {
        response.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(effectivePort, resolve);
  });

  return {
    port: effectivePort,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

export async function exportGraphHtml(rootDir: string, outputPath: string, options: { full?: boolean } = {}): Promise<string> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` first.");
  }

  await ensureViewerDist(paths.viewerDistDir);
  const indexPath = path.join(paths.viewerDistDir, "index.html");
  if (!(await fileExists(indexPath))) {
    throw new Error("Viewer build not found. Run `pnpm build` first.");
  }

  const pages = await Promise.all(
    graph.pages.map(async (page) => {
      const loaded = await readViewerPage(rootDir, page.path);
      return loaded
        ? {
            pageId: page.id,
            path: loaded.path,
            title: loaded.title,
            kind: page.kind,
            status: page.status,
            sourceType: page.sourceType,
            sourceClass: page.sourceClass,
            projectIds: page.projectIds,
            content: loaded.content,
            assets: await Promise.all(
              loaded.assets.map(async (asset) => ({
                ...asset,
                dataUrl: await assetDataUrl(rootDir, asset.path)
              }))
            )
          }
        : null;
    })
  );

  const rawHtml = await fs.readFile(indexPath, "utf8");
  const scriptMatch = rawHtml.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
  const styleMatch = rawHtml.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);
  const scriptPath = scriptMatch?.[1] ? path.join(paths.viewerDistDir, scriptMatch[1].replace(/^\//, "")) : null;
  const stylePath = styleMatch?.[1] ? path.join(paths.viewerDistDir, styleMatch[1].replace(/^\//, "")) : null;

  if (!scriptPath || !(await fileExists(scriptPath))) {
    throw new Error("Viewer script bundle not found. Run `pnpm build` first.");
  }

  const script = await fs.readFile(scriptPath, "utf8");
  const style = stylePath && (await fileExists(stylePath)) ? await fs.readFile(stylePath, "utf8") : "";
  const report = await readJsonFile<GraphReportArtifact>(path.join(paths.wikiDir, "graph", "report.json"));
  const embeddedData = JSON.stringify(
    { graph: buildViewerGraphArtifact(graph, { report, full: options.full ?? false }), pages: pages.filter(Boolean), report },
    null,
    2
  ).replace(/</g, "\\u003c");
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "    <title>SwarmVault Graph Export</title>",
    style ? `    <style>${style}</style>` : "",
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    `    <script>window.__SWARMVAULT_EMBEDDED_DATA__ = ${embeddedData};</script>`,
    `    <script type="module">${script}</script>`,
    "  </body>",
    "</html>",
    ""
  ]
    .filter(Boolean)
    .join("\n");

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, "utf8");
  return path.resolve(outputPath);
}
