import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { loadVaultConfig } from "./config.js";
import { ingestDirectory, ingestInputDetailed, listManifests, removeManifestBySourceId, validateUrlSafety } from "./ingest.js";
import { buildOutputPage } from "./markdown.js";
import { getProviderForTask } from "./providers/registry.js";
import { buildSchemaPrompt, loadVaultSchemas } from "./schema.js";
import { ensureManagedSourcesArtifact, loadManagedSources, managedSourceWorkingDir, saveManagedSources } from "./source-registry.js";
import type {
  GraphArtifact,
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
  SourceManifest
} from "./types.js";
import { ensureDir, fileExists, normalizeWhitespace, readJsonFile, sha256, slugify, truncate, uniqueBy } from "./utils.js";
import { compileVault, readGraphReport, refreshVaultAfterOutputSave } from "./vault.js";

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
  if (input.kind === "directory") {
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
    if (!stat.isDirectory()) {
      throw new Error(
        "`swarmvault source add` supports directories, public GitHub repo root URLs, and docs hubs. Use `swarmvault ingest` for single files."
      );
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
  source: ManagedSourceRecord;
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

async function generateSourceBriefMarkdown(rootDir: string, source: ManagedSourceRecord): Promise<string | null> {
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
        `Source kind: ${source.kind}`,
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

async function writeSourceBrief(rootDir: string, source: ManagedSourceRecord): Promise<string | null> {
  if (!source.sourceIds.length) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const markdown = await generateSourceBriefMarkdown(rootDir, source);
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
  const briefRequested = options.brief ?? true;
  const sources = await loadManagedSources(rootDir);
  const resolved = await resolveManagedSourceInput(rootDir, input);
  const existing = sources.find((candidate) => matchesManagedSourceSpec(candidate, resolved));
  const now = new Date().toISOString();
  const source: ManagedSourceRecord = existing ?? {
    id:
      resolved.kind === "directory"
        ? stableManagedSourceId("directory", path.resolve(resolved.path), resolved.title)
        : stableManagedSourceId(resolved.kind, resolved.url, resolved.title),
    kind: resolved.kind,
    title: resolved.title,
    path: resolved.kind === "directory" ? resolved.path : undefined,
    repoRoot: resolved.kind === "directory" ? resolved.repoRoot : undefined,
    url: resolved.kind === "directory" ? undefined : resolved.url,
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

  return {
    source: nextSource,
    compile,
    briefGenerated
  };
}

export async function reloadManagedSources(rootDir: string, options: ManagedSourceReloadOptions = {}): Promise<ManagedSourceReloadResult> {
  const compileRequested = options.compile ?? true;
  const briefRequested = options.brief ?? true;
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

  return {
    sources: nextSources.filter((source) => selected.some((candidate) => candidate.id === source.id)),
    compile,
    briefPaths: [...briefPaths.values()]
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
