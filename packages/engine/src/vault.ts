import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { installConfiguredAgents } from "./agents.js";
import { analysisSignature, analyzeSource } from "./analysis.js";
import { conflictConfidence, edgeConfidence, nodeConfidence } from "./confidence.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { runDeepLint } from "./deep-lint.js";
import { ingestInput, listManifests, readExtractedText } from "./ingest.js";
import { recordSession } from "./logs.js";
import {
  buildAggregatePage,
  buildExploreHubPage,
  buildIndexPage,
  buildOutputPage,
  buildSectionIndex,
  buildSourcePage,
  type ManagedGraphPageMetadata,
  type ManagedPageMetadata
} from "./markdown.js";
import { loadSavedOutputPages, relatedOutputsForPage, resolveUniqueOutputSlug } from "./outputs.js";
import { loadExistingManagedPageState, loadInsightPages } from "./pages.js";
import { getProviderForTask } from "./providers/registry.js";
import { buildSchemaPrompt, loadVaultSchema } from "./schema.js";
import { rebuildSearchIndex, searchPages } from "./search.js";
import type {
  CompileResult,
  CompileState,
  ExploreResult,
  ExploreStepResult,
  GraphArtifact,
  GraphEdge,
  GraphNode,
  GraphPage,
  LintFinding,
  LintOptions,
  PageManager,
  PageStatus,
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

type QueryExecutionResult = {
  answer: string;
  citations: string[];
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function pageHashes(pages: Array<{ page: GraphPage; contentHash: string }>): Record<string, string> {
  return Object.fromEntries(pages.map((page) => [page.page.id, page.contentHash]));
}

async function buildManagedGraphPage(
  absolutePath: string,
  defaults: {
    status?: PageStatus;
    managedBy: PageManager;
    confidence: number;
    compiledFrom: string[];
  },
  build: (metadata: ManagedGraphPageMetadata) => { page: GraphPage; content: string }
): Promise<{ page: GraphPage; content: string }> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  const existing = await loadExistingManagedPageState(absolutePath, {
    status: defaults.status ?? "active",
    managedBy: defaults.managedBy
  });

  let metadata: ManagedGraphPageMetadata = {
    status: existing.status,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    compiledFrom: defaults.compiledFrom,
    managedBy: defaults.managedBy,
    confidence: defaults.confidence
  };
  let built = build(metadata);

  if (existingContent && existingContent !== built.content) {
    metadata = {
      ...metadata,
      updatedAt: new Date().toISOString()
    };
    built = build(metadata);
  }

  return built;
}

async function buildManagedContent(
  absolutePath: string,
  defaults: {
    status?: PageStatus;
    managedBy: PageManager;
    compiledFrom: string[];
  },
  build: (metadata: ManagedPageMetadata) => string
): Promise<string> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  const existing = await loadExistingManagedPageState(absolutePath, {
    status: defaults.status ?? "active",
    managedBy: defaults.managedBy
  });

  let metadata: ManagedPageMetadata = {
    status: existing.status,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    compiledFrom: defaults.compiledFrom,
    managedBy: defaults.managedBy
  };
  let content = build(metadata);

  if (existingContent && existingContent !== content) {
    metadata = {
      ...metadata,
      updatedAt: new Date().toISOString()
    };
    content = build(metadata);
  }

  return content;
}

