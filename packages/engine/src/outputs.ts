import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  normalizePageManager,
  normalizePageStatus,
  normalizeProjectIds,
  normalizeSourceHashes,
  normalizeStringArray,
  type StoredPage
} from "./pages.js";
import type { GraphPage, OutputFormat, OutputOrigin } from "./types.js";
import { fileExists, sha256 } from "./utils.js";

function relationRank(outputPage: GraphPage, targetPage: GraphPage): number {
  if (outputPage.relatedPageIds.includes(targetPage.id)) {
    return 3;
  }

  if (outputPage.relatedNodeIds.some((nodeId) => targetPage.nodeIds.includes(nodeId))) {
    return 2;
  }

  if (outputPage.relatedSourceIds.some((sourceId) => targetPage.sourceIds.includes(sourceId))) {
    return 1;
  }

  return 0;
}

export function relatedOutputsForPage(targetPage: GraphPage, outputPages: GraphPage[]): GraphPage[] {
  return outputPages
    .map((page) => ({ page, rank: relationRank(page, targetPage) }))
    .filter((item) => item.rank > 0)
    .sort((left, right) => right.rank - left.rank || left.page.title.localeCompare(right.page.title))
    .map((item) => item.page);
}

export async function resolveUniqueOutputSlug(wikiDir: string, baseSlug: string): Promise<string> {
  const outputsDir = path.join(wikiDir, "outputs");
  const root = baseSlug || "output";
  let candidate = root;
  let counter = 2;

  while (await fileExists(path.join(outputsDir, `${candidate}.md`))) {
    candidate = `${root}-${counter}`;
    counter++;
  }

  return candidate;
}

export async function loadSavedOutputPages(wikiDir: string): Promise<StoredPage[]> {
  const outputsDir = path.join(wikiDir, "outputs");
  const entries = await fs.readdir(outputsDir, { withFileTypes: true }).catch(() => []);
  const outputs: StoredPage[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
      continue;
    }

    const relativePath = path.posix.join("outputs", entry.name);
    const absolutePath = path.join(outputsDir, entry.name);
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    const slug = entry.name.replace(/\.md$/, "");
    const title = typeof parsed.data.title === "string" ? parsed.data.title : slug;
    const pageId = typeof parsed.data.page_id === "string" ? parsed.data.page_id : `output:${slug}`;
    const sourceIds = normalizeStringArray(parsed.data.source_ids);
    const projectIds = normalizeProjectIds(parsed.data.project_ids);
    const nodeIds = normalizeStringArray(parsed.data.node_ids);
    const relatedPageIds = normalizeStringArray(parsed.data.related_page_ids);
    const relatedNodeIds = normalizeStringArray(parsed.data.related_node_ids);
    const relatedSourceIds = normalizeStringArray(parsed.data.related_source_ids);
    const backlinks = normalizeStringArray(parsed.data.backlinks);
    const compiledFrom = normalizeStringArray(parsed.data.compiled_from);
    const stats = await fs.stat(absolutePath);
    const createdAt =
      typeof parsed.data.created_at === "string"
        ? parsed.data.created_at
        : stats.birthtimeMs > 0
          ? stats.birthtime.toISOString()
          : stats.mtime.toISOString();
    const updatedAt = typeof parsed.data.updated_at === "string" ? parsed.data.updated_at : stats.mtime.toISOString();

    outputs.push({
      page: {
        id: pageId,
        path: relativePath,
        title,
        kind: "output",
        sourceIds,
        projectIds,
        nodeIds,
        freshness: parsed.data.freshness === "stale" ? "stale" : "fresh",
        status: normalizePageStatus(parsed.data.status, "active"),
        confidence: typeof parsed.data.confidence === "number" ? parsed.data.confidence : 0.74,
        backlinks,
        schemaHash: typeof parsed.data.schema_hash === "string" ? parsed.data.schema_hash : "",
        sourceHashes: normalizeSourceHashes(parsed.data.source_hashes),
        relatedPageIds,
        relatedNodeIds,
        relatedSourceIds,
        createdAt,
        updatedAt,
        compiledFrom: compiledFrom.length ? compiledFrom : relatedSourceIds,
        managedBy: normalizePageManager(parsed.data.managed_by, "system"),
        origin: typeof parsed.data.origin === "string" ? (parsed.data.origin as OutputOrigin) : undefined,
        question: typeof parsed.data.question === "string" ? parsed.data.question : undefined,
        outputFormat:
          parsed.data.output_format === "report" || parsed.data.output_format === "slides"
            ? (parsed.data.output_format as OutputFormat)
            : "markdown"
      },
      content,
      contentHash: sha256(content)
    });
  }

  return outputs.sort((left, right) => left.page.title.localeCompare(right.page.title));
}
