import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import mime from "mime-types";
import { loadVaultConfig } from "./config.js";
import { searchPages } from "./search.js";
import type { GraphArtifact } from "./types.js";
import { fileExists, readJsonFile } from "./utils.js";
import {
  acceptApproval,
  archiveCandidate,
  listApprovals,
  listCandidates,
  promoteCandidate,
  readApproval,
  rejectApproval
} from "./vault.js";

const execFileAsync = promisify(execFile);

async function readViewerPage(
  rootDir: string,
  relativePath: string
): Promise<{
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  content: string;
} | null> {
  const { paths } = await loadVaultConfig(rootDir);
  const absolutePath = path.resolve(paths.wikiDir, relativePath);
  if (!absolutePath.startsWith(paths.wikiDir) || !(await fileExists(absolutePath))) {
    return null;
  }

  const raw = await fs.readFile(absolutePath, "utf8");
  const parsed = matter(raw);
  return {
    path: relativePath,
    title: typeof parsed.data.title === "string" ? parsed.data.title : path.basename(relativePath, path.extname(relativePath)),
    frontmatter: parsed.data,
    content: parsed.content
  };
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

export async function startGraphServer(rootDir: string, port?: number): Promise<{ port: number; close: () => Promise<void> }> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const effectivePort = port ?? config.viewer.port;
  await ensureViewerDist(paths.viewerDistDir);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${effectivePort}`}`);
    if (url.pathname === "/api/graph") {
      if (!(await fileExists(paths.graphPath))) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Graph artifact not found. Run `swarmvault compile` first." }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(await fs.readFile(paths.graphPath, "utf8"));
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
      const results = searchPages(paths.searchDbPath, query, {
        limit: Number.isFinite(limit) ? limit : 10,
        kind,
        status,
        project
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(results));
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

    if (url.pathname === "/api/reviews" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(await listApprovals(rootDir)));
      return;
    }

    if (url.pathname === "/api/review" && request.method === "GET") {
      const approvalId = url.searchParams.get("id") ?? "";
      if (!approvalId) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Missing approval id." }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(await readApproval(rootDir, approvalId)));
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
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(await listCandidates(rootDir)));
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

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const target = path.join(paths.viewerDistDir, relativePath);
    const fallback = path.join(paths.viewerDistDir, "index.html");
    const filePath = (await fileExists(target)) ? target : fallback;
    if (!(await fileExists(filePath))) {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("Viewer build not found. Run `pnpm build` first.");
      return;
    }

    response.writeHead(200, { "content-type": mime.lookup(filePath) || "text/plain" });
    response.end(await fs.readFile(filePath));
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

export async function exportGraphHtml(rootDir: string, outputPath: string): Promise<string> {
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
            projectIds: page.projectIds,
            content: loaded.content
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
  const embeddedData = JSON.stringify({ graph, pages: pages.filter(Boolean) }, null, 2).replace(/</g, "\\u003c");
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