function indexCompiledFrom(pages: GraphPage[]): string[] {
  return uniqueStrings(pages.flatMap((page) => page.sourceIds));
}

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
    const positive = claimsForConcept.filter((item) => item.claim.polarity === "positive");
    const negative = claimsForConcept.filter((item) => item.claim.polarity === "negative");
    for (const positiveClaim of positive) {
      for (const negativeClaim of negative) {
        if (positiveClaim.sourceId === negativeClaim.sourceId) {
          continue;
        }
        const edgeKey = [positiveClaim.sourceId, negativeClaim.sourceId].sort().join("|");
        if (conflictEdgeKeys.has(edgeKey)) {
          continue;
        }
        conflictEdgeKeys.add(edgeKey);
        edges.push({
          id: `conflict:${positiveClaim.claim.id}->${negativeClaim.claim.id}`,
          source: `source:${positiveClaim.sourceId}`,
          target: `source:${negativeClaim.sourceId}`,
          relation: "conflicted_with",
          status: "conflicted",
          confidence: conflictConfidence(positiveClaim.claim, negativeClaim.claim),
          provenance: [positiveClaim.sourceId, negativeClaim.sourceId]
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

function emptyGraphPage(input: {
  id: string;
  path: string;
  title: string;
  kind: GraphPage["kind"];
  sourceIds: string[];
  nodeIds: string[];
  schemaHash: string;
  sourceHashes: Record<string, string>;
  confidence: number;
  status?: PageStatus;
  createdAt?: string;
  updatedAt?: string;
  compiledFrom?: string[];
  managedBy?: PageManager;
}): GraphPage {
  return {
    id: input.id,
    path: input.path,
    title: input.title,
    kind: input.kind,
    sourceIds: input.sourceIds,
    nodeIds: input.nodeIds,
    freshness: "fresh",
    status: input.status ?? "active",
    confidence: input.confidence,
    backlinks: [],
    schemaHash: input.schemaHash,
    sourceHashes: input.sourceHashes,
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    compiledFrom: input.compiledFrom ?? input.sourceIds,
    managedBy: input.managedBy ?? "system"
  };
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

async function requiredCompileArtifactsExist(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"]): Promise<boolean> {
  const requiredPaths = [
    paths.graphPath,
    paths.searchDbPath,
    path.join(paths.wikiDir, "index.md"),
    path.join(paths.wikiDir, "sources", "index.md"),
    path.join(paths.wikiDir, "concepts", "index.md"),
    path.join(paths.wikiDir, "entities", "index.md"),
    path.join(paths.wikiDir, "outputs", "index.md")
  ];

  const checks = await Promise.all(requiredPaths.map((filePath) => fileExists(filePath)));
  return checks.every(Boolean);
}

async function refreshIndexesAndSearch(rootDir: string, schemaHash: string, pages: GraphPage[]): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  await ensureDir(path.join(paths.wikiDir, "outputs"));
  const rootIndexPath = path.join(paths.wikiDir, "index.md");
  const outputsIndexPath = path.join(paths.wikiDir, "outputs", "index.md");
  await writeFileIfChanged(
    rootIndexPath,
    await buildManagedContent(
      rootIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(pages)
      },
      (metadata) => buildIndexPage(pages, schemaHash, metadata)
    )
  );
  await writeFileIfChanged(
    outputsIndexPath,
    await buildManagedContent(
      outputsIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(pages.filter((page) => page.kind === "output"))
      },
      (metadata) =>
        buildSectionIndex(
          "outputs",
          pages.filter((page) => page.kind === "output"),
          schemaHash,
          metadata
        )
    )
  );
  await rebuildSearchIndex(paths.searchDbPath, pages, paths.wikiDir);
}

async function upsertGraphPages(rootDir: string, pages: GraphPage[]): Promise<void> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const manifests = await listManifests(rootDir);
  const nonOutputPages = graph?.pages.filter((page) => page.kind !== "output") ?? [];
  const nextGraph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    sources: graph?.sources ?? manifests,
    pages: [...nonOutputPages, ...pages]
  };
  await writeJsonFile(paths.graphPath, nextGraph);
}

async function persistOutputPage(
  rootDir: string,
  input: Omit<Parameters<typeof buildOutputPage>[0], "metadata">
): Promise<{ page: GraphPage; savedTo: string }> {
  const { paths } = await loadVaultConfig(rootDir);
  const slug = await resolveUniqueOutputSlug(paths.wikiDir, input.slug ?? slugify(input.question));
  const now = new Date().toISOString();
  const output = buildOutputPage({
    ...input,
    slug,
    metadata: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      compiledFrom: uniqueStrings(input.relatedSourceIds ?? input.citations),
      managedBy: "system",
      confidence: 0.74
    }
  });
  const absolutePath = path.join(paths.wikiDir, output.page.path);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, output.content, "utf8");

  const storedOutputs = await loadSavedOutputPages(paths.wikiDir);
  const storedInsights = await loadInsightPages(paths.wikiDir);
  const outputPages = storedOutputs.map((page) => page.page);
  await upsertGraphPages(rootDir, outputPages);

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  await refreshIndexesAndSearch(rootDir, input.schemaHash, graph?.pages ?? [...outputPages, ...storedInsights.map((page) => page.page)]);

  return { page: output.page, savedTo: absolutePath };
}

