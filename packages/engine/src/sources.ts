import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { JSDOM } from "jsdom";
import { loadVaultConfig } from "./config.js";
import { ingestDirectory, ingestInputDetailed, listManifests, removeManifestBySourceId, validateUrlSafety } from "./ingest.js";
import { buildOutputPage } from "./markdown.js";
import { parseStoredPage } from "./pages.js";
import { getProviderForTask } from "./providers/registry.js";
import { buildSchemaPrompt, loadVaultSchemas } from "./schema.js";
import { ensureManagedSourcesArtifact, loadManagedSources, managedSourceWorkingDir, saveManagedSources } from "./source-registry.js";
import {
  findLatestGuidedSourceSessionByScope,
  guidedSourceSessionStatePath,
  readGuidedSourceSession,
  writeGuidedSourceSession
} from "./source-sessions.js";
import type {
  GraphArtifact,
  GuidedSourceSessionAnswers,
  GuidedSourceSessionQuestion,
  GuidedSourceSessionRecord,
  ManagedSourceAddOptions,
  ManagedSourceAddResult,
  ManagedSourceDeleteResult,
  ManagedSourceKind,
  ManagedSourceRecord,
  ManagedSourceReloadOptions,
  ManagedSourceReloadResult,
  ManagedSourceStatus,
  ManagedSourceSyncCounts,
  SourceAnalysis,
  SourceGuideResult,
  SourceManifest,
  SourceReviewResult
} from "./types.js";
import { ensureDir, fileExists, normalizeWhitespace, readJsonFile, sha256, slugify, truncate, uniqueBy } from "./utils.js";
import { compileVault, readGraphReport, refreshVaultAfterOutputSave, stageGeneratedOutputPages } from "./vault.js";

const DEFAULT_CRAWL_MAX_PAGES = 12;
const DEFAULT_CRAWL_MAX_DEPTH = 2;
const DOCS_HINT_SEGMENTS = new Set([
  "docs",
  "documentation",
  "wiki",
  "help",
  "reference",
  "references",
  "guide",
  "guides",
  "tutorial",
  "tutorials",
  "manual",
  "api",
  "apis",
  "getting-started"
]);

type ManagedSourceInput =
  | { kind: "directory"; path: string; repoRoot: string; title: string }
  | { kind: "file"; path: string; title: string }
  | { kind: "github_repo"; url: string; cloneUrl: string; title: string }
  | { kind: "crawl_url"; url: string; title: string };

type ManagedSourceSyncResult = {
  sourceIds: string[];
  title: string;
  counts: ManagedSourceSyncCounts;
  changed: boolean;
};

type DocsCrawlResult = {
  title: string;
  pages: string[];
};

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function normalizeManagedStatus(value: ManagedSourceStatus | undefined): ManagedSourceStatus {
  return value === "missing" || value === "error" ? value : "ready";
}

function withinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findNearestGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function normalizeUrlWithoutHash(input: string): string {
  const url = new URL(input);
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  return url.toString();
}

function normalizeGitHubRepoRootUrl(input: string): { url: string; cloneUrl: string; title: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }
  const segments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }
  const [owner, repoSegment] = segments;
  const repo = repoSegment.replace(/\.git$/i, "");
  if (!owner || !repo) {
    return null;
  }
  const url = `https://github.com/${owner}/${repo}`;
  return {
    url,
    cloneUrl: `${url}.git`,
    title: `${owner}/${repo}`
  };
}

function looksLikeDocsPathname(pathname: string): boolean {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
  return segments.some((segment) => DOCS_HINT_SEGMENTS.has(segment));
}

function isLikelyDocsStartUrl(url: URL): boolean {
  return looksLikeDocsPathname(url.pathname) || url.hostname.toLowerCase().startsWith("docs.");
}

function normalizeCrawlCandidate(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    if (url.hash) {
      url.hash = "";
    }
    return url.toString();
  } catch {
    return null;
  }
}

