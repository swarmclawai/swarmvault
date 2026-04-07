import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { installConfiguredAgents } from "./agents.js";
import { analysisSignature, analyzeSource } from "./analysis.js";
import { conflictConfidence, edgeConfidence, nodeConfidence } from "./confidence.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { ingestInput, listManifests, readExtractedText } from "./ingest.js";
import { appendLogEntry } from "./logs.js";
import { buildAggregatePage, buildIndexPage, buildOutputPage, buildSectionIndex, buildSourcePage } from "./markdown.js";
import { getProviderForTask } from "./providers/registry.js";
import { buildSchemaPrompt, loadVaultSchema } from "./schema.js";
import { rebuildSearchIndex, searchPages } from "./search.js";
import type {
  CompileResult,
  CompileState,
  GraphArtifact,
  GraphEdge,
  GraphNode,
  GraphPage,
  LintFinding,
  QueryResult,
  SearchResult,
  SourceAnalysis,
  SourceManifest
} from "./types.js";
import {
  ensureDir,
  fileExists,
  normalizeWhitespace,
  readJsonFile,
  slugify,
  truncate,
  uniqueBy,
  writeFileIfChanged,
  writeJsonFile
} from "./utils.js";

function buildGraph(manifests: SourceManifest[], analyses: SourceAnalysis[], pages: GraphPage[]): GraphArtifact {
  const sourceNodes: GraphNode[] = manifests.map((manifest) => ({
    id: `source:${manifest.sourceId}`,
    type: "source",
    label: manifest.title,
    pageId: `source:${manifest.sourceId}`,
    freshness: "fresh",
    confidence: 1,
    sourceIds: [manifest.sourceId]
  }));

  const conceptMap = new Map<string, GraphNode>();
  const entityMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const analysis of analyses) {
    for (const concept of analysis.concepts) {
      const existing = conceptMap.get(concept.id);
      const sourceIds = [...new Set([...(existing?.sourceIds ?? []), analysis.sourceId])];
      conceptMap.set(concept.id, {
        id: concept.id,
        type: "concept",
        label: concept.name,
        pageId: `concept:${slugify(concept.name)}`,
        freshness: "fresh",
        confidence: nodeConfidence(sourceIds.length),
        sourceIds
      });
      edges.push({
        id: `${analysis.sourceId}->${concept.id}`,
        source: `source:${analysis.sourceId}`,
        target: concept.id,
        relation: "mentions",
        status: "extracted",
        confidence: edgeConfidence(analysis.claims, concept.name),
        provenance: [analysis.sourceId]
      });
    }

    for (const entity of analysis.entities) {
      const existing = entityMap.get(entity.id);
      const sourceIds = [...new Set([...(existing?.sourceIds ?? []), analysis.sourceId])];
      entityMap.set(entity.id, {
        id: entity.id,
        type: "entity",
        label: entity.name,
        pageId: `entity:${slugify(entity.name)}`,
        freshness: "fresh",
        confidence: nodeConfidence(sourceIds.length),
        sourceIds
      });
      edges.push({
        id: `${analysis.sourceId}->${entity.id}`,
        source: `source:${analysis.sourceId}`,
        target: entity.id,
        relation: "mentions",
        status: "extracted",
        confidence: edgeConfidence(analysis.claims, entity.name),
        provenance: [analysis.sourceId]
      });
    }
  }

  // Concept-scoped conflict detection
  const conceptClaims = new Map<string, Array<{ claim: SourceAnalysis["claims"][number]; sourceId: string }>>();
  for (const analysis of analyses) {
    for (const claim of analysis.claims) {
      for (const concept of analysis.concepts) {
        if (claim.text.toLowerCase().includes(concept.name.toLowerCase())) {
          const key = concept.id;
          const list = conceptClaims.get(key) ?? [];
          list.push({ claim, sourceId: analysis.sourceId });
          conceptClaims.set(key, list);
        }
      }
    }
  }

  const conflictEdgeKeys = new Set<string>();
  for (const [, claimsForConcept] of conceptClaims) {
    const positive = claimsForConcept.filter((c) => c.claim.polarity === "positive");
    const negative = claimsForConcept.filter((c) => c.claim.polarity === "negative");
    for (const pos of positive) {
      for (const neg of negative) {
        if (pos.sourceId === neg.sourceId) {
          continue;
        }
        const edgeKey = [pos.sourceId, neg.sourceId].sort().join("|");
        if (conflictEdgeKeys.has(edgeKey)) {
          continue;
        }
        conflictEdgeKeys.add(edgeKey);
        edges.push({
          id: `conflict:${pos.claim.id}->${neg.claim.id}`,
          source: `source:${pos.sourceId}`,
          target: `source:${neg.sourceId}`,
          relation: "conflicted_with",
          status: "conflicted",
          confidence: conflictConfidence(pos.claim, neg.claim),
          provenance: [pos.sourceId, neg.sourceId]
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: [...sourceNodes, ...conceptMap.values(), ...entityMap.values()],
    edges,
    sources: manifests,
    pages
  };
}

async function writePage(wikiDir: string, relativePath: string, content: string, changedPages: string[]): Promise<void> {
  const absolutePath = path.resolve(wikiDir, relativePath);
  const changed = await writeFileIfChanged(absolutePath, content);
  if (changed) {
    changedPages.push(relativePath);
  }
}

function aggregateItems(
  analyses: SourceAnalysis[],
  kind: "concepts" | "entities"
): Array<{ name: string; descriptions: string[]; sourceAnalyses: SourceAnalysis[]; sourceHashes: Record<string, string> }> {
  const grouped = new Map<
    string,
    { name: string; descriptions: string[]; sourceAnalyses: SourceAnalysis[]; sourceHashes: Record<string, string> }
  >();
  for (const analysis of analyses) {
    for (const item of analysis[kind]) {
      const key = slugify(item.name);
      const existing = grouped.get(key) ?? {
        name: item.name,
        descriptions: [],
        sourceAnalyses: [],
        sourceHashes: {}
      };
      existing.descriptions.push(item.description);
      existing.sourceAnalyses.push(analysis);
      existing.sourceHashes[analysis.sourceId] = analysis.sourceHash;
      grouped.set(key, existing);
    }
  }
  return [...grouped.values()];
}

export async function initVault(rootDir: string): Promise<void> {
  await initWorkspace(rootDir);
  await installConfiguredAgents(rootDir);
}

export async function compileVault(rootDir: string): Promise<CompileResult> {
  const { paths } = await initWorkspace(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "compileProvider");
  const manifests = await listManifests(rootDir);

  // Incremental compilation: compare against previous compile state
  const previousState = await readJsonFile<CompileState>(paths.compileStatePath);
  const schemaChanged = !previousState || previousState.schemaHash !== schema.hash;
  const previousSourceHashes = previousState?.sourceHashes ?? {};
  const previousAnalyses = previousState?.analyses ?? {};
  const currentSourceIds = new Set(manifests.map((m) => m.sourceId));
  const previousSourceIds = new Set(Object.keys(previousSourceHashes));
  const sourcesChanged = currentSourceIds.size !== previousSourceIds.size || [...currentSourceIds].some((id) => !previousSourceIds.has(id));

  const dirty: SourceManifest[] = [];
  const clean: SourceManifest[] = [];

  for (const manifest of manifests) {
    const hashChanged = previousSourceHashes[manifest.sourceId] !== manifest.contentHash;
    const noAnalysis = !previousAnalyses[manifest.sourceId];
    if (schemaChanged || hashChanged || noAnalysis) {
      dirty.push(manifest);
    } else {
      clean.push(manifest);
    }
  }

  // Early return when nothing changed
  if (dirty.length === 0 && !schemaChanged && !sourcesChanged) {
    return {
      graphPath: paths.graphPath,
      pageCount: previousState?.analyses ? Object.keys(previousState.analyses).length : 0,
      changedPages: [],
      sourceCount: manifests.length
    };
  }

  // Only analyze dirty sources; load cached analyses for clean ones
  const [dirtyAnalyses, cleanAnalyses] = await Promise.all([
    Promise.all(
      dirty.map(async (manifest) => analyzeSource(manifest, await readExtractedText(rootDir, manifest), provider, paths, schema))
    ),
    Promise.all(
      clean.map(async (manifest) => {
        const cached = await readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${manifest.sourceId}.json`));
        if (cached) {
          return cached;
        }
        return analyzeSource(manifest, await readExtractedText(rootDir, manifest), provider, paths, schema);
      })
    )
  ]);

  const analyses = [...dirtyAnalyses, ...cleanAnalyses];
  const changedPages: string[] = [];
  const pages: GraphPage[] = [];

  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs"))
  ]);

  for (const manifest of manifests) {
    const analysis = analyses.find((item) => item.sourceId === manifest.sourceId);
    if (!analysis) {
      continue;
    }
    const sourcePage = buildSourcePage(manifest, analysis, schema.hash, 1.0);
    pages.push(sourcePage.page);
    await writePage(paths.wikiDir, sourcePage.page.path, sourcePage.content, changedPages);
  }

  for (const aggregate of aggregateItems(analyses, "concepts")) {
    const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
    const page = buildAggregatePage(
      "concept",
      aggregate.name,
      aggregate.descriptions,
      aggregate.sourceAnalyses,
      aggregate.sourceHashes,
      schema.hash,
      confidence
    );
    pages.push(page.page);
    await writePage(paths.wikiDir, page.page.path, page.content, changedPages);
  }

  for (const aggregate of aggregateItems(analyses, "entities")) {
    const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
    const page = buildAggregatePage(
      "entity",
      aggregate.name,
      aggregate.descriptions,
      aggregate.sourceAnalyses,
      aggregate.sourceHashes,
      schema.hash,
      confidence
    );
    pages.push(page.page);
    await writePage(paths.wikiDir, page.page.path, page.content, changedPages);
  }

  const graph = buildGraph(manifests, analyses, pages);
  await writeJsonFile(paths.graphPath, graph);
  await writeJsonFile(paths.compileStatePath, {
    generatedAt: graph.generatedAt,
    schemaHash: schema.hash,
    analyses: Object.fromEntries(analyses.map((a) => [a.sourceId, analysisSignature(a)])),
    sourceHashes: Object.fromEntries(manifests.map((m) => [m.sourceId, m.contentHash]))
  } satisfies CompileState);

  await writePage(paths.wikiDir, "index.md", buildIndexPage(pages, schema.hash), changedPages);
  await writePage(
    paths.wikiDir,
    "sources/index.md",
    buildSectionIndex(
      "sources",
      pages.filter((page) => page.kind === "source"),
      schema.hash
    ),
    changedPages
  );
  await writePage(
    paths.wikiDir,
    "concepts/index.md",
    buildSectionIndex(
      "concepts",
      pages.filter((page) => page.kind === "concept"),
      schema.hash
    ),
    changedPages
  );
  await writePage(
    paths.wikiDir,
    "entities/index.md",
    buildSectionIndex(
      "entities",
      pages.filter((page) => page.kind === "entity"),
      schema.hash
    ),
    changedPages
  );

  if (changedPages.length > 0) {
    await rebuildSearchIndex(paths.searchDbPath, pages, paths.wikiDir);
  }

  await appendLogEntry(rootDir, "compile", `Compiled ${manifests.length} source(s)`, [
    `provider=${provider.id}`,
    `pages=${pages.length}`,
    `dirty=${dirty.length}`,
    `clean=${clean.length}`,
    `schema=${schema.hash.slice(0, 12)}`
  ]);

  return {
    graphPath: paths.graphPath,
    pageCount: pages.length,
    changedPages,
    sourceCount: manifests.length
  };
}

export async function queryVault(rootDir: string, question: string, save = false): Promise<QueryResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (!(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir);
  }

  const searchResults = searchPages(paths.searchDbPath, question, 5);
  const excerpts = await Promise.all(
    searchResults.map(async (result) => {
      const absolutePath = path.join(paths.wikiDir, result.path);
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      return `# ${result.title}\n${truncate(normalizeWhitespace(parsed.content), 1200)}`;
    })
  );

  // Load raw source material for grounding (spec principle #6)
  const allSourceIds: string[] = [];
  for (const result of searchResults) {
    const absolutePath = path.join(paths.wikiDir, result.path);
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      const ids = parsed.data.source_ids;
      if (Array.isArray(ids)) {
        allSourceIds.push(...ids);
      }
    } catch {
      // Page may not exist
    }
  }
  const sourceIds = uniqueBy(allSourceIds, (id) => id).slice(0, 5);

  const manifests = await listManifests(rootDir);
  const rawExcerpts: string[] = [];
  for (const sourceId of sourceIds) {
    const manifest = manifests.find((m) => m.sourceId === sourceId);
    if (!manifest) {
      continue;
    }
    const text = await readExtractedText(rootDir, manifest);
    if (text) {
      rawExcerpts.push(`# [source:${sourceId}] ${manifest.title}\n${truncate(normalizeWhitespace(text), 800)}`);
    }
  }

  let answer: string;
  if (provider.type === "heuristic") {
    answer = [
      `Question: ${question}`,
      "",
      "Relevant pages:",
      ...searchResults.map((result) => `- ${result.title} (${result.path})`),
      "",
      excerpts.length ? excerpts.join("\n\n") : "No relevant pages found yet.",
      ...(rawExcerpts.length ? ["", "Raw source material:", "", ...rawExcerpts] : [])
    ].join("\n");
  } else {
    const context = [
      "Wiki context:",
      excerpts.join("\n\n---\n\n"),
      ...(rawExcerpts.length ? ["", "Raw source material:", rawExcerpts.join("\n\n---\n\n")] : [])
    ].join("\n\n");

    const response = await provider.generateText({
      system: buildSchemaPrompt(
        schema,
        "Answer using the provided context. Prefer raw source material over wiki summaries when they differ. Cite source IDs."
      ),
      prompt: `Question: ${question}\n\n${context}`
    });
    answer = response.text;
  }

  const citations = uniqueBy(
    searchResults.filter((result) => result.pageId.startsWith("source:")).map((result) => result.pageId.replace(/^source:/, "")),
    (item) => item
  );
  let savedTo: string | undefined;
  if (save) {
    const output = buildOutputPage(question, answer, citations, schema.hash);
    const absolutePath = path.join(paths.wikiDir, output.page.path);
    await ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, output.content, "utf8");
    savedTo = absolutePath;
  }

  await appendLogEntry(rootDir, "query", question, [
    `citations=${citations.join(",") || "none"}`,
    `saved=${Boolean(savedTo)}`,
    `rawSources=${rawExcerpts.length}`
  ]);
  return { answer, savedTo, citations };
}

export async function searchVault(rootDir: string, query: string, limit = 5): Promise<SearchResult[]> {
  const { paths } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir);
  }

  return searchPages(paths.searchDbPath, query, limit);
}

export async function listPages(rootDir: string): Promise<GraphPage[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  return graph?.pages ?? [];
}

export async function readPage(
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

export async function getWorkspaceInfo(rootDir: string): Promise<{
  rootDir: string;
  configPath: string;
  schemaPath: string;
  rawDir: string;
  wikiDir: string;
  stateDir: string;
  agentDir: string;
  inboxDir: string;
  sourceCount: number;
  pageCount: number;
}> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifests = await listManifests(rootDir);
  const pages = await listPages(rootDir);

  return {
    rootDir,
    configPath: paths.configPath,
    schemaPath: paths.schemaPath,
    rawDir: paths.rawDir,
    wikiDir: paths.wikiDir,
    stateDir: paths.stateDir,
    agentDir: paths.agentDir,
    inboxDir: paths.inboxDir,
    sourceCount: manifests.length,
    pageCount: pages.length
  };
}

export async function lintVault(rootDir: string): Promise<LintFinding[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const manifests = await listManifests(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const findings: LintFinding[] = [];

  if (!graph) {
    return [
      {
        severity: "warning",
        code: "graph_missing",
        message: "No graph artifact found. Run `swarmvault compile` first."
      }
    ];
  }

  const manifestMap = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));

  for (const page of graph.pages) {
    if (page.schemaHash !== schema.hash) {
      findings.push({
        severity: "warning",
        code: "stale_page",
        message: `Page ${page.title} is stale because the vault schema changed.`,
        pagePath: path.join(paths.wikiDir, page.path)
      });
    }

    for (const [sourceId, knownHash] of Object.entries(page.sourceHashes)) {
      const manifest = manifestMap.get(sourceId);
      if (manifest && manifest.contentHash !== knownHash) {
        findings.push({
          severity: "warning",
          code: "stale_page",
          message: `Page ${page.title} is stale because source ${sourceId} changed.`,
          pagePath: path.join(paths.wikiDir, page.path)
        });
      }
    }

    if (page.kind !== "index" && page.backlinks.length === 0) {
      findings.push({
        severity: "info",
        code: "orphan_page",
        message: `Page ${page.title} has no backlinks.`,
        pagePath: path.join(paths.wikiDir, page.path)
      });
    }

    const absolutePath = path.join(paths.wikiDir, page.path);
    if (await fileExists(absolutePath)) {
      const content = await fs.readFile(absolutePath, "utf8");
      if (content.includes("## Claims")) {
        const uncited = content.split("\n").filter((line) => line.startsWith("- ") && !line.includes("[source:"));
        if (uncited.length) {
          findings.push({
            severity: "warning",
            code: "uncited_claims",
            message: `Page ${page.title} contains uncited claim bullets.`,
            pagePath: absolutePath
          });
        }
      }
    }
  }

  await appendLogEntry(rootDir, "lint", `Linted ${graph.pages.length} page(s)`, [`findings=${findings.length}`]);
  return findings;
}

export async function bootstrapDemo(rootDir: string, input?: string): Promise<{ manifestId?: string; compile?: CompileResult }> {
  await initVault(rootDir);
  if (!input) {
    return {};
  }
  const manifest = await ingestInput(rootDir, input);
  const compile = await compileVault(rootDir);
  return {
    manifestId: manifest.sourceId,
    compile
  };
}