async function persistExploreHub(
  rootDir: string,
  input: Omit<Parameters<typeof buildExploreHubPage>[0], "metadata">
): Promise<{ page: GraphPage; savedTo: string }> {
  const { paths } = await loadVaultConfig(rootDir);
  const slug = await resolveUniqueOutputSlug(paths.wikiDir, input.slug ?? `explore-${slugify(input.question)}`);
  const now = new Date().toISOString();
  const hub = buildExploreHubPage({
    ...input,
    slug,
    metadata: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      compiledFrom: uniqueStrings(input.citations),
      managedBy: "system",
      confidence: 0.76
    }
  });
  const absolutePath = path.join(paths.wikiDir, hub.page.path);
  await ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, hub.content, "utf8");

  const storedOutputs = await loadSavedOutputPages(paths.wikiDir);
  const storedInsights = await loadInsightPages(paths.wikiDir);
  const outputPages = storedOutputs.map((page) => page.page);
  await upsertGraphPages(rootDir, outputPages);

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  await refreshIndexesAndSearch(rootDir, input.schemaHash, graph?.pages ?? [...outputPages, ...storedInsights.map((page) => page.page)]);

  return { page: hub.page, savedTo: absolutePath };
}

async function executeQuery(rootDir: string, question: string): Promise<QueryExecutionResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (!(await fileExists(paths.searchDbPath)) || !(await fileExists(paths.graphPath))) {
    await compileVault(rootDir);
  }

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const pageMap = new Map((graph?.pages ?? []).map((page) => [page.id, page]));
  const searchResults = searchPages(paths.searchDbPath, question, 5);
  const excerpts = await Promise.all(
    searchResults.map(async (result) => {
      const absolutePath = path.join(paths.wikiDir, result.path);
      try {
        const content = await fs.readFile(absolutePath, "utf8");
        const parsed = matter(content);
        return `# ${result.title}\n${truncate(normalizeWhitespace(parsed.content), 1200)}`;
      } catch {
        return `# ${result.title}\n${result.snippet}`;
      }
    })
  );

  const relatedPageIds = uniqueBy(
    searchResults.map((result) => result.pageId),
    (item) => item
  );
  const relatedNodeIds = uniqueBy(
    relatedPageIds.flatMap((pageId) => pageMap.get(pageId)?.nodeIds ?? []),
    (item) => item
  );
  const relatedSourceIds = uniqueBy(
    relatedPageIds.flatMap((pageId) => pageMap.get(pageId)?.sourceIds ?? []),
    (item) => item
  );

  const manifests = await listManifests(rootDir);
  const rawExcerpts: string[] = [];
  for (const sourceId of relatedSourceIds.slice(0, 5)) {
    const manifest = manifests.find((item) => item.sourceId === sourceId);
    if (!manifest) {
      continue;
    }
    const text = await readExtractedText(rootDir, manifest);
    if (text) {
      rawExcerpts.push(`# [source:${sourceId}] ${manifest.title}\n${truncate(normalizeWhitespace(text), 800)}`);
    }
  }

  let answer: string;
  let usage: QueryExecutionResult["usage"];
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
    usage = response.usage;
  }

  return {
    answer,
    citations: relatedSourceIds,
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds,
    usage
  };
}