function pathPrefix(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments[0]}`;
}

function isAllowedDocsCandidate(candidate: URL, startUrl: URL): boolean {
  if (candidate.origin !== startUrl.origin) {
    return false;
  }
  const extension = path.extname(candidate.pathname).toLowerCase();
  if (extension && extension !== ".html" && extension !== ".htm" && extension !== ".md") {
    return false;
  }
  if (looksLikeDocsPathname(candidate.pathname)) {
    return true;
  }
  const startPrefix = pathPrefix(startUrl.pathname);
  const candidatePrefix = pathPrefix(candidate.pathname);
  return startPrefix !== "/" && candidatePrefix === startPrefix;
}

async function fetchHtml(url: string): Promise<{ title: string; links: string[] }> {
  await validateUrlSafety(url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "text/html";
  if (!contentType.includes("html")) {
    throw new Error(`Unsupported docs crawl content type at ${url}: ${contentType}`);
  }
  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const title = document.title.trim() || url;
  const links = [...document.querySelectorAll("a[href]")]
    .map((anchor) => normalizeCrawlCandidate(anchor.getAttribute("href") ?? "", url))
    .filter((value): value is string => Boolean(value));
  return { title, links };
}

async function crawlDocsSource(url: string, maxPages: number, maxDepth: number): Promise<DocsCrawlResult> {
  const startUrl = new URL(normalizeUrlWithoutHash(url));
  const initial = await fetchHtml(startUrl.toString());
  const sameDomainDocsLinks = uniqueStrings(
    initial.links.filter((candidate) => {
      const parsed = new URL(candidate);
      return isAllowedDocsCandidate(parsed, startUrl);
    })
  );
  if (!isLikelyDocsStartUrl(startUrl) && sameDomainDocsLinks.length < 3) {
    throw new Error(
      "This URL does not look like a docs hub. Use `swarmvault add` for single articles or `swarmvault ingest` for direct files."
    );
  }

  const visited = new Set<string>();
  const queued = new Set<string>();
  const pages: string[] = [];
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl.toString(), depth: 0 }];
  queued.add(startUrl.toString());

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (visited.has(current.url)) {
      continue;
    }
    visited.add(current.url);
    pages.push(current.url);
    if (current.depth >= maxDepth) {
      continue;
    }

    const { links } = await fetchHtml(current.url);
    for (const candidate of links) {
      if (pages.length + queue.length >= maxPages) {
        break;
      }
      if (queued.has(candidate) || visited.has(candidate)) {
        continue;
      }
      const parsed = new URL(candidate);
      if (!isAllowedDocsCandidate(parsed, startUrl)) {
        continue;
      }
      queued.add(candidate);
      queue.push({ url: candidate, depth: current.depth + 1 });
    }
  }

  return {
    title: initial.title,
    pages
  };
}

function stableManagedSourceId(kind: ManagedSourceKind, raw: string, fallbackTitle: string): string {
  return `${kind}-${slugify(fallbackTitle)}-${sha256(raw).slice(0, 8)}`;
}

function matchesManagedSourceSpec(existing: ManagedSourceRecord, input: ManagedSourceInput): boolean {
  if (existing.kind !== input.kind) {
    return false;
  }
  if (input.kind === "directory" || input.kind === "file") {
    return path.resolve(existing.path ?? "") === path.resolve(input.path);
  }
  return (existing.url ?? "") === input.url;
}

async function resolveManagedSourceInput(rootDir: string, input: string): Promise<ManagedSourceInput> {
  const absoluteInput = path.resolve(rootDir, input);
  if (!(input.startsWith("http://") || input.startsWith("https://"))) {
    const stat = await fs.stat(absoluteInput).catch(() => null);
    if (!stat) {
      throw new Error(`Source not found: ${input}`);
    }
    if (stat.isFile()) {
      return {
        kind: "file",
        path: absoluteInput,
        title: path.basename(absoluteInput, path.extname(absoluteInput)) || absoluteInput
      };
    }
    if (!stat.isDirectory()) {
      throw new Error("`swarmvault source add` supports local files, directories, public GitHub repo root URLs, and docs hubs.");
    }
    const detectedRepoRoot = await findNearestGitRoot(absoluteInput);
    const repoRoot =
      detectedRepoRoot && !(withinRoot(rootDir, absoluteInput) && !withinRoot(rootDir, detectedRepoRoot))
        ? detectedRepoRoot
        : absoluteInput;
    return {
      kind: "directory",
      path: absoluteInput,
      repoRoot,
      title: path.basename(absoluteInput) || absoluteInput
    };
  }

  const github = normalizeGitHubRepoRootUrl(input);
  if (github) {
    return {
      kind: "github_repo",
      ...github
    };
  }

  const parsed = new URL(input);
  if (parsed.hostname.toLowerCase().includes("github.com")) {
    throw new Error(
      "`swarmvault source add` only supports public GitHub repo root URLs. Use a repo root like https://github.com/owner/repo."
    );
  }
  return {
    kind: "crawl_url",
    url: normalizeUrlWithoutHash(input),
    title: parsed.hostname
  };
}

function directorySourceIdsFor(manifests: SourceManifest[], inputPath: string): string[] {
  return manifests
    .filter((manifest) => manifest.originalPath && withinRoot(path.resolve(inputPath), path.resolve(manifest.originalPath)))
    .map((manifest) => manifest.sourceId)
    .sort((left, right) => left.localeCompare(right));
}

function fileSourceIdsFor(manifests: SourceManifest[], inputPath: string): string[] {
  const absoluteInput = path.resolve(inputPath);
  return manifests
    .filter((manifest) => manifest.originalPath && path.resolve(manifest.originalPath) === absoluteInput)
    .map((manifest) => manifest.sourceId)
    .sort((left, right) => left.localeCompare(right));
}

async function syncDirectorySource(rootDir: string, inputPath: string, repoRoot: string): Promise<ManagedSourceSyncResult> {
  const manifestsBefore = await listManifests(rootDir);
  const previousInScope = manifestsBefore.filter(
    (manifest) => manifest.originalPath && withinRoot(path.resolve(inputPath), path.resolve(manifest.originalPath))
  );
  const result = await ingestDirectory(rootDir, inputPath, { repoRoot });
  const removed: string[] = [];
  for (const manifest of previousInScope) {
    if (!manifest.originalPath) {
      continue;
    }
    if (await fileExists(path.resolve(manifest.originalPath))) {
      continue;
    }
    const removedManifest = await removeManifestBySourceId(rootDir, manifest.sourceId);
    if (removedManifest) {
      removed.push(removedManifest.sourceId);
    }
  }
  const manifestsAfter = await listManifests(rootDir);
  return {
    title: path.basename(inputPath) || inputPath,
    sourceIds: directorySourceIdsFor(manifestsAfter, inputPath),
    counts: {
      scannedCount: result.scannedCount,
      importedCount: result.imported.length,
      updatedCount: result.updated.length,
      removedCount: removed.length,
      skippedCount: result.skipped.length
    },
    changed: result.imported.length + result.updated.length + removed.length > 0
  };
}

async function syncFileSource(rootDir: string, inputPath: string): Promise<ManagedSourceSyncResult> {
  const result = await ingestInputDetailed(rootDir, inputPath);
  const manifestsAfter = await listManifests(rootDir);
  return {
    title: path.basename(inputPath, path.extname(inputPath)) || inputPath,
    sourceIds: fileSourceIdsFor(manifestsAfter, inputPath),
    counts: {
      scannedCount: result.scannedCount,
      importedCount: result.created.length,
      updatedCount: result.updated.length,
      removedCount: result.removed.length,
      skippedCount: result.skipped.length
    },
    changed: result.created.length + result.updated.length + result.removed.length > 0
  };
}

async function runGitCommand(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `git ${args.join(" ")} failed with exit code ${code ?? 1}`));
    });
  });
}

async function syncGitHubRepoSource(rootDir: string, entry: ManagedSourceRecord): Promise<ManagedSourceSyncResult> {
  const workingDir = await managedSourceWorkingDir(rootDir, entry.id);
  const checkoutDir = path.join(workingDir, "checkout");
  await fs.rm(checkoutDir, { recursive: true, force: true });
  await ensureDir(workingDir);
  if (!entry.url) {
    throw new Error(`Managed source ${entry.id} is missing its repository URL.`);
  }
  const github = normalizeGitHubRepoRootUrl(entry.url);
  if (!github) {
    throw new Error(`Managed source ${entry.id} has an invalid GitHub repo URL.`);
  }
  await runGitCommand(workingDir, ["clone", "--depth", "1", github.cloneUrl, "checkout"]);
  return await syncDirectorySource(rootDir, checkoutDir, checkoutDir);
}

async function syncCrawlSource(
  rootDir: string,
  entry: ManagedSourceRecord,
  options: Pick<ManagedSourceReloadOptions, "maxPages" | "maxDepth">
): Promise<ManagedSourceSyncResult> {
  if (!entry.url) {
    throw new Error(`Managed source ${entry.id} is missing its URL.`);
  }
  const crawl = await crawlDocsSource(entry.url, options.maxPages ?? DEFAULT_CRAWL_MAX_PAGES, options.maxDepth ?? DEFAULT_CRAWL_MAX_DEPTH);
  const previousSourceIds = [...entry.sourceIds];
  const currentSourceIds: string[] = [];
  let importedCount = 0;
  let updatedCount = 0;
  for (const pageUrl of crawl.pages) {
    const persisted = await ingestInputDetailed(rootDir, pageUrl);
    currentSourceIds.push(...persisted.created.map((manifest) => manifest.sourceId));
    currentSourceIds.push(...persisted.updated.map((manifest) => manifest.sourceId));
    currentSourceIds.push(...persisted.unchanged.map((manifest) => manifest.sourceId));
    importedCount += persisted.created.length;
    updatedCount += persisted.updated.length;
  }
  let removedCount = 0;
  for (const sourceId of previousSourceIds) {
    if (currentSourceIds.includes(sourceId)) {
      continue;
    }
    if (await removeManifestBySourceId(rootDir, sourceId)) {
      removedCount += 1;
    }
  }
  return {
    title: crawl.title,
    sourceIds: uniqueStrings(currentSourceIds).sort((left, right) => left.localeCompare(right)),
    counts: {
      scannedCount: crawl.pages.length,
      importedCount,
      updatedCount,
      removedCount,
      skippedCount: 0
    },
    changed: importedCount + updatedCount + removedCount > 0
  };
}

async function syncManagedSource(
  rootDir: string,
  entry: ManagedSourceRecord,
  options: Pick<ManagedSourceReloadOptions, "maxPages" | "maxDepth">
): Promise<ManagedSourceRecord & { changed: boolean }> {
  const now = new Date().toISOString();
  try {
    let sync: ManagedSourceSyncResult;
    if (entry.kind === "directory") {
      if (!entry.path || !entry.repoRoot) {
        throw new Error(`Managed source ${entry.id} is missing its directory path.`);
      }
      if (!(await fileExists(entry.path))) {
        return {
          ...entry,
          status: "missing",
          updatedAt: now,
          lastSyncAt: now,
          lastSyncStatus: "error",
          lastError: `Directory not found: ${entry.path}`,
          changed: false
        };
      }
      sync = await syncDirectorySource(rootDir, entry.path, entry.repoRoot);
    } else if (entry.kind === "file") {
      if (!entry.path) {
        throw new Error(`Managed source ${entry.id} is missing its file path.`);
      }
      if (!(await fileExists(entry.path))) {
        return {
          ...entry,
          status: "missing",
          updatedAt: now,
          lastSyncAt: now,
          lastSyncStatus: "error",
          lastError: `File not found: ${entry.path}`,
          changed: false
        };
      }
      sync = await syncFileSource(rootDir, entry.path);
    } else if (entry.kind === "github_repo") {
      sync = await syncGitHubRepoSource(rootDir, entry);
    } else {
      sync = await syncCrawlSource(rootDir, entry, options);
    }

    return {
      ...entry,
      title: sync.title || entry.title,
      sourceIds: sync.sourceIds,
      status: "ready",
      updatedAt: now,
      lastSyncAt: now,
      lastSyncStatus: "success",
      lastSyncCounts: sync.counts,
      lastError: undefined,
      changed: sync.changed
    };
  } catch (error) {
    return {
      ...entry,
      status: normalizeManagedStatus(entry.status),
      updatedAt: now,
      lastSyncAt: now,
      lastSyncStatus: "error",
      lastError: error instanceof Error ? error.message : String(error),
      changed: false
    };
  }
}

function scopedSourcePages(graph: GraphArtifact, sourceIds: string[]) {
  const scopedSet = new Set(sourceIds);
  return graph.pages.filter((page) => page.sourceIds.some((sourceId) => scopedSet.has(sourceId)));
}

function scopedNodeIds(graph: GraphArtifact, sourceIds: string[]): string[] {
  const scopedSet = new Set(sourceIds);
  return graph.nodes.filter((node) => node.sourceIds.some((sourceId) => scopedSet.has(sourceId))).map((node) => node.id);
}

async function loadSourceAnalyses(rootDir: string, sourceIds: string[]): Promise<SourceAnalysis[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const analyses = await Promise.all(
    sourceIds.map(async (sourceId) => await readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${sourceId}.json`)))
  );
  return analyses.filter((analysis): analysis is SourceAnalysis => Boolean(analysis?.sourceId));
}

function renderDeterministicSourceBrief(input: {
  source: SourceScope;
  sourcePages: GraphArtifact["pages"];
  graph: GraphArtifact;
  analyses: SourceAnalysis[];
  report: Awaited<ReturnType<typeof readGraphReport>>;
}): string {
  const modulePages = input.sourcePages.filter((page) => page.kind === "module").slice(0, 6);
  const sourcePages = input.sourcePages.filter((page) => page.kind === "source").slice(0, 6);
  const conceptPages = input.sourcePages.filter((page) => page.kind === "concept").slice(0, 6);
  const entityPages = input.sourcePages.filter((page) => page.kind === "entity").slice(0, 6);
  const questions = uniqueStrings(input.analyses.flatMap((analysis) => analysis.questions)).slice(0, 5);
  const summary = truncate(
    normalizeWhitespace(
      uniqueStrings(input.analyses.map((analysis) => analysis.summary).filter(Boolean)).join(" ") ||
        `${input.source.title} has been compiled into a local source graph.`
    ),
    320
  );
  const scopedNodeIdSet = new Set(scopedNodeIds(input.graph, input.source.sourceIds));
  const surprises =
    input.report?.surprisingConnections
      .filter((connection) => scopedNodeIdSet.has(connection.sourceNodeId) || scopedNodeIdSet.has(connection.targetNodeId))
      .slice(0, 4) ?? [];
  const contradictions =
    input.report?.contradictions.filter(
      (contradiction) =>
        input.source.sourceIds.includes(contradiction.sourceIdA) || input.source.sourceIds.includes(contradiction.sourceIdB)
    ) ?? [];

  return [
    `# Source Brief: ${input.source.title}`,
    "",
    "## What This Source Is",
    "",
    summary,
    "",
    "## Read First",
    "",
    ...(sourcePages.length
      ? sourcePages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No source page links are available yet."]),
    "",
    "## Core Pages",
    "",
    ...(modulePages.length
      ? modulePages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No module pages are available yet."]),
    ...(conceptPages.length
      ? ["", "Concept pages:", ...conceptPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)]
      : []),
    ...(entityPages.length
      ? ["", "Entity pages:", ...entityPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)]
      : []),
    "",
    "## How The Important Parts Fit Together",
    "",
    `- Compiled source pages: ${sourcePages.length}`,
    `- Module pages: ${modulePages.length}`,
    `- Graph nodes touching this source: ${scopedNodeIdSet.size}`,
    `- Current tracked source ids: ${input.source.sourceIds.length}`,
    "",
    "## Surprises",
    "",
    ...(surprises.length
      ? surprises.map((surprise) => `- ${surprise.explanation}`)
      : ["- No surprising cross-source connections were highlighted for this source yet."]),
    "",
    "## Contradictions",
    "",
    ...(contradictions.length
      ? contradictions.map(
          (contradiction) =>
            `- ${contradiction.claimA} / ${contradiction.claimB} (sources: ${contradiction.sourceIdA}, ${contradiction.sourceIdB})`
        )
      : ["- No contradictions were detected for this source."]),
    "",
    "## Open Questions",
    "",
    ...(questions.length ? questions.map((question) => `- ${question}`) : ["- No extracted open questions yet."]),
    "",
    "## Suggested Next Questions",
    "",
    ...((input.report?.suggestedQuestions ?? []).slice(0, 5).map((question) => `- ${question}`) || [
      "- Ask `swarmvault query` about the main modules or sections in this source."
    ]),
    ""
  ].join("\n");
}

