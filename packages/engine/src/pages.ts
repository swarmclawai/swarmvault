import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GraphPage, OutputOrigin, PageManager, PageStatus } from "./types.js";
import { fileExists, listFilesRecursive, sha256, slugify, toPosix } from "./utils.js";

export interface StoredPage {
  page: GraphPage;
  content: string;
  contentHash: string;
}

export function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeSourceHashes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
  );
}

export function normalizePageStatus(value: unknown, fallback: PageStatus = "active"): PageStatus {
  return value === "draft" || value === "candidate" || value === "active" || value === "archived" ? value : fallback;
}

export function normalizePageManager(value: unknown, fallback: PageManager = "system"): PageManager {
  return value === "human" || value === "system" ? value : fallback;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

export async function loadExistingManagedPageState(
  absolutePath: string,
  defaults: {
    status?: PageStatus;
    managedBy?: PageManager;
    createdAt?: string;
    updatedAt?: string;
  } = {}
): Promise<{
  status: PageStatus;
  managedBy: PageManager;
  createdAt: string;
  updatedAt: string;
}> {
  const now = new Date().toISOString();
  const createdFallback = defaults.createdAt ?? now;
  const updatedFallback = defaults.updatedAt ?? createdFallback;

  if (!(await fileExists(absolutePath))) {
    return {
      status: defaults.status ?? "active",
      managedBy: defaults.managedBy ?? "system",
      createdAt: createdFallback,
      updatedAt: updatedFallback
    };
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const parsed = matter(content);

  return {
    status: normalizePageStatus(parsed.data.status, defaults.status ?? "active"),
    managedBy: normalizePageManager(parsed.data.managed_by, defaults.managedBy ?? "system"),
    createdAt: normalizeTimestamp(parsed.data.created_at, createdFallback),
    updatedAt: normalizeTimestamp(parsed.data.updated_at, updatedFallback)
  };
}

export async function loadInsightPages(wikiDir: string): Promise<StoredPage[]> {
  const insightsDir = path.join(wikiDir, "insights");
  if (!(await fileExists(insightsDir))) {
    return [];
  }

  const files = (await listFilesRecursive(insightsDir))
    .filter((filePath) => filePath.endsWith(".md"))
    .filter((filePath) => path.basename(filePath) !== "index.md")
    .sort((left, right) => left.localeCompare(right));

  const insights: StoredPage[] = [];
  for (const absolutePath of files) {
    const relativePath = toPosix(path.relative(wikiDir, absolutePath));
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    const stats = await fs.stat(absolutePath);
    const title = typeof parsed.data.title === "string" ? parsed.data.title : path.basename(absolutePath, ".md");
    const sourceIds = normalizeStringArray(parsed.data.source_ids);
    const nodeIds = normalizeStringArray(parsed.data.node_ids);
    const relatedPageIds = normalizeStringArray(parsed.data.related_page_ids);
    const relatedNodeIds = normalizeStringArray(parsed.data.related_node_ids);
    const relatedSourceIds = normalizeStringArray(parsed.data.related_source_ids);
    const backlinks = normalizeStringArray(parsed.data.backlinks);
    const compiledFrom = normalizeStringArray(parsed.data.compiled_from);
    const fallbackCreatedAt = stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : stats.mtime.toISOString();
    const fallbackUpdatedAt = stats.mtime.toISOString();
    const slugSource = relativePath.replace(/^insights\//, "").replace(/\.md$/, "");

    insights.push({
      page: {
        id: typeof parsed.data.page_id === "string" ? parsed.data.page_id : `insight:${slugify(slugSource)}`,
        path: relativePath,
        title,
        kind: "insight",
        sourceIds,
        nodeIds,
        freshness: parsed.data.freshness === "stale" ? "stale" : "fresh",
        status: normalizePageStatus(parsed.data.status, "active"),
        confidence: typeof parsed.data.confidence === "number" ? parsed.data.confidence : 1,
        backlinks,
        schemaHash: typeof parsed.data.schema_hash === "string" ? parsed.data.schema_hash : "",
        sourceHashes: normalizeSourceHashes(parsed.data.source_hashes),
        relatedPageIds,
        relatedNodeIds,
        relatedSourceIds,
        createdAt: normalizeTimestamp(parsed.data.created_at, fallbackCreatedAt),
        updatedAt: normalizeTimestamp(parsed.data.updated_at, fallbackUpdatedAt),
        compiledFrom: compiledFrom.length ? compiledFrom : sourceIds,
        managedBy: normalizePageManager(parsed.data.managed_by, "human"),
        origin: typeof parsed.data.origin === "string" ? (parsed.data.origin as OutputOrigin) : undefined,
        question: typeof parsed.data.question === "string" ? parsed.data.question : undefined
      },
      content,
      contentHash: sha256(content)
    });
  }

  return insights.sort((left, right) => left.page.title.localeCompare(right.page.title));
}