async function generateFollowUpQuestions(rootDir: string, question: string, answer: string): Promise<string[]> {
  const provider = await getProviderForTask(rootDir, "queryProvider");
  const schema = await loadVaultSchema(rootDir);

  if (provider.type === "heuristic") {
    return uniqueBy(
      [
        `What evidence best supports ${question}?`,
        `What contradicts ${question}?`,
        `Which sources should be added to answer ${question} better?`
      ],
      (item) => item
    ).slice(0, 3);
  }

  const response = await provider.generateStructured(
    {
      system: buildSchemaPrompt(schema, "Propose concise follow-up research questions for the vault. Return only useful next questions."),
      prompt: `Root question: ${question}\n\nCurrent answer:\n${answer}`
    },
    z.object({
      questions: z.array(z.string().min(1)).max(5)
    })
  );

  return uniqueBy(response.questions, (item) => item).filter((item) => item !== question);
}

export async function initVault(rootDir: string): Promise<void> {
  const { paths } = await initWorkspace(rootDir);
  await installConfiguredAgents(rootDir);
  const insightsIndexPath = path.join(paths.wikiDir, "insights", "index.md");
  const now = new Date().toISOString();
  await writeFileIfChanged(
    insightsIndexPath,
    matter.stringify(
      [
        "# Insights",
        "",
        "Human-authored notes live here.",
        "",
        "- SwarmVault can read these pages during compile and query.",
        "- SwarmVault does not rewrite files inside `wiki/insights/` after initialization.",
        ""
      ].join("\n"),
      {
        page_id: "insights:index",
        kind: "index",
        title: "Insights",
        tags: ["index", "insights"],
        source_ids: [],
        node_ids: [],
        freshness: "fresh",
        status: "active",
        confidence: 1,
        created_at: now,
        updated_at: now,
        compiled_from: [],
        managed_by: "human",
        backlinks: [],
        schema_hash: "",
        source_hashes: {}
      }
    )
  );
}