async function generateSourceBriefMarkdownForScope(rootDir: string, source: SourceScope): Promise<string | null> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    return null;
  }
  const sourcePages = scopedSourcePages(graph, source.sourceIds);
  const analyses = await loadSourceAnalyses(rootDir, source.sourceIds);
  const report = await readGraphReport(rootDir);
  const fallback = renderDeterministicSourceBrief({
    source,
    sourcePages,
    graph,
    analyses,
    report
  });

  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (provider.type === "heuristic") {
    return fallback;
  }

  try {
    const schemas = await loadVaultSchemas(rootDir);
    const pageContext = sourcePages
      .slice(0, 10)
      .map((page) => `- ${page.title} (${page.kind}) -> ${page.path}`)
      .join("\n");
    const analysisContext = analyses
      .slice(0, 6)
      .map(
        (analysis) =>
          `# ${analysis.title}\nSummary: ${analysis.summary}\nQuestions: ${analysis.questions.join(" | ") || "none"}\nConcepts: ${
            analysis.concepts.map((concept) => concept.name).join(", ") || "none"
          }\nEntities: ${analysis.entities.map((entity) => entity.name).join(", ") || "none"}`
      )
      .join("\n\n---\n\n");
    const response = await provider.generateText({
      system: buildSchemaPrompt(
        schemas.effective.global,
        "Write a concise markdown source brief with sections: What This Source Is, Read First, Core Pages, How The Important Parts Fit Together, Surprises, Contradictions, Open Questions, Suggested Next Questions. Ground every claim in the provided context."
      ),
      prompt: [
        `Source title: ${source.title}`,
        `Source kind: ${source.kind ?? "source"}`,
        `Tracked source ids: ${source.sourceIds.join(", ") || "none"}`,
        "",
        "Pages:",
        pageContext || "- none",
        "",
        "Analyses:",
        analysisContext || "No analysis context available.",
        "",
        "Deterministic fallback draft:",
        fallback
      ].join("\n")
    });
    return response.text?.trim() ? response.text.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function writeSourceBriefForScope(rootDir: string, source: SourceScope): Promise<string | null> {
  if (!source.sourceIds.length) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const markdown = await generateSourceBriefMarkdownForScope(rootDir, source);
  if (!markdown) {
    return null;
  }
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const relatedPages = graph ? scopedSourcePages(graph, source.sourceIds) : [];
  const relatedPageIds = relatedPages.slice(0, 12).map((page) => page.id);
  const relatedNodeIds = graph ? scopedNodeIds(graph, source.sourceIds).slice(0, 20) : [];
  const projectIds = uniqueStrings(relatedPages.flatMap((page) => page.projectIds));
  const now = new Date().toISOString();
  const output = buildOutputPage({
    title: `Source Brief: ${source.title}`,
    question: `Brief ${source.title}`,
    answer: markdown,
    citations: source.sourceIds,
    schemaHash: graph?.generatedAt ?? "",
    outputFormat: "report",
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds: source.sourceIds,
    projectIds,
    extraTags: ["source-brief"],
    origin: "query",
    slug: `source-briefs/${source.id}`,
    metadata: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      compiledFrom: source.sourceIds,
      managedBy: "system",
      confidence: 0.82
    }
  });
  const absolutePath = path.join(paths.wikiDir, output.page.path);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, output.content, "utf8");
  return absolutePath;
}

async function writeSourceBrief(rootDir: string, source: ManagedSourceRecord): Promise<string | null> {
  return await writeSourceBriefForScope(rootDir, scopeFromManagedSource(source));
}

async function generateBriefsForSources(rootDir: string, sources: ManagedSourceRecord[]): Promise<Map<string, string>> {
  const briefPaths = new Map<string, string>();
  for (const source of sources) {
    const briefPath = await writeSourceBrief(rootDir, source);
    if (briefPath) {
      briefPaths.set(source.id, briefPath);
    }
  }
  if (briefPaths.size > 0) {
    await refreshVaultAfterOutputSave(rootDir);
  }
  return briefPaths;
}

type SourceScope = {
  id: string;
  title: string;
  sourceIds: string[];
  kind?: string;
  briefPath?: string;
};

type GuidedEvidenceState = "new" | "reinforcing" | "conflicting" | "needs_judgment";

const GUIDED_SESSION_QUESTIONS: Array<{ id: string; prompt: string }> = [
  {
    id: "importance",
    prompt: "What matters most from this source for your wiki right now?"
  },
  {
    id: "exclude",
    prompt: "What should stay provisional, be ignored, or be kept out for now?"
  },
  {
    id: "targets",
    prompt: "Which canonical pages or topics should this source update?"
  },
  {
    id: "conflicts",
    prompt: "What feels new, reinforcing, or conflicting compared with what you already believe?"
  },
  {
    id: "followups",
    prompt: "What follow-up questions or next sources should stay open?"
  }
];

function defaultGuidedSessionQuestions(): GuidedSourceSessionQuestion[] {
  return GUIDED_SESSION_QUESTIONS.map((question) => ({ ...question }));
}

