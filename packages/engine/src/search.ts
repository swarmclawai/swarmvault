import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { tokenize } from "./tokenize.js";
import type { GraphPage, PageKind, PageStatus, SearchResult, SourceCaptureType, SourceClass, SourceManifest } from "./types.js";
import { ensureDir } from "./utils.js";

export interface SearchPageFilters {
  kind?: string;
  status?: string;
  project?: string;
  sourceType?: string;
  sourceClass?: string;
}

export interface SearchQueryOptions extends SearchPageFilters {
  limit?: number;
}

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;

function warningMessage(warning: string | Error): string {
  return warning instanceof Error ? warning.message : String(warning);
}

function warningType(warning: string | Error, type?: string): string | undefined {
  if (warning instanceof Error) {
    return warning.name;
  }
  return typeof type === "string" ? type : undefined;
}

function isSqliteExperimentalWarning(warning: string | Error, type?: string): boolean {
  return warningType(warning, type) === "ExperimentalWarning" && warningMessage(warning).includes("SQLite is an experimental feature");
}

function withSuppressedSqliteExperimentalWarning<T>(run: () => T): T {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, options?: string | Error | Record<string, unknown>, ...args: unknown[]) => {
    const type =
      typeof options === "string"
        ? options
        : typeof (options as { type?: unknown } | undefined)?.type === "string"
          ? ((options as { type?: string }).type ?? undefined)
          : undefined;
    if (isSqliteExperimentalWarning(warning, type)) {
      return;
    }
    return originalEmitWarning(warning as never, options as never, ...(args as never[]));
  }) as typeof process.emitWarning;
  try {
    return run();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function getDatabaseSync(): DatabaseSyncCtor {
  const builtin = withSuppressedSqliteExperimentalWarning(
    () => process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined
  );
  if (!builtin?.DatabaseSync) {
    throw new Error("node:sqlite is unavailable in this Node runtime.");
  }
  return builtin.DatabaseSync;
}

function toFtsQuery(query: string): string {
  return tokenize(query).join(" OR ");
}

function normalizeKind(value: unknown): PageKind | undefined {
  return value === "index" ||
    value === "source" ||
    value === "module" ||
    value === "concept" ||
    value === "entity" ||
    value === "output" ||
    value === "insight" ||
    value === "graph_report" ||
    value === "community_summary"
    ? value
    : undefined;
}

function normalizeStatus(value: unknown): PageStatus | undefined {
  return value === "draft" || value === "candidate" || value === "active" || value === "archived" ? value : undefined;
}

function normalizeSourceType(value: unknown): SourceCaptureType | undefined {
  return value === "arxiv" || value === "doi" || value === "tweet" || value === "article" || value === "url" ? value : undefined;
}

function normalizeSourceClass(value: unknown): SourceClass | undefined {
  return value === "first_party" || value === "third_party" || value === "resource" || value === "generated" ? value : undefined;
}

export async function rebuildSearchIndex(dbPath: string, pages: GraphPage[], wikiDir: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    DROP TABLE IF EXISTS page_search;
    DROP TABLE IF EXISTS pages;
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_class TEXT NOT NULL,
      project_ids TEXT NOT NULL,
      project_key TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
      title,
      body,
      content='pages',
      content_rowid='rowid'
    );
    DELETE FROM page_search;
    DELETE FROM pages;
  `);

  const insertPage = db.prepare(
    "INSERT INTO pages (id, path, title, body, kind, status, source_type, source_class, project_ids, project_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const rootDir = path.dirname(wikiDir);

  for (const page of pages) {
    const absolutePath = path.join(wikiDir, page.path);
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    let body = parsed.content;
    const primarySourceId =
      Array.isArray(parsed.data.source_ids) && typeof parsed.data.source_ids[0] === "string"
        ? parsed.data.source_ids[0]
        : page.sourceIds[0];
    if ((page.kind === "source" || page.kind === "module") && primarySourceId) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(rootDir, "state", "manifests", `${primarySourceId}.json`), "utf8")
        ) as SourceManifest;
        const excerptPath = manifest.extractedTextPath ?? manifest.storedPath;
        if (excerptPath) {
          const excerpt = await fs.readFile(path.join(rootDir, excerptPath), "utf8");
          if (excerpt.trim()) {
            body = `${body}\n\n## Source Excerpt\n\n${excerpt.trim()}`.trim();
          }
        }
      } catch {
        // Leave the page searchable via its generated markdown alone when source excerpts are unavailable.
      }
    }
    insertPage.run(
      page.id,
      page.path,
      page.title,
      body,
      page.kind,
      page.status,
      typeof parsed.data.source_type === "string" ? parsed.data.source_type : "",
      typeof parsed.data.source_class === "string" ? parsed.data.source_class : "",
      JSON.stringify(page.projectIds),
      page.projectIds.map((projectId) => `|${projectId}|`).join("")
    );
  }

  db.exec("INSERT INTO page_search (rowid, title, body) SELECT rowid, title, body FROM pages;");
  db.close();
}