export async function compileVault(rootDir: string): Promise<CompileResult> {
  const startedAt = new Date().toISOString();
  const { paths } = await initWorkspace(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "compileProvider");
  const manifests = await listManifests(rootDir);
  const storedOutputPages = await loadSavedOutputPages(paths.wikiDir);
  const storedInsightPages = await loadInsightPages(paths.wikiDir);
  const outputPages = storedOutputPages.map((page) => page.page);
  const insightPages = storedInsightPages.map((page) => page.page);
  const currentOutputHashes = pageHashes(storedOutputPages);
  const currentInsightHashes = pageHashes(storedInsightPages);

  const previousState = await readJsonFile<CompileState>(paths.compileStatePath);
  const schemaChanged = !previousState || previousState.schemaHash !== schema.hash;
  const previousSourceHashes = previousState?.sourceHashes ?? {};
  const previousAnalyses = previousState?.analyses ?? {};
  const previousOutputHashes = previousState?.outputHashes ?? {};
  const previousInsightHashes = previousState?.insightHashes ?? {};
  const currentSourceIds = new Set(manifests.map((item) => item.sourceId));
  const previousSourceIds = new Set(Object.keys(previousSourceHashes));
  const sourcesChanged =
    currentSourceIds.size !== previousSourceIds.size || [...currentSourceIds].some((sourceId) => !previousSourceIds.has(sourceId));
  const outputsChanged = !recordsEqual(currentOutputHashes, previousOutputHashes);
  const insightsChanged = !recordsEqual(currentInsightHashes, previousInsightHashes);
  const artifactsExist = await requiredCompileArtifactsExist(paths);

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

  if (dirty.length === 0 && !schemaChanged && !sourcesChanged && !outputsChanged && !insightsChanged && artifactsExist) {
    const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
    await recordSession(rootDir, {
      operation: "compile",
      title: `Compiled ${manifests.length} source(s)`,
      startedAt,
      finishedAt: new Date().toISOString(),
      providerId: provider.id,
      success: true,
      relatedSourceIds: manifests.map((manifest) => manifest.sourceId),
      relatedPageIds: graph?.pages.map((page) => page.id) ?? [...outputPages, ...insightPages].map((page) => page.id),
      changedPages: [],
      lines: [
        `provider=${provider.id}`,
        `pages=${graph?.pages.length ?? outputPages.length + insightPages.length}`,
        `dirty=0`,
        `clean=${manifests.length}`,
        `outputs=${outputPages.length}`,
        `insights=${insightPages.length}`,
        `schema=${schema.hash.slice(0, 12)}`
      ]
    });
    return {
      graphPath: paths.graphPath,
      pageCount: graph?.pages.length ?? outputPages.length + insightPages.length,
      changedPages: [],
      sourceCount: manifests.length
    };
  }

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
  const compiledPages: GraphPage[] = [];

  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs")),
    ensureDir(path.join(paths.wikiDir, "insights"))
  ]);

  for (const manifest of manifests) {
    const analysis = analyses.find((item) => item.sourceId === manifest.sourceId);
    if (!analysis) {
      continue;
    }

    const preview = emptyGraphPage({
      id: `source:${manifest.sourceId}`,
      path: `sources/${manifest.sourceId}.md`,
      title: analysis.title,
      kind: "source",
      sourceIds: [manifest.sourceId],
      nodeIds: [`source:${manifest.sourceId}`, ...analysis.concepts.map((item) => item.id), ...analysis.entities.map((item) => item.id)],
      schemaHash: schema.hash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
      confidence: 1
    });
    const absolutePath = path.join(paths.wikiDir, preview.path);
    const sourcePage = await buildManagedGraphPage(
      absolutePath,
      {
        managedBy: "system",
        confidence: 1,
        compiledFrom: [manifest.sourceId]
      },
      (metadata) => buildSourcePage(manifest, analysis, schema.hash, metadata, relatedOutputsForPage(preview, outputPages))
    );
    compiledPages.push(sourcePage.page);
    await writePage(paths.wikiDir, sourcePage.page.path, sourcePage.content, changedPages);
  }

  for (const aggregate of aggregateItems(analyses, "concepts")) {
    const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
    const preview = emptyGraphPage({
      id: `concept:${slugify(aggregate.name)}`,
      path: `concepts/${slugify(aggregate.name)}.md`,
      title: aggregate.name,
      kind: "concept",
      sourceIds: aggregate.sourceAnalyses.map((item) => item.sourceId),
      nodeIds: [`concept:${slugify(aggregate.name)}`],
      schemaHash: schema.hash,
      sourceHashes: aggregate.sourceHashes,
      confidence
    });
    const absolutePath = path.join(paths.wikiDir, preview.path);
    const page = await buildManagedGraphPage(
      absolutePath,
      {
        managedBy: "system",
        confidence,
        compiledFrom: uniqueStrings(aggregate.sourceAnalyses.map((item) => item.sourceId))
      },
      (metadata) =>
        buildAggregatePage(
          "concept",
          aggregate.name,
          aggregate.descriptions,
          aggregate.sourceAnalyses,
          aggregate.sourceHashes,
          schema.hash,
          metadata,
          relatedOutputsForPage(preview, outputPages)
        )
    );
    compiledPages.push(page.page);
    await writePage(paths.wikiDir, page.page.path, page.content, changedPages);
  }

  for (const aggregate of aggregateItems(analyses, "entities")) {
    const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
    const preview = emptyGraphPage({
      id: `entity:${slugify(aggregate.name)}`,
      path: `entities/${slugify(aggregate.name)}.md`,
      title: aggregate.name,
      kind: "entity",
      sourceIds: aggregate.sourceAnalyses.map((item) => item.sourceId),
      nodeIds: [`entity:${slugify(aggregate.name)}`],
      schemaHash: schema.hash,
      sourceHashes: aggregate.sourceHashes,
      confidence
    });
    const absolutePath = path.join(paths.wikiDir, preview.path);
    const page = await buildManagedGraphPage(
      absolutePath,
      {
        managedBy: "system",
        confidence,
        compiledFrom: uniqueStrings(aggregate.sourceAnalyses.map((item) => item.sourceId))
      },
      (metadata) =>
        buildAggregatePage(
          "entity",
          aggregate.name,
          aggregate.descriptions,
          aggregate.sourceAnalyses,
          aggregate.sourceHashes,
          schema.hash,
          metadata,
          relatedOutputsForPage(preview, outputPages)
        )
    );
    compiledPages.push(page.page);
    await writePage(paths.wikiDir, page.page.path, page.content, changedPages);
  }

  const allPages = [...compiledPages, ...outputPages, ...insightPages];
  const graph = buildGraph(manifests, analyses, allPages);
  await writeJsonFile(paths.graphPath, graph);
  await writeJsonFile(paths.compileStatePath, {
    generatedAt: graph.generatedAt,
    schemaHash: schema.hash,
    analyses: Object.fromEntries(analyses.map((analysis) => [analysis.sourceId, analysisSignature(analysis)])),
    sourceHashes: Object.fromEntries(manifests.map((manifest) => [manifest.sourceId, manifest.contentHash])),
    outputHashes: currentOutputHashes,
    insightHashes: currentInsightHashes
  } satisfies CompileState);

  const rootIndexPath = path.join(paths.wikiDir, "index.md");
  await writePage(
    paths.wikiDir,
    "index.md",
    await buildManagedContent(
      rootIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages)
      },
      (metadata) => buildIndexPage(allPages, schema.hash, metadata)
    ),
    changedPages
  );
  await writePage(
    paths.wikiDir,
    "sources/index.md",
    await buildManagedContent(
      path.join(paths.wikiDir, "sources", "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages.filter((page) => page.kind === "source"))
      },
      (metadata) =>
        buildSectionIndex(
          "sources",
          allPages.filter((page) => page.kind === "source"),
          schema.hash,
          metadata
        )
    ),
    changedPages
  );
  await writePage(
    paths.wikiDir,
    "concepts/index.md",
    await buildManagedContent(
      path.join(paths.wikiDir, "concepts", "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages.filter((page) => page.kind === "concept"))
      },
      (metadata) =>
        buildSectionIndex(
          "concepts",
          allPages.filter((page) => page.kind === "concept"),
          schema.hash,
          metadata
        )
    ),
    changedPages
  );
  await writePage(
    paths.wikiDir,
    "entities/index.md",
    await buildManagedContent(
      path.join(paths.wikiDir, "entities", "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages.filter((page) => page.kind === "entity"))
      },
      (metadata) =>
        buildSectionIndex(
          "entities",
          allPages.filter((page) => page.kind === "entity"),
          schema.hash,
          metadata
        )
    ),
    changedPages
  );
  await writePage(
    paths.wikiDir,
    "outputs/index.md",
    await buildManagedContent(
      path.join(paths.wikiDir, "outputs", "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages.filter((page) => page.kind === "output"))
      },
      (metadata) =>
        buildSectionIndex(
          "outputs",
          allPages.filter((page) => page.kind === "output"),
          schema.hash,
          metadata
        )
    ),
    changedPages
  );

  if (changedPages.length > 0 || outputsChanged || insightsChanged || !artifactsExist) {
    await rebuildSearchIndex(paths.searchDbPath, allPages, paths.wikiDir);
  }

  await recordSession(rootDir, {
    operation: "compile",
    title: `Compiled ${manifests.length} source(s)`,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: manifests.map((manifest) => manifest.sourceId),
    relatedPageIds: allPages.map((page) => page.id),
    changedPages,
    lines: [
      `provider=${provider.id}`,
      `pages=${allPages.length}`,
      `dirty=${dirty.length}`,
      `clean=${clean.length}`,
      `outputs=${outputPages.length}`,
      `insights=${insightPages.length}`,
      `schema=${schema.hash.slice(0, 12)}`
    ]
  });

  return {
    graphPath: paths.graphPath,
    pageCount: allPages.length,
    changedPages,
    sourceCount: manifests.length
  };
}