function splitDelimitedDetail(value: string | undefined): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function normalizeGuidedAnswerValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeGuidedAnswers(input: GuidedSourceSessionAnswers | undefined): Record<string, string> {
  if (!input) {
    return {};
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(
      GUIDED_SESSION_QUESTIONS.map((question, index) => [question.id, normalizeGuidedAnswerValue(input[index])]).filter(
        (entry): entry is [string, string] => Boolean(entry[1])
      )
    );
  }
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key, normalizeGuidedAnswerValue(value)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

function mergeGuidedSessionQuestions(
  questions: GuidedSourceSessionQuestion[],
  answers: GuidedSourceSessionAnswers | undefined
): GuidedSourceSessionQuestion[] {
  const normalizedAnswers = normalizeGuidedAnswers(answers);
  return questions.map((question) => ({
    ...question,
    answer: normalizedAnswers[question.id] ?? question.answer
  }));
}

function answeredGuidedSessionQuestions(questions: GuidedSourceSessionQuestion[]): GuidedSourceSessionQuestion[] {
  return questions.filter((question) => typeof question.answer === "string" && question.answer.trim().length > 0);
}

function questionStateForSession(session: GuidedSourceSessionRecord): "awaiting_input" | "answered" {
  return answeredGuidedSessionQuestions(session.questions).length === session.questions.length ? "answered" : "awaiting_input";
}

function manifestsForScope(graph: GraphArtifact | null | undefined, scope: SourceScope): SourceManifest[] {
  if (!graph) {
    return [];
  }
  const scopeSet = new Set(scope.sourceIds);
  return graph.sources.filter((manifest) => scopeSet.has(manifest.sourceId));
}

function scopeSourceType(scope: SourceScope, manifests: SourceManifest[]): string | undefined {
  return scope.kind ?? manifests[0]?.sourceKind ?? manifests[0]?.sourceType;
}

function scopeOccurredAt(manifests: SourceManifest[]): string | undefined {
  return manifests
    .map((manifest) => manifest.details?.occurred_at)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .sort((left, right) => right.localeCompare(left))[0];
}

function scopeParticipants(manifests: SourceManifest[]): string[] {
  return uniqueStrings(manifests.flatMap((manifest) => splitDelimitedDetail(manifest.details?.participants)));
}

function scopeContainerTitle(manifests: SourceManifest[]): string | undefined {
  return manifests.find((manifest) => manifest.details?.container_title)?.details?.container_title ?? manifests[0]?.sourceGroupTitle;
}

function scopeConversationId(manifests: SourceManifest[]): string | undefined {
  return manifests.find((manifest) => manifest.details?.conversation_id)?.details?.conversation_id;
}

function classifyGuidedEvidenceState(
  scope: SourceScope,
  targetPage: GraphArtifact["pages"][number] | null,
  contradictions: ReturnType<typeof findContradictionsForScope>
): GuidedEvidenceState {
  if (contradictions.length) {
    return "conflicting";
  }
  if (!targetPage) {
    return "needs_judgment";
  }
  return targetPage.sourceIds.some((sourceId) => !scope.sourceIds.includes(sourceId)) ? "reinforcing" : "new";
}

function renderDeterministicSourceReview(input: {
  scope: SourceScope;
  sourcePages: GraphArtifact["pages"];
  graph: GraphArtifact;
  analyses: SourceAnalysis[];
  report: Awaited<ReturnType<typeof readGraphReport>>;
}): string {
  const canonicalPages = input.sourcePages
    .filter((page) => page.kind === "source" || page.kind === "concept" || page.kind === "entity")
    .slice(0, 10);
  const modulePages = input.sourcePages.filter((page) => page.kind === "module").slice(0, 8);
  const questions = uniqueStrings(input.analyses.flatMap((analysis) => analysis.questions)).slice(0, 8);
  const concepts = uniqueStrings(input.analyses.flatMap((analysis) => analysis.concepts.map((concept) => concept.name))).slice(0, 8);
  const entities = uniqueStrings(input.analyses.flatMap((analysis) => analysis.entities.map((entity) => entity.name))).slice(0, 8);
  const contradictions =
    input.report?.contradictions.filter(
      (contradiction) => input.scope.sourceIds.includes(contradiction.sourceIdA) || input.scope.sourceIds.includes(contradiction.sourceIdB)
    ) ?? [];

  return [
    `# Source Review: ${input.scope.title}`,
    "",
    "## What This Source Contains",
    "",
    ...(input.analyses.length
      ? input.analyses.map((analysis) => `- ${analysis.title}: ${analysis.summary}`)
      : ["- This source has not been analyzed yet. Compile the vault before trusting downstream pages."]),
    "",
    "## Likely Canonical Pages To Update",
    "",
    ...(canonicalPages.length
      ? canonicalPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No canonical source, concept, or entity pages are linked to this source yet."]),
    "",
    "## Important Topics And Entities",
    "",
    ...(concepts.length ? [`Concepts: ${concepts.join(", ")}`] : ["Concepts: none detected."]),
    ...(entities.length ? [`Entities: ${entities.join(", ")}`] : ["Entities: none detected."]),
    ...(modulePages.length ? ["", ...modulePages.map((page) => `- Module: [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)] : []),
    "",
    "## Contradictions To Inspect",
    "",
    ...(contradictions.length
      ? contradictions.map((contradiction) => `- ${contradiction.claimA} / ${contradiction.claimB}`)
      : ["- No contradictions are currently flagged for this source scope."]),
    "",
    "## Open Questions",
    "",
    ...(questions.length ? questions.map((question) => `- ${question}`) : ["- No extracted open questions yet."]),
    "",
    "## Suggested Next Steps",
    "",
    ...(canonicalPages.length
      ? canonicalPages.slice(0, 5).map((page) => `- Review [[${page.path.replace(/\.md$/, "")}|${page.title}]] for canonical updates.`)
      : ["- Review the source page and decide which canonical pages should exist."]),
    ""
  ].join("\n");
}

async function generateSourceReviewMarkdown(rootDir: string, scope: SourceScope): Promise<string | null> {
  const { paths } = await loadVaultConfig(rootDir);
  let graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    await compileVault(rootDir, {});
    graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  }
  if (!graph) {
    return null;
  }

  const sourcePages = scopedSourcePages(graph, scope.sourceIds);
  const analyses = await loadSourceAnalyses(rootDir, scope.sourceIds);
  const report = await readGraphReport(rootDir);
  const fallback = renderDeterministicSourceReview({
    scope,
    sourcePages,
    graph,
    analyses,
    report
  });

  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (provider.type === "heuristic") {
    return fallback;
  }

  try {
    const schemas = await loadVaultSchemas(rootDir);
    const pageContext = sourcePages
      .slice(0, 12)
      .map((page) => `- ${page.title} (${page.kind}) -> ${page.path}`)
      .join("\n");
    const analysisContext = analyses
      .slice(0, 8)
      .map(
        (analysis) =>
          `# ${analysis.title}\nSummary: ${analysis.summary}\nQuestions: ${analysis.questions.join(" | ") || "none"}\nConcepts: ${
            analysis.concepts.map((concept) => concept.name).join(", ") || "none"
          }\nEntities: ${analysis.entities.map((entity) => entity.name).join(", ") || "none"}`
      )
      .join("\n\n---\n\n");
    const response = await provider.generateText({
      system: buildSchemaPrompt(
        schemas.effective.global,
        "Write a concise markdown source review with sections: What This Source Contains, Likely Canonical Pages To Update, Important Topics And Entities, Contradictions To Inspect, Open Questions, Suggested Next Steps. Focus on helping a human decide what to keep, update, or question in the wiki."
      ),
      prompt: [
        `Source scope: ${scope.title}`,
        `Scope id: ${scope.id}`,
        `Tracked source ids: ${scope.sourceIds.join(", ") || "none"}`,
        "",
        "Pages:",
        pageContext || "- none",
        "",
        "Analyses:",
        analysisContext || "No analysis context available.",
        "",
        "Deterministic fallback draft:",
        fallback
      ].join("\n")
    });
    return response.text?.trim() ? response.text.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function buildSourceReviewStagedPage(
  rootDir: string,
  scope: SourceScope
): Promise<{ page: GraphArtifact["pages"][number]; content: string }> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const markdown = await generateSourceReviewMarkdown(rootDir, scope);
  if (!markdown) {
    throw new Error(`Could not generate a source review for ${scope.id}.`);
  }
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const scopeManifests = manifestsForScope(graph, scope);
  const relatedPages = graph ? scopedSourcePages(graph, scope.sourceIds) : [];
  const relatedPageIds = relatedPages.slice(0, 16).map((page) => page.id);
  const relatedNodeIds = graph ? scopedNodeIds(graph, scope.sourceIds).slice(0, 24) : [];
  const projectIds = uniqueStrings(relatedPages.flatMap((page) => page.projectIds));
  const now = new Date().toISOString();
  const output = buildOutputPage({
    title: `Source Review: ${scope.title}`,
    question: `Review ${scope.title}`,
    answer: markdown,
    citations: scope.sourceIds,
    schemaHash: graph?.generatedAt ?? "",
    outputFormat: "report",
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds: scope.sourceIds,
    projectIds,
    extraTags: ["source-review"],
    origin: "query",
    slug: `source-reviews/${scope.id}`,
    metadata: {
      status: "draft",
      createdAt: now,
      updatedAt: now,
      compiledFrom: scope.sourceIds,
      managedBy: "system",
      confidence: 0.79
    },
    frontmatter: {
      profile_presets: config.profile.presets,
      source_type: scopeSourceType(scope, scopeManifests),
      occurred_at: scopeOccurredAt(scopeManifests),
      participants: scopeParticipants(scopeManifests),
      container_title: scopeContainerTitle(scopeManifests),
      conversation_id: scopeConversationId(scopeManifests),
      question_state: "answered",
      canonical_targets: relatedPages
        .filter((page) => page.kind === "source" || page.kind === "concept" || page.kind === "entity")
        .slice(0, 8)
        .map((page) => page.path),
      evidence_state: findContradictionsForScope(scope, await readGraphReport(rootDir)).length ? "conflicting" : "needs_judgment"
    }
  });
  return { page: output.page, content: output.content };
}

function classifySourceGuidePageBuckets(sourcePages: GraphArtifact["pages"], scopeSourceIds: string[]) {
  const scopeSet = new Set(scopeSourceIds);
  const canonicalPages = sourcePages
    .filter(
      (page) =>
        (page.kind === "source" || page.kind === "concept" || page.kind === "entity") &&
        (page.kind === "source" || page.status !== "candidate")
    )
    .slice(0, 12);
  const newPages = canonicalPages.filter((page) => page.sourceIds.every((sourceId) => scopeSet.has(sourceId))).slice(0, 6);
  const reinforcingPages = canonicalPages.filter((page) => page.sourceIds.some((sourceId) => !scopeSet.has(sourceId))).slice(0, 6);
  return { canonicalPages, newPages, reinforcingPages };
}

function findContradictionsForScope(scope: SourceScope, report: Awaited<ReturnType<typeof readGraphReport>>) {
  return (
    report?.contradictions.filter(
      (contradiction) => scope.sourceIds.includes(contradiction.sourceIdA) || scope.sourceIds.includes(contradiction.sourceIdB)
    ) ?? []
  );
}

function selectGuidedTargetPages(
  scope: SourceScope,
  sourcePages: GraphArtifact["pages"],
  questions: GuidedSourceSessionQuestion[]
): GraphArtifact["pages"] {
  const { canonicalPages } = classifySourceGuidePageBuckets(sourcePages, scope.sourceIds);
  if (!canonicalPages.length) {
    return [];
  }
  const desiredTargets = normalizeWhitespace(
    questions.find((question) => question.id === "targets")?.answer ??
      questions.find((question) => question.id === "importance")?.answer ??
      ""
  ).toLowerCase();
  const matchedTargets = desiredTargets
    ? canonicalPages.filter((page) => {
        const title = page.title.toLowerCase();
        const relative = page.path.replace(/\.md$/, "").toLowerCase();
        return desiredTargets.includes(title) || desiredTargets.includes(relative) || title.includes(desiredTargets);
      })
    : [];
  return (matchedTargets.length ? matchedTargets : canonicalPages).slice(0, 6);
}

function insightRelativePathForTarget(page: GraphArtifact["pages"][number], scope: SourceScope): string {
  const basename = path.basename(page.path);
  if (page.kind === "concept") {
    return `insights/concepts/${basename}`;
  }
  if (page.kind === "entity") {
    return `insights/entities/${basename}`;
  }
  if (page.kind === "source") {
    return `insights/sources/${slugify(page.title || scope.title)}.md`;
  }
  return `insights/topics/${slugify(page.title || scope.title)}.md`;
}

function insightTitleForTarget(page: GraphArtifact["pages"][number], scope: SourceScope): string {
  if (page.kind === "concept" || page.kind === "entity") {
    return page.title;
  }
  if (page.kind === "source") {
    return `Source Notes: ${page.title}`;
  }
  return `${scope.title} Notes`;
}

function insightTagsForTarget(page: GraphArtifact["pages"][number] | null): string[] {
  return uniqueStrings(["insight", "guided-session", `guided/${page?.kind ?? "topic"}`]);
}

function guidedUpdateMarker(scopeId: string) {
  return {
    start: `<!-- swarmvault-guided-source:${scopeId}:start -->`,
    end: `<!-- swarmvault-guided-source:${scopeId}:end -->`
  };
}

function replaceMarkedSection(content: string, scopeId: string, replacement: string): string {
  const marker = guidedUpdateMarker(scopeId);
  const block = `${marker.start}\n${replacement.trim()}\n${marker.end}`;
  const startIndex = content.indexOf(marker.start);
  const endIndex = content.indexOf(marker.end);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    return `${content.slice(0, startIndex).trimEnd()}\n\n${block}\n`;
  }
  return `${content.trimEnd()}\n\n${block}\n`;
}

function renderDeterministicSourceGuide(input: {
  scope: SourceScope;
  sourcePages: GraphArtifact["pages"];
  analyses: SourceAnalysis[];
  report: Awaited<ReturnType<typeof readGraphReport>>;
}): string {
  const { canonicalPages, newPages, reinforcingPages } = classifySourceGuidePageBuckets(input.sourcePages, input.scope.sourceIds);
  const modulePages = input.sourcePages.filter((page) => page.kind === "module").slice(0, 6);
  const takeaways = uniqueStrings(
    input.analyses
      .flatMap((analysis) => [
        analysis.summary,
        ...analysis.concepts.map((concept) => concept.description),
        ...analysis.entities.map((entity) => entity.description)
      ])
      .filter(Boolean)
      .map((value) => normalizeWhitespace(value))
  )
    .slice(0, 7)
    .map((value) => truncate(value, 180));
  const questions = uniqueStrings(input.analyses.flatMap((analysis) => analysis.questions)).slice(0, 6);
  const contradictions =
    input.report?.contradictions.filter(
      (contradiction) => input.scope.sourceIds.includes(contradiction.sourceIdA) || input.scope.sourceIds.includes(contradiction.sourceIdB)
    ) ?? [];

  return [
    `# Source Guide: ${input.scope.title}`,
    "",
    "## What This Source Is",
    "",
    takeaways.length ? takeaways[0] : `${input.scope.title} has been compiled into the vault and is ready for guided review.`,
    "",
    "## Key Takeaways",
    "",
    ...(takeaways.length ? takeaways.map((takeaway) => `- ${takeaway}`) : ["- No takeaways are available until the source is compiled."]),
    "",
    "## Proposed Canonical Pages To Update",
    "",
    ...(canonicalPages.length
      ? canonicalPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No likely canonical pages were identified yet."]),
    "",
    "## New, Reinforcing, And Conflicting Claims",
    "",
    ...(newPages.length
      ? ["New or source-local pages:", ...newPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`), ""]
      : []),
    ...(reinforcingPages.length
      ? ["Reinforcing existing pages:", ...reinforcingPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`), ""]
      : []),
    ...(contradictions.length
      ? ["Conflicts to judge:", ...contradictions.map((contradiction) => `- ${contradiction.claimA} / ${contradiction.claimB}`), ""]
      : ["Conflicts to judge:", "- No contradictions are currently flagged for this source scope.", ""]),
    "## What Should Probably Stay Out For Now",
    "",
    ...(modulePages.length
      ? ["- Avoid promoting narrow implementation details unless they matter to your thesis or recurring questions."]
      : ["- Avoid promoting incidental details that are not yet supported by multiple sources or clear research goals."]),
    ...(contradictions.length ? ["- Keep contested claims provisional until you review the conflicting evidence side by side."] : []),
    "",
    "## Needs Human Judgment",
    "",
    ...(questions.length
      ? questions.map((question) => `- ${question}`)
      : ["- Decide which proposed canonical pages deserve durable summary updates."]),
    "",
    "## Suggested Follow-up Questions",
    "",
    ...(questions.length
      ? questions.map((question) => `- ${question}`)
      : ["- What changed in your understanding after reading this source?"]),
    ""
  ].join("\n");
}

async function generateSourceGuideMarkdown(rootDir: string, scope: SourceScope): Promise<string | null> {
  const { paths } = await loadVaultConfig(rootDir);
  let graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    await compileVault(rootDir, {});
    graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  }
  if (!graph) {
    return null;
  }

  const sourcePages = scopedSourcePages(graph, scope.sourceIds);
  const analyses = await loadSourceAnalyses(rootDir, scope.sourceIds);
  const report = await readGraphReport(rootDir);
  const fallback = renderDeterministicSourceGuide({
    scope,
    sourcePages,
    analyses,
    report
  });

  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (provider.type === "heuristic") {
    return fallback;
  }

  try {
    const schemas = await loadVaultSchemas(rootDir);
    const { canonicalPages, newPages, reinforcingPages } = classifySourceGuidePageBuckets(sourcePages, scope.sourceIds);
    const pageContext = sourcePages
      .slice(0, 12)
      .map((page) => `- ${page.title} (${page.kind}) -> ${page.path}`)
      .join("\n");
    const analysisContext = analyses
      .slice(0, 8)
      .map(
        (analysis) =>
          `# ${analysis.title}\nSummary: ${analysis.summary}\nQuestions: ${analysis.questions.join(" | ") || "none"}\nConcepts: ${
            analysis.concepts.map((concept) => concept.name).join(", ") || "none"
          }\nEntities: ${analysis.entities.map((entity) => entity.name).join(", ") || "none"}`
      )
      .join("\n\n---\n\n");
    const response = await provider.generateText({
      system: buildSchemaPrompt(
        schemas.effective.global,
        "Write a concise markdown source guide with sections: What This Source Is, Key Takeaways, Proposed Canonical Pages To Update, New Reinforcing And Conflicting Claims, What Should Probably Stay Out For Now, Needs Human Judgment, Suggested Follow-up Questions. Focus on helping a human integrate one source into an evolving research wiki."
      ),
      prompt: [
        `Source scope: ${scope.title}`,
        `Scope id: ${scope.id}`,
        `Tracked source ids: ${scope.sourceIds.join(", ") || "none"}`,
        `Current brief path: ${scope.briefPath ?? "none"}`,
        "",
        "Likely canonical pages:",
        canonicalPages.length ? canonicalPages.map((page) => `- ${page.title} -> ${page.path}`).join("\n") : "- none",
        "",
        "Likely source-local pages:",
        newPages.length ? newPages.map((page) => `- ${page.title} -> ${page.path}`).join("\n") : "- none",
        "",
        "Likely reinforcing pages:",
        reinforcingPages.length ? reinforcingPages.map((page) => `- ${page.title} -> ${page.path}`).join("\n") : "- none",
        "",
        "Pages:",
        pageContext || "- none",
        "",
        "Analyses:",
        analysisContext || "No analysis context available.",
        "",
        "Deterministic fallback draft:",
        fallback
      ].join("\n")
    });
    return response.text?.trim() ? response.text.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function buildSourceGuideStagedPage(
  rootDir: string,
  scope: SourceScope
): Promise<{ page: GraphArtifact["pages"][number]; content: string }> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const markdown = await generateSourceGuideMarkdown(rootDir, scope);
  if (!markdown) {
    throw new Error(`Could not generate a source guide for ${scope.id}.`);
  }
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const scopeManifests = manifestsForScope(graph, scope);
  const relatedPages = graph ? scopedSourcePages(graph, scope.sourceIds) : [];
  const contradictions = findContradictionsForScope(scope, await readGraphReport(rootDir));
  const selectedTargets = selectGuidedTargetPages(scope, relatedPages, defaultGuidedSessionQuestions());
  const relatedPageIds = relatedPages.slice(0, 18).map((page) => page.id);
  const relatedNodeIds = graph ? scopedNodeIds(graph, scope.sourceIds).slice(0, 28) : [];
  const projectIds = uniqueStrings(relatedPages.flatMap((page) => page.projectIds));
  const now = new Date().toISOString();
  const output = buildOutputPage({
    title: `Source Guide: ${scope.title}`,
    question: `Guide ${scope.title}`,
    answer: markdown,
    citations: scope.sourceIds,
    schemaHash: graph?.generatedAt ?? "",
    outputFormat: "report",
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds: scope.sourceIds,
    projectIds,
    extraTags: ["source-guide", "guided-ingest"],
    origin: "query",
    slug: `source-guides/${scope.id}`,
    metadata: {
      status: "draft",
      createdAt: now,
      updatedAt: now,
      compiledFrom: scope.sourceIds,
      managedBy: "system",
      confidence: 0.8
    },
    frontmatter: {
      profile_presets: config.profile.presets,
      source_type: scopeSourceType(scope, scopeManifests),
      occurred_at: scopeOccurredAt(scopeManifests),
      participants: scopeParticipants(scopeManifests),
      container_title: scopeContainerTitle(scopeManifests),
      conversation_id: scopeConversationId(scopeManifests),
      question_state: "answered",
      canonical_targets: selectedTargets.map((page) => page.path),
      evidence_state: contradictions.length
        ? "conflicting"
        : selectedTargets.some((page) => page.sourceIds.some((sourceId) => !scope.sourceIds.includes(sourceId)))
          ? "reinforcing"
          : selectedTargets.length
            ? "new"
            : "needs_judgment"
    }
  });
  return { page: output.page, content: output.content };
}

async function stageSourceReviewForScope(rootDir: string, scope: SourceScope): Promise<SourceReviewResult> {
  const output = await buildSourceReviewStagedPage(rootDir, scope);
  const approval = await stageGeneratedOutputPages(rootDir, [{ page: output.page, content: output.content, label: "source-review" }], {
    bundleType: "source_review",
    title: `Source Review: ${scope.title}`
  });
  return {
    sourceId: scope.id,
    pageId: output.page.id,
    reviewPath: path.join(approval.approvalDir, "wiki", output.page.path),
    staged: true,
    approvalId: approval.approvalId,
    approvalDir: approval.approvalDir
  };
}

function nextGuidedSourceSessionId(scope: SourceScope): string {
  return `source-session-${slugify(scope.id)}-${sha256(`${scope.id}:${new Date().toISOString()}`).slice(0, 8)}`;
}

function shouldReuseGuidedSourceSession(
  session: GuidedSourceSessionRecord | null
): session is GuidedSourceSessionRecord & { status: "awaiting_input" } {
  return Boolean(session && session.status === "awaiting_input");
}

function questionAnswer(questions: GuidedSourceSessionQuestion[], id: string, fallback: string): string {
  return normalizeGuidedAnswerValue(questions.find((question) => question.id === id)?.answer) ?? fallback;
}

async function prepareGuidedSourceSession(
  rootDir: string,
  scope: SourceScope,
  answers?: GuidedSourceSessionAnswers
): Promise<{ session: GuidedSourceSessionRecord; statePath: string }> {
  const existing = await findLatestGuidedSourceSessionByScope(rootDir, scope.id);
  const now = new Date().toISOString();
  const session: GuidedSourceSessionRecord = shouldReuseGuidedSourceSession(existing)
    ? {
        ...existing,
        scopeTitle: scope.title,
        sourceIds: scope.sourceIds,
        kind: scope.kind,
        questions: mergeGuidedSessionQuestions(existing.questions, answers),
        updatedAt: now
      }
    : {
        sessionId: nextGuidedSourceSessionId(scope),
        scopeId: scope.id,
        scopeTitle: scope.title,
        sourceIds: scope.sourceIds,
        kind: scope.kind,
        status: "awaiting_input",
        createdAt: now,
        updatedAt: now,
        questions: mergeGuidedSessionQuestions(defaultGuidedSessionQuestions(), answers),
        briefPath: scope.briefPath,
        targetedPagePaths: [],
        stagedUpdatePaths: []
      };
  const statePath = await guidedSourceSessionStatePath(rootDir, session.sessionId);
  return { session, statePath };
}

async function buildSourceSessionSavedPage(
  rootDir: string,
  scope: SourceScope,
  session: GuidedSourceSessionRecord
): Promise<{ page: GraphArtifact["pages"][number]; content: string }> {
  const { config, paths } = await loadVaultConfig(rootDir);
  let graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    await compileVault(rootDir, {});
    graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  }
  const scopeManifests = manifestsForScope(graph, scope);
  const sourcePages = graph ? scopedSourcePages(graph, scope.sourceIds) : [];
  const analyses = await loadSourceAnalyses(rootDir, scope.sourceIds);
  const report = await readGraphReport(rootDir);
  const contradictions = findContradictionsForScope(scope, report);
  const relatedPageIds = uniqueStrings([
    ...sourcePages.slice(0, 18).map((page) => page.id),
    ...session.targetedPagePaths.map((relativePath) => {
      const page = graph?.pages.find((candidate) => candidate.path === relativePath);
      return page?.id ?? "";
    })
  ]);
  const relatedNodeIds = graph ? scopedNodeIds(graph, scope.sourceIds).slice(0, 28) : [];
  const projectIds = uniqueStrings(sourcePages.flatMap((page) => page.projectIds));
  const evidenceState =
    contradictions.length > 0
      ? "conflicting"
      : session.targetedPagePaths.some((targetPath) =>
            sourcePages.some((page) => page.path === targetPath && page.sourceIds.some((sourceId) => !scope.sourceIds.includes(sourceId)))
          )
        ? "reinforcing"
        : session.targetedPagePaths.length
          ? "new"
          : "needs_judgment";
  const relativeBriefPath =
    session.briefPath && path.isAbsolute(session.briefPath) ? path.relative(paths.wikiDir, session.briefPath) : session.briefPath;
  const sessionMarkdown = [
    `# Guided Session: ${scope.title}`,
    "",
    `Status: \`${session.status}\``,
    `Session ID: \`${session.sessionId}\``,
    ...(session.approvalId ? [`Approval Bundle: \`${session.approvalId}\``] : []),
    ...(relativeBriefPath ? [`Brief: \`${relativeBriefPath}\``] : []),
    "",
    "## What This Source Is",
    "",
    ...(analyses.length
      ? analyses.slice(0, 6).map((analysis) => `- ${analysis.title}: ${analysis.summary}`)
      : ["- Awaiting compile context."]),
    "",
    "## Guided Questions",
    "",
    ...session.questions.flatMap((question) => [`### ${question.prompt}`, "", question.answer ?? "_Awaiting input._", ""]),
    "## Proposed Wiki Targets",
    "",
    ...(session.targetedPagePaths.length
      ? session.targetedPagePaths.map((targetPath) => `- [[${targetPath.replace(/\.md$/, "")}]]`)
      : ["- No canonical update targets selected yet."]),
    "",
    "## Conflicts And Judgment Calls",
    "",
    ...(contradictions.length
      ? contradictions.map((contradiction) => `- ${contradiction.claimA} / ${contradiction.claimB}`)
      : ["- No contradictions are currently flagged for this source scope."]),
    "",
    "## Follow-up Questions",
    "",
    ...(() => {
      const followups = questionAnswer(session.questions, "followups", "");
      if (followups) {
        return followups
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => `- ${line.replace(/^-+\s*/, "")}`);
      }
      const analysisQuestions = uniqueStrings(analyses.flatMap((analysis) => analysis.questions)).slice(0, 6);
      return analysisQuestions.length ? analysisQuestions.map((question) => `- ${question}`) : ["- No follow-up questions recorded yet."];
    })(),
    "",
    "## Related Artifacts",
    "",
    `- [[outputs/source-briefs/${scope.id}|Source Brief]]`,
    `- [[outputs/source-reviews/${scope.id}|Source Review]]`,
    `- [[outputs/source-guides/${scope.id}|Source Guide]]`,
    ""
  ].join("\n");
  const now = new Date().toISOString();
  const output = buildOutputPage({
    title: `Guided Session: ${scope.title}`,
    question: `Guided Session ${scope.title}`,
    answer: sessionMarkdown,
    citations: scope.sourceIds,
    schemaHash: graph?.generatedAt ?? "",
    outputFormat: "report",
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds: scope.sourceIds,
    projectIds,
    extraTags: ["source-session", "guided-session"],
    origin: "query",
    slug: `source-sessions/${scope.id}`,
    metadata: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      compiledFrom: scope.sourceIds,
      managedBy: "system",
      confidence: 0.81
    },
    frontmatter: {
      profile_presets: config.profile.presets,
      source_type: scopeSourceType(scope, scopeManifests),
      occurred_at: scopeOccurredAt(scopeManifests),
      participants: scopeParticipants(scopeManifests),
      container_title: scopeContainerTitle(scopeManifests),
      conversation_id: scopeConversationId(scopeManifests),
      session_status: session.status,
      question_state: questionStateForSession(session),
      canonical_targets: session.targetedPagePaths,
      evidence_state: evidenceState
    }
  });
  return { page: output.page, content: output.content };
}

async function persistSourceSessionPage(
  rootDir: string,
  scope: SourceScope,
  session: GuidedSourceSessionRecord
): Promise<{ pageId: string; sessionPath: string }> {
  const { paths } = await loadVaultConfig(rootDir);
  const output = await buildSourceSessionSavedPage(rootDir, scope, session);
  const absolutePath = path.join(paths.wikiDir, output.page.path);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, output.content, "utf8");
  return { pageId: output.page.id, sessionPath: absolutePath };
}

