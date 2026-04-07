import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { initWorkspace } from "./config.js";
import type { GraphArtifact, PendingSemanticRefreshEntry, WatchStatusResult } from "./types.js";
import { ensureDir, fileExists, readJsonFile, toPosix, writeFileIfChanged, writeJsonFile } from "./utils.js";

function pendingEntryKey(entry: PendingSemanticRefreshEntry): string {
  return entry.path;
}

function sortPending(entries: PendingSemanticRefreshEntry[]): PendingSemanticRefreshEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.detectedAt.localeCompare(right.detectedAt) || left.id.localeCompare(right.id)
  );
}

function normalizeRelativePath(rootDir: string, filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  return toPosix(path.relative(rootDir, path.resolve(filePath)));
}

export async function readPendingSemanticRefresh(rootDir: string): Promise<PendingSemanticRefreshEntry[]> {
  const { paths } = await initWorkspace(rootDir);
  const entries = await readJsonFile<PendingSemanticRefreshEntry[]>(paths.pendingSemanticRefreshPath);
  return Array.isArray(entries) ? sortPending(entries) : [];
}

export async function writePendingSemanticRefresh(
  rootDir: string,
  entries: PendingSemanticRefreshEntry[]
): Promise<PendingSemanticRefreshEntry[]> {
  const { paths } = await initWorkspace(rootDir);
  await ensureDir(paths.watchDir);
  const normalized = sortPending(entries);
  await writeJsonFile(paths.pendingSemanticRefreshPath, normalized);
  return normalized;
}

export async function mergePendingSemanticRefresh(
  rootDir: string,
  entries: PendingSemanticRefreshEntry[]
): Promise<PendingSemanticRefreshEntry[]> {
  const existing = await readPendingSemanticRefresh(rootDir);
  const merged = new Map(existing.map((entry) => [pendingEntryKey(entry), entry]));
  for (const entry of entries) {
    merged.set(pendingEntryKey(entry), entry);
  }
  return writePendingSemanticRefresh(rootDir, [...merged.values()]);
}

export async function clearPendingSemanticRefreshEntries(
  rootDir: string,
  targets: {
    sourceId?: string;
    originalPath?: string;
    relativePath?: string;
  }
): Promise<PendingSemanticRefreshEntry[]> {
  const existing = await readPendingSemanticRefresh(rootDir);
  const relativePath = targets.relativePath ?? normalizeRelativePath(rootDir, targets.originalPath);
  return writePendingSemanticRefresh(
    rootDir,
    existing.filter((entry) => {
      if (targets.sourceId && entry.sourceId === targets.sourceId) {
        return false;
      }
      if (relativePath && entry.path === relativePath) {
        return false;
      }
      return true;
    })
  );
}

export async function readWatchStatusArtifact(rootDir: string): Promise<WatchStatusResult | null> {
  const { paths } = await initWorkspace(rootDir);
  return readJsonFile<WatchStatusResult>(paths.watchStatusPath);
}

export async function writeWatchStatusArtifact(rootDir: string, status: WatchStatusResult): Promise<void> {
  const { paths } = await initWorkspace(rootDir);
  await ensureDir(paths.watchDir);
  await writeJsonFile(paths.watchStatusPath, status);
}

export async function markPagesStaleForSources(rootDir: string, sourceIds: string[]): Promise<string[]> {
  const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];
  if (!uniqueSourceIds.length) {
    return [];
  }

  const { paths } = await initWorkspace(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    return [];
  }

  const affectedSourceIds = new Set(uniqueSourceIds);
  const now = new Date().toISOString();
  let graphChanged = false;
  const affectedPagePaths: string[] = [];

  const nextPages = graph.pages.map((page) => {
    if (page.freshness === "stale" || !page.sourceIds.some((sourceId) => affectedSourceIds.has(sourceId))) {
      return page;
    }
    graphChanged = true;
    affectedPagePaths.push(page.path);
    return {
      ...page,
      freshness: "stale",
      updatedAt: now
    };
  });

  const nextNodes = graph.nodes.map((node) => {
    if (node.freshness === "stale" || !node.sourceIds.some((sourceId) => affectedSourceIds.has(sourceId))) {
      return node;
    }
    graphChanged = true;
    return {
      ...node,
      freshness: "stale"
    };
  });

  if (graphChanged) {
    await writeJsonFile(paths.graphPath, {
      ...graph,
      nodes: nextNodes,
      pages: nextPages
    });
  }

  for (const page of nextPages) {
    if (page.freshness !== "stale" || !page.sourceIds.some((sourceId) => affectedSourceIds.has(sourceId))) {
      continue;
    }
    const absolutePath = path.join(paths.wikiDir, page.path);
    if (!(await fileExists(absolutePath))) {
      continue;
    }
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(raw);
    if (parsed.data.freshness === "stale") {
      continue;
    }
    parsed.data.freshness = "stale";
    parsed.data.updated_at = now;
    await writeFileIfChanged(absolutePath, matter.stringify(parsed.content, parsed.data));
  }

  return affectedPagePaths;
}