export async function queryVault(rootDir: string, question: string, save = false): Promise<QueryResult> {
  const startedAt = new Date().toISOString();
  const schema = await loadVaultSchema(rootDir);
  const query = await executeQuery(rootDir, question);
  let savedTo: string | undefined;
  let savedPageId: string | undefined;

  if (save) {
    const saved = await persistOutputPage(rootDir, {
      question,
      answer: query.answer,
      citations: query.citations,
      schemaHash: schema.hash,
      relatedPageIds: query.relatedPageIds,
      relatedNodeIds: query.relatedNodeIds,
      relatedSourceIds: query.relatedSourceIds,
      origin: "query"
    });
    savedTo = saved.savedTo;
    savedPageId = saved.page.id;
  }

  const provider = await getProviderForTask(rootDir, "queryProvider");
  await recordSession(rootDir, {
    operation: "query",
    title: question,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: query.relatedSourceIds,
    relatedPageIds: savedPageId ? [...query.relatedPageIds, savedPageId] : query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    citations: query.citations,
    tokenUsage: query.usage,
    lines: [`citations=${query.citations.join(",") || "none"}`, `saved=${Boolean(savedTo)}`, `rawSources=${query.relatedSourceIds.length}`]
  });

  return {
    answer: query.answer,
    savedTo,
    savedPageId,
    citations: query.citations,
    relatedPageIds: query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    relatedSourceIds: query.relatedSourceIds
  };
}