async function buildGuidedUpdatePages(
  rootDir: string,
  scope: SourceScope,
  session: GuidedSourceSessionRecord
): Promise<Array<{ page: GraphArtifact["pages"][number]; content: string; label: "guided-update" }>> {
  const { config, paths } = await loadVaultConfig(rootDir);
  let graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    await compileVault(rootDir, {});
    graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  }
  if (!graph) {
    return [];
  }
  const sourcePages = scopedSourcePages(graph, scope.sourceIds);
  const scopeManifests = manifestsForScope(graph, scope);
  const analyses = await loadSourceAnalyses(rootDir, scope.sourceIds);
  const report = await readGraphReport(rootDir);
  const contradictions = findContradictionsForScope(scope, report);
  const selectedTargets = selectGuidedTargetPages(scope, sourcePages, session.questions);
  const useCanonicalTargets = config.profile.guidedSessionMode === "canonical_review" && selectedTargets.length > 0;
  const targetPages = useCanonicalTargets ? selectedTargets : [selectedTargets[0] ?? null];
  session.targetedPagePaths = uniqueStrings(
    useCanonicalTargets
      ? selectedTargets.map((page) => page.path)
      : selectedTargets.length
        ? selectedTargets.map((page) => page.path)
        : session.targetedPagePaths
  );

  return await Promise.all(
    targetPages.map(async (targetPage) => {
      const evidenceState = classifyGuidedEvidenceState(scope, targetPage, contradictions);
      const relativePath =
        useCanonicalTargets && targetPage
          ? targetPage.path
          : targetPage
            ? insightRelativePathForTarget(targetPage, scope)
            : `insights/topics/${slugify(scope.title)}.md`;
      const absolutePath = path.join(paths.wikiDir, relativePath);
      const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : "";
      const parsed = existingContent ? matter(existingContent) : { data: {}, content: "" };
      const existingData = parsed.data as Record<string, unknown>;
      const existingSourceIds = Array.isArray(existingData.source_ids)
        ? existingData.source_ids.filter((value): value is string => typeof value === "string")
        : [];
      const existingProjectIds = Array.isArray(existingData.project_ids)
        ? existingData.project_ids.filter((value): value is string => typeof value === "string")
        : [];
      const existingNodeIds = Array.isArray(existingData.node_ids)
        ? existingData.node_ids.filter((value): value is string => typeof value === "string")
        : [];
      const existingBacklinks = Array.isArray(existingData.backlinks)
        ? existingData.backlinks.filter((value): value is string => typeof value === "string")
        : [];
      const createdAt =
        typeof existingData.created_at === "string" && existingData.created_at.trim() ? existingData.created_at : new Date().toISOString();
      const title =
        (typeof existingData.title === "string" && existingData.title.trim()) ||
        (useCanonicalTargets && targetPage
          ? targetPage.title
          : targetPage
            ? insightTitleForTarget(targetPage, scope)
            : `${scope.title} Notes`);
      const baseBody = parsed.content.trim()
        ? parsed.content.trim()
        : [
            `# ${title}`,
            "",
            useCanonicalTargets
              ? "Canonical page maintained by SwarmVault. Guided sessions stage replaceable update blocks here for approval."
              : "Human-curated insight page. Guided sessions stage replaceable update blocks here.",
            ""
          ].join("\n");
      const importance = questionAnswer(
        session.questions,
        "importance",
        "Capture the most important new ideas from this source before treating them as canonical."
      );
      const exclude = questionAnswer(
        session.questions,
        "exclude",
        "Keep uncertain or incidental details provisional until they matter to the research thread."
      );
      const conflictNotes = questionAnswer(
        session.questions,
        "conflicts",
        contradictions.length
          ? "Review the conflicting evidence before accepting any canonical summary changes."
          : "No explicit conflicts were called out."
      );
      const followups = questionAnswer(session.questions, "followups", "Track follow-up questions on the source session page.");
      const updateBlock = [
        `## Guided Session Update: ${scope.title}`,
        "",
        `Evidence State: \`${evidenceState}\``,
        `Session: [[outputs/source-sessions/${scope.id}|Guided Session]]`,
        `Source Guide: [[outputs/source-guides/${scope.id}|Source Guide]]`,
        "",
        "### What Matters Now",
        "",
        importance,
        "",
        "### Proposed Integration",
        "",
        targetPage
          ? `- Fold the strongest source-backed takeaways into [[${targetPage.path.replace(/\.md$/, "")}|${targetPage.title}]].`
          : `- Start a durable topic note for ${scope.title}.`,
        ...analyses.slice(0, 5).map((analysis) => `- ${truncate(normalizeWhitespace(analysis.summary), 180)}`),
        "",
        "### Keep Provisional Or Out",
        "",
        exclude,
        "",
        "### Reinforcing Or Conflicting Notes",
        "",
        conflictNotes,
        ...(contradictions.length
          ? ["", ...contradictions.slice(0, 4).map((contradiction) => `- ${contradiction.claimA} / ${contradiction.claimB}`)]
          : []),
        "",
        "### Follow-up Questions",
        "",
        followups,
        ""
      ].join("\n");
      const nextBody = replaceMarkedSection(baseBody, scope.id, updateBlock);
      const content = matter.stringify(
        `${nextBody.trimEnd()}\n`,
        JSON.parse(
          JSON.stringify({
            ...existingData,
            page_id:
              (typeof existingData.page_id === "string" && existingData.page_id.trim()) ||
              (useCanonicalTargets && targetPage ? targetPage.id : `insight:${slugify(relativePath.replace(/\.md$/, ""))}`),
            kind: useCanonicalTargets && targetPage ? targetPage.kind : "insight",
            title,
            tags: uniqueStrings([
              ...(Array.isArray(existingData.tags) ? existingData.tags.filter((value): value is string => typeof value === "string") : []),
              ...(useCanonicalTargets ? ["guided-session", `guided/${targetPage?.kind ?? "page"}`] : insightTagsForTarget(targetPage))
            ]),
            source_ids: uniqueStrings([...existingSourceIds, ...scope.sourceIds]),
            project_ids: uniqueStrings([...existingProjectIds, ...(targetPage?.projectIds ?? [])]),
            node_ids: uniqueStrings([...existingNodeIds, ...(targetPage?.nodeIds ?? [])]),
            freshness: "fresh",
            status: existingData.status === "archived" ? "archived" : "active",
            confidence: 0.83,
            created_at: createdAt,
            updated_at: new Date().toISOString(),
            compiled_from: uniqueStrings([
              ...(Array.isArray(existingData.compiled_from)
                ? existingData.compiled_from.filter((value): value is string => typeof value === "string")
                : []),
              ...scope.sourceIds
            ]),
            managed_by:
              typeof existingData.managed_by === "string" && (existingData.managed_by === "human" || existingData.managed_by === "system")
                ? existingData.managed_by
                : useCanonicalTargets
                  ? "system"
                  : "human",
            backlinks: uniqueStrings([
              ...existingBacklinks,
              ...(targetPage ? [targetPage.id] : []),
              `output:source-sessions/${scope.id}`,
              `output:source-guides/${scope.id}`
            ]),
            schema_hash: typeof existingData.schema_hash === "string" ? existingData.schema_hash : "",
            source_hashes: existingData.source_hashes && typeof existingData.source_hashes === "object" ? existingData.source_hashes : {},
            source_semantic_hashes:
              existingData.source_semantic_hashes && typeof existingData.source_semantic_hashes === "object"
                ? existingData.source_semantic_hashes
                : {},
            profile_presets: config.profile.presets,
            source_type: scopeSourceType(scope, scopeManifests),
            occurred_at: scopeOccurredAt(scopeManifests),
            participants: scopeParticipants(scopeManifests),
            container_title: scopeContainerTitle(scopeManifests),
            conversation_id: scopeConversationId(scopeManifests),
            session_status: session.status,
            question_state: questionStateForSession(session),
            canonical_targets: useCanonicalTargets ? selectedTargets.map((page) => page.path) : [],
            evidence_state: evidenceState
          })
        ) as Record<string, unknown>
      );
      const page = parseStoredPage(relativePath, content, {
        createdAt,
        updatedAt: new Date().toISOString()
      });
      if (!useCanonicalTargets && !selectedTargets.length) {
        session.targetedPagePaths = uniqueStrings([...session.targetedPagePaths, relativePath]);
      }
      return { page, content, label: "guided-update" as const };
    })
  );
}

