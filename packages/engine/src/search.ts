import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GraphPage, PageKind, PageStatus, SearchResult } from "./types.js";
import { ensureDir } from "./utils.js";

export interface SearchPageFilters {
  kind?: string;
  status?: string;
  project?: string;
}

export interface SearchQueryOptions extends SearchPageFilters {
  limit?: number;
}

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;

function getDatabaseSync(): DatabaseSyncCtor {
  const builtin = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!builtin?.DatabaseSync) {
    throw new Error("node:sqlite is unavailable in this Node runtime.");
  }
  return builtin.DatabaseSync;
}

function toFtsQuery(query: string): string {
  const tokens =
    query
      .toLowerCase()
      .match(/[a-z0-9]{2,}/g)
      ?.filter(Boolean) ?? [];
  return tokens.join(" OR ");
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

export async function rebuildSearchIndex(dbPath: string, pages: GraphPage[], wikiDir: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath);
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
    "INSERT INTO pages (id, path, title, body, kind, status, project_ids, project_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (const page of pages) {
    const absolutePath = path.join(wikiDir, page.path);
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    insertPage.run(
      page.id,
      page.path,
      page.title,
      parsed.content,
      page.kind,
      page.status,
      JSON.stringify(page.projectIds),
      page.projectIds.map((projectId) => `|${projectId}|`).join("")
    );
  }

  db.exec("INSERT INTO page_search (rowid, title, body) SELECT rowid, title, body FROM pages;");
  db.close();
}

export function searchPages(dbPath: string, query: string, limitOrOptions: number | SearchQueryOptions = 5): SearchResult[] {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
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

  const statement = db.prepare(`
    SELECT
      pages.id AS pageId,
      pages.path AS path,
      pages.title AS title,
      pages.kind AS kind,
      pages.status AS status,
      pages.project_ids AS projectIds,
      snippet(page_search, 1, '[', ']', '...', 16) AS snippet,
      bm25(page_search) AS rank
    FROM page_search
    JOIN pages ON pages.rowid = page_search.rowid
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank
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
    snippet: String(row.snippet ?? ""),
    rank: Number(row.rank ?? 0)
  }));
}