export async function exploreVault(rootDir: string, question: string, steps = 3): Promise<ExploreResult> {
  const startedAt = new Date().toISOString();
  const schema = await loadVaultSchema(rootDir);
  const stepResults: ExploreStepResult[] = [];
  const stepPages: GraphPage[] = [];
  const visited = new Set<string>();
  const suggestedQuestions: string[] = [];
  const relatedPageIds = new Set<string>();
  const relatedNodeIds = new Set<string>();
  const relatedSourceIds = new Set<string>();
  const tokenUsage = {
    inputTokens: 0,
    outputTokens: 0
  };
  let currentQuestion = question;

  for (let step = 1; step <= Math.max(1, steps); step++) {
    const normalizedQuestion = normalizeWhitespace(currentQuestion).toLowerCase();
    if (!normalizedQuestion || visited.has(normalizedQuestion)) {
      break;
    }

    visited.add(normalizedQuestion);
    const query = await executeQuery(rootDir, currentQuestion);
    query.relatedPageIds.forEach((pageId) => {
      relatedPageIds.add(pageId);
    });
    query.relatedNodeIds.forEach((nodeId) => {
      relatedNodeIds.add(nodeId);
    });
    query.relatedSourceIds.forEach((sourceId) => {
      relatedSourceIds.add(sourceId);
    });
    tokenUsage.inputTokens += query.usage?.inputTokens ?? 0;
    tokenUsage.outputTokens += query.usage?.outputTokens ?? 0;
    const saved = await persistOutputPage(rootDir, {
      title: `Explore Step ${step}: ${currentQuestion}`,
      question: currentQuestion,
      answer: query.answer,
      citations: query.citations,
      schemaHash: schema.hash,
      relatedPageIds: query.relatedPageIds,
      relatedNodeIds: query.relatedNodeIds,
      relatedSourceIds: query.relatedSourceIds,
      origin: "explore",
      slug: `explore-${slugify(question)}-step-${step}`
    });

    const followUpQuestions = await generateFollowUpQuestions(rootDir, currentQuestion, query.answer);
    stepResults.push({
      step,
      question: currentQuestion,
      answer: query.answer,
      savedTo: saved.savedTo,
      savedPageId: saved.page.id,
      citations: query.citations,
      followUpQuestions
    });
    stepPages.push(saved.page);
    suggestedQuestions.push(...followUpQuestions);

    const nextQuestion = followUpQuestions.find((item) => !visited.has(normalizeWhitespace(item).toLowerCase()));
    if (!nextQuestion) {
      break;
    }
    currentQuestion = nextQuestion;
  }

  const allCitations = uniqueBy(
    stepResults.flatMap((step) => step.citations),
    (item) => item
  );
  const hub = await persistExploreHub(rootDir, {
    question,
    stepPages,
    followUpQuestions: uniqueBy(suggestedQuestions, (item) => item),
    citations: allCitations,
    schemaHash: schema.hash,
    slug: `explore-${slugify(question)}`
  });

  const provider = await getProviderForTask(rootDir, "queryProvider");
  await recordSession(rootDir, {
    operation: "explore",
    title: question,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: [...relatedSourceIds],
    relatedPageIds: uniqueStrings([...relatedPageIds, ...stepPages.map((page) => page.id), hub.page.id]),
    relatedNodeIds: [...relatedNodeIds],
    citations: allCitations,
    tokenUsage:
      tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0
        ? {
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens
          }
        : undefined,
    lines: [`steps=${stepResults.length}`, `hub=${hub.page.id}`, `citations=${allCitations.join(",") || "none"}`]
  });

  return {
    rootQuestion: question,
    hubPath: hub.savedTo,
    hubPageId: hub.page.id,
    stepCount: stepResults.length,
    steps: stepResults,
    suggestedQuestions: uniqueBy(suggestedQuestions, (item) => item)
  };
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

function structuralLintFindings(
  _rootDir: string,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  graph: GraphArtifact,
  schemaHash: string,
  manifests: SourceManifest[]
): Promise<LintFinding[]> {
  const manifestMap = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  return Promise.all(
    graph.pages.map(async (page) => {
      const findings: LintFinding[] = [];

      if (page.kind === "insight") {
        return findings;
      }

      if (page.schemaHash !== schemaHash) {
        findings.push({
          severity: "warning",
          code: "stale_page",
          message: `Page ${page.title} is stale because the vault schema changed.`,
          pagePath: path.join(paths.wikiDir, page.path),
          relatedPageIds: [page.id]
        });
      }

      for (const [sourceId, knownHash] of Object.entries(page.sourceHashes)) {
        const manifest = manifestMap.get(sourceId);
        if (manifest && manifest.contentHash !== knownHash) {
          findings.push({
            severity: "warning",
            code: "stale_page",
            message: `Page ${page.title} is stale because source ${sourceId} changed.`,
            pagePath: path.join(paths.wikiDir, page.path),
            relatedSourceIds: [sourceId],
            relatedPageIds: [page.id]
          });
        }
      }

      if (page.kind !== "index" && page.backlinks.length === 0) {
        findings.push({
          severity: "info",
          code: "orphan_page",
          message: `Page ${page.title} has no backlinks.`,
          pagePath: path.join(paths.wikiDir, page.path),
          relatedPageIds: [page.id]
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
              pagePath: absolutePath,
              relatedPageIds: [page.id]
            });
          }
        }
      }

      return findings;
    })
  ).then((results) => results.flat());
}