async function stageSourceGuideForScope(
  rootDir: string,
  scope: SourceScope,
  options: { answers?: GuidedSourceSessionAnswers } = {}
): Promise<SourceGuideResult> {
  const { session, statePath } = await prepareGuidedSourceSession(rootDir, scope, options.answers);
  const briefPath = scope.briefPath ?? session.briefPath ?? (await writeSourceBriefForScope(rootDir, scope)) ?? undefined;
  session.briefPath = briefPath;

  if (briefPath) {
    await refreshVaultAfterOutputSave(rootDir);
  }

  if (answeredGuidedSessionQuestions(session.questions).length === 0) {
    session.status = "awaiting_input";
    const persisted = await persistSourceSessionPage(rootDir, scope, session);
    session.sessionPath = persisted.sessionPath;
    await writeGuidedSourceSession(rootDir, session);
    await refreshVaultAfterOutputSave(rootDir);
    return {
      sourceId: scope.id,
      sessionId: session.sessionId,
      sessionPath: persisted.sessionPath,
      sessionStatePath: statePath,
      status: session.status,
      questions: session.questions,
      awaitingInput: true,
      targetedPagePaths: session.targetedPagePaths,
      stagedUpdatePaths: session.stagedUpdatePaths,
      briefPath,
      staged: false
    };
  }

  session.status = "ready_to_stage";
  await writeGuidedSourceSession(rootDir, session);

  const reviewOutput = await buildSourceReviewStagedPage(rootDir, scope);
  const guideOutput = await buildSourceGuideStagedPage(rootDir, {
    ...scope,
    briefPath
  });
  const guidedUpdates = await buildGuidedUpdatePages(rootDir, scope, session);
  session.stagedUpdatePaths = guidedUpdates.map((item) => item.page.path);
  const approval = await stageGeneratedOutputPages(
    rootDir,
    [
      { page: reviewOutput.page, content: reviewOutput.content, label: "source-review" },
      { page: guideOutput.page, content: guideOutput.content, label: "source-guide" },
      ...guidedUpdates
    ],
    {
      bundleType: "guided_session",
      title: `Guided Session: ${scope.title}`,
      sourceSessionId: session.sessionId
    }
  );
  session.status = "staged";
  session.reviewPath = path.join(approval.approvalDir, "wiki", reviewOutput.page.path);
  session.guidePath = path.join(approval.approvalDir, "wiki", guideOutput.page.path);
  session.approvalId = approval.approvalId;
  session.approvalDir = approval.approvalDir;
  const persisted = await persistSourceSessionPage(rootDir, scope, session);
  session.sessionPath = persisted.sessionPath;
  await writeGuidedSourceSession(rootDir, session);
  await refreshVaultAfterOutputSave(rootDir);
  return {
    sourceId: scope.id,
    pageId: guideOutput.page.id,
    guidePath: session.guidePath,
    reviewPageId: reviewOutput.page.id,
    reviewPath: session.reviewPath,
    sessionId: session.sessionId,
    sessionPath: persisted.sessionPath,
    sessionStatePath: statePath,
    status: session.status,
    questions: session.questions,
    targetedPagePaths: session.targetedPagePaths,
    stagedUpdatePaths: session.stagedUpdatePaths,
    briefPath,
    staged: true,
    approvalId: approval.approvalId,
    approvalDir: approval.approvalDir
  };
}

