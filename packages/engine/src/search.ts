import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GraphPage, SearchResult } from "./types.js";
import { ensureDir } from "./utils.js";

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

export async function rebuildSearchIndex(dbPath: string, pages: GraphPage[], wikiDir: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL
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

  const insertPage = db.prepare("INSERT INTO pages (id, path, title, body) VALUES (?, ?, ?, ?)");

  for (const page of pages) {
    const absolutePath = path.join(wikiDir, page.path);
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    insertPage.run(page.id, page.path, page.title, parsed.content);
  }

  db.exec("INSERT INTO page_search (rowid, title, body) SELECT rowid, title, body FROM pages;");
  db.close();
}

export function searchPages(dbPath: string, query: string, limit = 5): SearchResult[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }
  const DatabaseSync = getDatabaseSync();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const statement = db.prepare(`
    SELECT
      pages.id AS pageId,
      pages.path AS path,
      pages.title AS title,
      snippet(page_search, 1, '[', ']', '...', 16) AS snippet,
      bm25(page_search) AS rank
    FROM page_search
    JOIN pages ON pages.rowid = page_search.rowid
    WHERE page_search MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  const rows = statement.all(ftsQuery, limit) as Array<Record<string, unknown>>;
  db.close();
  return rows.map((row) => ({
    pageId: String(row.pageId ?? ""),
    path: String(row.path ?? ""),
    title: String(row.title ?? ""),
    snippet: String(row.snippet ?? ""),
    rank: Number(row.rank ?? 0)
  }));
}