export async function lintVault(rootDir: string, options: LintOptions = {}): Promise<LintFinding[]> {
  const startedAt = new Date().toISOString();
  if (options.web && !options.deep) {
    throw new Error("`--web` can only be used together with `--deep`.");
  }

  const { paths } = await loadVaultConfig(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const manifests = await listManifests(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);

  if (!graph) {
    const findings: LintFinding[] = [
      {
        severity: "warning",
        code: "graph_missing",
        message: "No graph artifact found. Run `swarmvault compile` first."
      }
    ];
    await recordSession(rootDir, {
      operation: "lint",
      title: "Linted 0 page(s)",
      startedAt,
      finishedAt: new Date().toISOString(),
      success: true,
      lintFindingCount: findings.length,
      lines: [`findings=${findings.length}`, `deep=${Boolean(options.deep)}`, `web=${Boolean(options.web)}`]
    });
    return findings;
  }

  const findings = await structuralLintFindings(rootDir, paths, graph, schema.hash, manifests);
  if (options.deep) {
    findings.push(...(await runDeepLint(rootDir, findings, { web: options.web })));
  }

  const provider = options.deep ? await getProviderForTask(rootDir, "lintProvider") : undefined;
  await recordSession(rootDir, {
    operation: "lint",
    title: `Linted ${graph.pages.length} page(s)`,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider?.id,
    success: true,
    relatedPageIds: graph.pages.map((page) => page.id),
    relatedSourceIds: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
    lintFindingCount: findings.length,
    lines: [`findings=${findings.length}`, `deep=${Boolean(options.deep)}`, `web=${Boolean(options.web)}`]
  });

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
