import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import matter from "gray-matter";
import mime from "mime-types";
import { loadVaultConfig } from "./config.js";
import { buildContextPack } from "./context-packs.js";
import { doctorVault } from "./doctor.js";
import { buildViewerGraphArtifact } from "./graph-presentation.js";
import { addInput, importInbox, ingestInput } from "./ingest.js";
import { finishMemoryTask, listMemoryTasks, startMemoryTask, updateMemoryTask } from "./memory.js";
import { normalizeOutputAssets } from "./pages.js";
import { doctorRetrieval } from "./retrieval.js";
import { searchPages } from "./search.js";
import { reloadManagedSources } from "./sources.js";
import type { GraphArtifact, GraphReportArtifact, LintFinding } from "./types.js";
import { fileExists, isPathWithin, readJsonFile } from "./utils.js";
import {
  acceptApproval,
  archiveCandidate,
  explainGraphVault,
  lintVault,
  listApprovals,
  listCandidates,
  pathGraphVault,
  promoteCandidate,
  queryGraphVault,
  readApproval,
  rejectApproval
} from "./vault.js";
import { getWatchStatus } from "./watch.js";

/**
 * Module-level event bus that other engine modules (watch, ingest, compile)
 * can call to push activity events to all connected viewers.
 */
export type ViewerEvent = {
  id: string;
  type: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
};

class ViewerEventBus extends EventEmitter {
  publish(event: Omit<ViewerEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }): ViewerEvent {
    const enriched: ViewerEvent = {
      id: event.id ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      type: event.type,
      level: event.level,
      message: event.message,
      meta: event.meta
    };
    this.emit("event", enriched);
    return enriched;
  }
}

export const viewerEventBus = new ViewerEventBus();
viewerEventBus.setMaxListeners(64);

function toViewerLintFindings(findings: LintFinding[]): Array<{
  id: string;
  severity: LintFinding["severity"];
  category: string;
  message: string;
  pageId?: string;
  pagePath?: string;
  nodeId?: string;
  detectedAt?: string;
}> {
  const detectedAt = new Date().toISOString();
  return findings.map((finding, index) => ({
    id: `${finding.code}:${index}`,
    severity: finding.severity,
    category: finding.code,
    message: finding.message,
    pagePath: finding.pagePath,
    detectedAt
  }));
}

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

function slugForClip(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .slice(0, 80);
  return normalized || "clip";
}