function scopeFromManagedSource(source: ManagedSourceRecord): SourceScope {
  return {
    id: source.id,
    title: source.title,
    sourceIds: source.sourceIds,
    kind: source.kind,
    briefPath: source.briefPath
  };
}

function scopeFromManifest(manifest: SourceManifest, manifests: SourceManifest[]): SourceScope {
  const groupId = manifest.sourceGroupId ?? manifest.sourceId;
  return {
    id: groupId,
    title: manifest.sourceGroupTitle ?? manifest.title,
    sourceIds: manifest.sourceGroupId
      ? manifests.filter((candidate) => candidate.sourceGroupId === manifest.sourceGroupId).map((candidate) => candidate.sourceId)
      : [manifest.sourceId],
    kind: manifest.sourceKind
  };
}

async function resolveSourceScope(rootDir: string, id: string): Promise<SourceScope | null> {
  const managedSources = await loadManagedSources(rootDir);
  const managedSource = managedSources.find((source) => source.id === id);
  if (managedSource) {
    return scopeFromManagedSource(managedSource);
  }

  const latestSession = await findLatestGuidedSourceSessionByScope(rootDir, id);
  if (latestSession) {
    return {
      id: latestSession.scopeId,
      title: latestSession.scopeTitle,
      sourceIds: latestSession.sourceIds
    };
  }

  const manifests = await listManifests(rootDir);
  const manifest =
    manifests.find((candidate) => candidate.sourceId === id) ?? manifests.find((candidate) => candidate.sourceGroupId === id);
  if (!manifest) {
    return null;
  }
  return scopeFromManifest(manifest, manifests);
}