/**
 * Merge FTS and semantic results using reciprocal rank fusion (RRF).
 * k=60 is the standard constant from the original RRF paper.
 */
export function mergeSearchResults(
  ftsResults: SearchResult[],
  semanticHits: Array<{ pageId: string; path: string; title: string; kind: string; status: string; score: number }>,
  limit: number
): SearchResult[] {
  const k = 60;
  const scores = new Map<string, number>();
  const resultMap = new Map<string, SearchResult>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    scores.set(r.pageId, (scores.get(r.pageId) ?? 0) + 1 / (k + i + 1));
    resultMap.set(r.pageId, r);
  }

  for (let i = 0; i < semanticHits.length; i++) {
    const hit = semanticHits[i];
    scores.set(hit.pageId, (scores.get(hit.pageId) ?? 0) + 1 / (k + i + 1));
    if (!resultMap.has(hit.pageId)) {
      resultMap.set(hit.pageId, {
        pageId: hit.pageId,
        path: hit.path,
        title: hit.title,
        snippet: "",
        rank: -hit.score,
        kind: hit.kind as SearchResult["kind"],
        status: hit.status as SearchResult["status"],
        projectIds: [],
        sourceType: undefined,
        sourceClass: undefined
      });
    }
  }

  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([pageId, rrfScore]) => {
      const result = resultMap.get(pageId)!;
      return { ...result, rank: -rrfScore };
    });
}

export function searchPages(dbPath: string, query: string, limitOrOptions: number | SearchQueryOptions = 5): SearchResult[] {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath, { readOnly: true }));
  const clauses = ["page_search MATCH ?"];
  const params: Array<number | string> = [ftsQuery];

  if (options.kind && options.kind !== "all") {
    clauses.push("pages.kind = ?");
    params.push(options.kind);
  }
  if (options.status && options.status !== "all") {
    clauses.push("pages.status = ?");
    params.push(options.status);
  }
  if (options.project && options.project !== "all") {
    if (options.project === "unassigned") {
      clauses.push("pages.project_key = ''");
    } else {
      clauses.push("pages.project_key LIKE ?");
      params.push(`%|${options.project}|%`);
    }
  }
  if (options.sourceType && options.sourceType !== "all") {
    clauses.push("pages.source_type = ?");
    params.push(options.sourceType);
  }
  if (options.sourceClass && options.sourceClass !== "all") {
    clauses.push("pages.source_class = ?");
    params.push(options.sourceClass);
  }

  const statement = db.prepare(`
    SELECT
      pages.id AS pageId,
      pages.path AS path,
      pages.title AS title,
      pages.kind AS kind,
      pages.status AS status,
      pages.source_type AS sourceType,
      pages.source_class AS sourceClass,
      pages.project_ids AS projectIds,
      snippet(page_search, 1, '[', ']', '...', 16) AS snippet,
      bm25(page_search) AS rank
    FROM page_search
    JOIN pages ON pages.rowid = page_search.rowid
    WHERE ${clauses.join(" AND ")}
    ORDER BY
      CASE pages.status
        WHEN 'active' THEN 0
        WHEN 'draft' THEN 1
        WHEN 'candidate' THEN 2
        ELSE 3
      END,
      CASE pages.kind
        WHEN 'source' THEN 0
        WHEN 'module' THEN 1
        WHEN 'output' THEN 2
        WHEN 'insight' THEN 3
        WHEN 'graph_report' THEN 4
        WHEN 'community_summary' THEN 5
        WHEN 'concept' THEN 6
        WHEN 'entity' THEN 7
        ELSE 8
      END,
      rank
    LIMIT ?
  `);
  params.push(options.limit ?? 5);
  const rows = statement.all(...params) as Array<Record<string, unknown>>;
  db.close();
  return rows.map((row) => ({
    projectIds: (() => {
      const raw = String(row.projectIds ?? "[]");
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        return [];
      }
    })(),
    pageId: String(row.pageId ?? ""),
    path: String(row.path ?? ""),
    title: String(row.title ?? ""),
    kind: normalizeKind(row.kind),
    status: normalizeStatus(row.status),
    sourceType: normalizeSourceType(row.sourceType),
    sourceClass: normalizeSourceClass(row.sourceClass),
    snippet: String(row.snippet ?? ""),
    rank: Number(row.rank ?? 0)
  }));
}