async function writeInboxClip(
  rootDir: string,
  body: Record<string, unknown>
): Promise<{ mode: "inbox"; inboxPath: string; result: Awaited<ReturnType<typeof importInbox>> }> {
  const { paths } = await loadVaultConfig(rootDir);
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : typeof body.url === "string" && body.url.trim()
        ? body.url.trim()
        : "Browser Clip";
  const clipUrl = typeof body.url === "string" ? body.url.trim() : "";
  const markdown = typeof body.markdown === "string" ? body.markdown.trim() : "";
  const selectionText = typeof body.selectionText === "string" ? body.selectionText.trim() : "";
  const selectionHtml = typeof body.selectionHtml === "string" ? body.selectionHtml.trim() : "";
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0) : [];
  const now = new Date().toISOString();
  const fileName = `${now.replace(/[:.]/g, "-")}-${slugForClip(title)}.md`;
  const inboxPath = path.join(paths.inboxDir, fileName);
  await fs.mkdir(paths.inboxDir, { recursive: true });
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    clipUrl ? `clip_url: ${JSON.stringify(clipUrl)}` : undefined,
    `captured_at: ${JSON.stringify(now)}`,
    tags.length ? `tags: ${JSON.stringify(tags)}` : undefined,
    "---",
    "",
    `# ${title}`,
    "",
    clipUrl ? `Source: ${clipUrl}` : undefined,
    "",
    markdown || selectionText || selectionHtml || clipUrl,
    selectionHtml && !markdown ? ["", "## Original HTML", "", "```html", selectionHtml, "```"].join("\n") : undefined,
    ""
  ].filter((line): line is string => line !== undefined);
  await fs.writeFile(inboxPath, lines.join("\n"), "utf8");
  const result = await importInbox(rootDir, paths.inboxDir);
  return { mode: "inbox", inboxPath, result };
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

      if (url.pathname === "/api/doctor" && request.method === "GET") {
        const report = await doctorVault(rootDir);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(report));
        return;
      }

      if (url.pathname === "/api/doctor" && request.method === "POST") {
        const body = await readJsonBody(request);
        const report = await doctorVault(rootDir, { repair: body.repair === true });
        if (report.repaired.length) {
          viewerEventBus.publish({
            type: "doctor",
            level: "success",
            message: `Doctor repaired ${report.repaired.join(", ")}.`
          });
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(report));
        return;
      }

      if (url.pathname === "/api/retrieval/repair" && request.method === "POST") {
        const result = await doctorRetrieval(rootDir, { repair: true });
        viewerEventBus.publish({
          type: "retrieval",
          level: result.ok ? "success" : "warning",
          message: result.repaired ? "Retrieval index rebuilt." : "Retrieval repair completed with remaining warnings."
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/context-pack" && request.method === "POST") {
        const body = await readJsonBody(request);
        const goal = typeof body.goal === "string" ? body.goal.trim() : "";
        if (!goal) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing context-pack goal." }));
          return;
        }
        const result = await buildContextPack(rootDir, {
          goal,
          target: typeof body.target === "string" ? body.target.trim() : undefined,
          budgetTokens: typeof body.budgetTokens === "number" ? body.budgetTokens : undefined,
          format: body.format === "llms" || body.format === "json" || body.format === "markdown" ? body.format : undefined
        });
        viewerEventBus.publish({
          type: "memory",
          level: "success",
          message: `Built context pack ${result.pack.id}.`
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/task" && request.method === "POST") {
        const body = await readJsonBody(request);
        const action = url.searchParams.get("action") ?? "start";
        let result: unknown;
        if (action === "start") {
          const goal = typeof body.goal === "string" ? body.goal.trim() : "";
          if (!goal) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Missing task goal." }));
            return;
          }
          result = await startMemoryTask(rootDir, {
            goal,
            target: typeof body.target === "string" ? body.target.trim() : undefined,
            budgetTokens: typeof body.budgetTokens === "number" ? body.budgetTokens : undefined,
            agent: typeof body.agent === "string" ? body.agent.trim() : undefined,
            contextPackId: typeof body.contextPackId === "string" ? body.contextPackId.trim() : undefined
          });
        } else if (action === "update") {
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (!id) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Missing task id." }));
            return;
          }
          result = await updateMemoryTask(rootDir, id, {
            note: typeof body.note === "string" ? body.note : undefined,
            decision: typeof body.decision === "string" ? body.decision : undefined,
            changedPath: typeof body.changedPath === "string" ? body.changedPath : undefined,
            contextPackId: typeof body.contextPackId === "string" ? body.contextPackId : undefined,
            status:
              body.status === "active" || body.status === "blocked" || body.status === "completed" || body.status === "archived"
                ? body.status
                : undefined
          });
        } else if (action === "finish") {
          const id = typeof body.id === "string" ? body.id.trim() : "";
          const outcome = typeof body.outcome === "string" ? body.outcome.trim() : "";
          if (!id || !outcome) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Missing task id or outcome." }));
            return;
          }
          result = await finishMemoryTask(rootDir, id, {
            outcome,
            followUp: typeof body.followUp === "string" ? body.followUp : undefined
          });
        } else {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Invalid task action." }));
          return;
        }
        viewerEventBus.publish({
          type: "memory",
          level: "success",
          message: `Task ${action} completed.`
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
        return;
      }

      if (url.pathname === "/api/source/reload" && request.method === "POST") {
        const body = await readJsonBody(request);
        const result = await reloadManagedSources(rootDir, {
          id: typeof body.id === "string" ? body.id.trim() : undefined,
          all: body.all === true,
          compile: body.compile !== false,
          brief: body.brief !== false,
          guide: body.guide === true,
          review: body.review === true
        });
        viewerEventBus.publish({
          type: "ingest",
          level: "success",
          message: `Reloaded ${result.sources.length} managed source${result.sources.length === 1 ? "" : "s"}.`
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
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
        const approval = await readApproval(rootDir, approvalId, { diff: true });
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

      if (url.pathname === "/api/memory-tasks" && request.method === "GET") {
        const tasks = await listMemoryTasks(rootDir);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(tasks));
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

      if (url.pathname === "/api/lint") {
        try {
          const findings = await lintVault(rootDir);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(toViewerLintFindings(findings)));
        } catch (error) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([]));
          console.warn(`[viewer] /api/lint failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }

      if (url.pathname === "/api/workspace") {
        const reportPath = path.join(paths.wikiDir, "graph", "report.json");
        const [graphRaw, reportRaw, approvalsRaw, candidatesRaw, memoryTasksRaw, watchStatusRaw, lintRaw, doctorRaw] = await Promise.all([
          readJsonFile<GraphArtifact>(paths.graphPath).catch(() => null),
          readJsonFile<GraphReportArtifact>(reportPath).catch(() => null),
          listApprovals(rootDir).catch(() => []),
          listCandidates(rootDir).catch(() => []),
          listMemoryTasks(rootDir).catch(() => []),
          getWatchStatus(rootDir).catch(() => ({ generatedAt: "", watchedRepoRoots: [], pendingSemanticRefresh: [] })),
          lintVault(rootDir).catch(() => [] as LintFinding[]),
          doctorVault(rootDir).catch(() => null)
        ]);
        const viewerGraph = graphRaw ? buildViewerGraphArtifact(graphRaw, { report: reportRaw, full: options.full ?? false }) : null;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            graph: viewerGraph,
            graphReport: reportRaw ?? null,
            approvals: approvalsRaw,
            candidates: candidatesRaw,
            memoryTasks: memoryTasksRaw,
            watchStatus: watchStatusRaw,
            doctor: doctorRaw,
            lintFindings: toViewerLintFindings(lintRaw)
          })
        );
        return;
      }

      if (url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        const send = (event: ViewerEvent) => {
          response.write(`id: ${event.id}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        send({
          id: randomUUID(),
          type: "connected",
          level: "info",
          message: "Activity stream connected.",
          timestamp: new Date().toISOString()
        });
        const listener = (event: ViewerEvent) => send(event);
        viewerEventBus.on("event", listener);
        const heartbeat = setInterval(() => {
          response.write(`: keepalive ${new Date().toISOString()}\n\n`);
        }, 25_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          viewerEventBus.off("event", listener);
        });
        return;
      }

      if (url.pathname === "/api/clip" && request.method === "POST") {
        const body = await readJsonBody(request);
        const clipUrl = typeof body.url === "string" ? body.url.trim() : "";
        const hasInlineClip =
          (typeof body.markdown === "string" && body.markdown.trim().length > 0) ||
          (typeof body.selectionText === "string" && body.selectionText.trim().length > 0) ||
          (typeof body.selectionHtml === "string" && body.selectionHtml.trim().length > 0);
        if (!clipUrl && !hasInlineClip) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Missing url or clip content." }));
          return;
        }
        if (hasInlineClip || body.sourceMode === "inbox") {
          const clip = await writeInboxClip(rootDir, body);
          const imported = clip.result.imported[0];
          response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
          response.end(
            JSON.stringify({
              ok: true,
              mode: clip.mode,
              inboxPath: clip.inboxPath,
              sourceId: imported?.sourceId,
              title: imported?.title ?? (typeof body.title === "string" ? body.title : "Browser Clip"),
              importedCount: clip.result.imported.length,
              skippedCount: clip.result.skipped.length
            })
          );
          return;
        }
        const captured = body.sourceMode === "add" ? (await addInput(rootDir, clipUrl)).manifest : await ingestInput(rootDir, clipUrl);
        response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        response.end(
          JSON.stringify({
            ok: true,
            mode: body.sourceMode === "add" ? "add" : "ingest",
            sourceId: captured.sourceId,
            title: captured.title
          })
        );
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
        const script = `javascript:void((async()=>{const selection=String(getSelection()||'').trim();const payload={url:location.href,title:document.title,sourceMode:selection?'inbox':'add'};if(selection)payload.selectionText=selection;const response=await fetch('http://localhost:${effectivePort}/api/clip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error||response.statusText);alert('Clipped: '+(data.title||data.sourceId));})().catch(e=>alert('Clip failed: '+e.message)))`;
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