export async function reviewSourceScope(rootDir: string, scope: SourceScope): Promise<SourceReviewResult> {
  return await stageSourceReviewForScope(rootDir, scope);
}

export async function guideSourceScope(
  rootDir: string,
  scope: SourceScope,
  options: { answers?: GuidedSourceSessionAnswers } = {}
): Promise<SourceGuideResult> {
  return await stageSourceGuideForScope(rootDir, scope, options);
}

export async function reviewManagedSource(rootDir: string, id: string): Promise<SourceReviewResult> {
  const scope = await resolveSourceScope(rootDir, id);
  if (!scope) {
    throw new Error(`Managed source or source id not found: ${id}`);
  }
  if (!(await loadVaultConfig(rootDir).then(({ paths }) => fileExists(paths.graphPath)))) {
    await compileVault(rootDir, {});
  }
  return await stageSourceReviewForScope(rootDir, scope);
}

export async function guideManagedSource(
  rootDir: string,
  id: string,
  options: { answers?: GuidedSourceSessionAnswers } = {}
): Promise<SourceGuideResult> {
  const scope = await resolveSourceScope(rootDir, id);
  if (!scope) {
    throw new Error(`Managed source or source id not found: ${id}`);
  }
  if (!(await loadVaultConfig(rootDir).then(({ paths }) => fileExists(paths.graphPath)))) {
    await compileVault(rootDir, {});
  }
  return await stageSourceGuideForScope(rootDir, scope, options);
}

export async function resumeSourceSession(
  rootDir: string,
  id: string,
  options: { answers?: GuidedSourceSessionAnswers } = {}
): Promise<SourceGuideResult> {
  const existingSession = await readGuidedSourceSession(rootDir, id);
  if (existingSession) {
    return await stageSourceGuideForScope(
      rootDir,
      {
        id: existingSession.scopeId,
        title: existingSession.scopeTitle,
        sourceIds: existingSession.sourceIds,
        kind: existingSession.kind,
        briefPath: existingSession.briefPath
      },
      options
    );
  }

  const scope = await resolveSourceScope(rootDir, id);
  if (!scope) {
    throw new Error(`Managed source, source scope, or guided session not found: ${id}`);
  }
  return await stageSourceGuideForScope(rootDir, scope, options);
}

function shouldCompile(changedSources: ManagedSourceRecord[], graphExists: boolean, compileRequested: boolean): boolean {
  return compileRequested && (!graphExists || changedSources.length > 0);
}

export async function listManagedSourceRecords(rootDir: string): Promise<ManagedSourceRecord[]> {
  await ensureManagedSourcesArtifact(rootDir);
  return await loadManagedSources(rootDir);
}

export async function addManagedSource(
  rootDir: string,
  input: string,
  options: ManagedSourceAddOptions = {}
): Promise<ManagedSourceAddResult> {
  const compileRequested = options.compile ?? true;
  const guideRequested = options.guide ?? false;
  const briefRequested = guideRequested ? true : (options.brief ?? true);
  const reviewRequested = guideRequested ? false : (options.review ?? false);
  const sources = await loadManagedSources(rootDir);
  const resolved = await resolveManagedSourceInput(rootDir, input);
  const existing = sources.find((candidate) => matchesManagedSourceSpec(candidate, resolved));
  const now = new Date().toISOString();
  const source: ManagedSourceRecord = existing ?? {
    id:
      resolved.kind === "directory" || resolved.kind === "file"
        ? stableManagedSourceId(resolved.kind, path.resolve(resolved.path), resolved.title)
        : stableManagedSourceId(resolved.kind, resolved.url, resolved.title),
    kind: resolved.kind,
    title: resolved.title,
    path: resolved.kind === "directory" || resolved.kind === "file" ? resolved.path : undefined,
    repoRoot: resolved.kind === "directory" ? resolved.repoRoot : undefined,
    url: resolved.kind === "directory" || resolved.kind === "file" ? undefined : resolved.url,
    createdAt: now,
    updatedAt: now,
    status: "ready",
    sourceIds: []
  };

  const synced = await syncManagedSource(rootDir, source, options);
  if (synced.lastSyncStatus === "error") {
    throw new Error(synced.lastError ?? `Failed to add managed source ${synced.id}.`);
  }
  const graphExists = await loadVaultConfig(rootDir).then(({ paths }) => fileExists(paths.graphPath));
  let compile: Awaited<ReturnType<typeof compileVault>> | undefined;
  if (shouldCompile([synced], graphExists, compileRequested)) {
    compile = await compileVault(rootDir, {});
  }

  let briefGenerated = false;
  let briefPath: string | undefined;
  if (compileRequested && briefRequested && synced.status === "ready") {
    const briefs = await generateBriefsForSources(rootDir, [synced]);
    briefPath = briefs.get(synced.id);
    briefGenerated = Boolean(briefPath);
  }

  const nextSource = {
    ...synced,
    briefPath: briefPath ?? synced.briefPath,
    updatedAt: new Date().toISOString()
  };
  const nextSources = existing
    ? sources.map((candidate) => (candidate.id === nextSource.id ? nextSource : candidate))
    : [...sources, nextSource];
  await saveManagedSources(rootDir, nextSources);

  const review =
    reviewRequested && nextSource.status === "ready"
      ? await stageSourceReviewForScope(rootDir, scopeFromManagedSource(nextSource))
      : undefined;
  const guide =
    guideRequested && nextSource.status === "ready"
      ? await stageSourceGuideForScope(
          rootDir,
          {
            ...scopeFromManagedSource(nextSource),
            briefPath: nextSource.briefPath
          },
          { answers: options.guideAnswers }
        )
      : undefined;

  return {
    source: nextSource,
    compile,
    briefGenerated,
    review,
    guide
  };
}

export async function reloadManagedSources(rootDir: string, options: ManagedSourceReloadOptions = {}): Promise<ManagedSourceReloadResult> {
  const compileRequested = options.compile ?? true;
  const guideRequested = options.guide ?? false;
  const briefRequested = guideRequested ? true : (options.brief ?? true);
  const reviewRequested = guideRequested ? false : (options.review ?? false);
  const sources = await loadManagedSources(rootDir);
  const selected = options.all || !options.id ? sources : sources.filter((source) => source.id === options.id);
  if (!selected.length) {
    throw new Error(options.id ? `Managed source not found: ${options.id}` : "No managed sources registered.");
  }

  const syncedSources: ManagedSourceRecord[] = [];
  const changedSources: ManagedSourceRecord[] = [];
  for (const source of selected) {
    const synced = await syncManagedSource(rootDir, source, options);
    syncedSources.push(synced);
    if (synced.changed) {
      changedSources.push(synced);
    }
  }

  const graphExists = await loadVaultConfig(rootDir).then(({ paths }) => fileExists(paths.graphPath));
  let compile: Awaited<ReturnType<typeof compileVault>> | undefined;
  if (shouldCompile(changedSources, graphExists, compileRequested)) {
    compile = await compileVault(rootDir, {});
  }

  const briefPaths =
    compileRequested && briefRequested
      ? await generateBriefsForSources(
          rootDir,
          syncedSources.filter((source) => source.status === "ready")
        )
      : new Map();
  const nextSources = sources.map((source) => {
    const synced = syncedSources.find((candidate) => candidate.id === source.id);
    if (!synced) {
      return source;
    }
    return {
      ...synced,
      briefPath: briefPaths.get(synced.id) ?? synced.briefPath,
      updatedAt: new Date().toISOString()
    };
  });
  await saveManagedSources(rootDir, nextSources);
  const reviews = reviewRequested
    ? await Promise.all(
        nextSources
          .filter((source) => selected.some((candidate) => candidate.id === source.id))
          .filter((source) => source.status === "ready")
          .map(async (source) => await stageSourceReviewForScope(rootDir, scopeFromManagedSource(source)))
      )
    : [];
  const guides = guideRequested
    ? await Promise.all(
        nextSources
          .filter((source) => selected.some((candidate) => candidate.id === source.id))
          .filter((source) => source.status === "ready")
          .map(
            async (source) =>
              await stageSourceGuideForScope(
                rootDir,
                {
                  ...scopeFromManagedSource(source),
                  briefPath: source.briefPath
                },
                { answers: options.guideAnswers }
              )
          )
      )
    : [];

  return {
    sources: nextSources.filter((source) => selected.some((candidate) => candidate.id === source.id)),
    compile,
    briefPaths: [...briefPaths.values()],
    reviews,
    guides
  };
}

export async function deleteManagedSource(rootDir: string, id: string): Promise<ManagedSourceDeleteResult> {
  const sources = await loadManagedSources(rootDir);
  const target = sources.find((source) => source.id === id);
  if (!target) {
    throw new Error(`Managed source not found: ${id}`);
  }
  await saveManagedSources(
    rootDir,
    sources.filter((source) => source.id !== id)
  );
  const workingDir = await managedSourceWorkingDir(rootDir, id);
  await fs.rm(workingDir, { recursive: true, force: true });
  return { removed: target };
}
