import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { installConfiguredAgents } from "./agents.js";
import { analysisSignature, analyzeSource } from "./analysis.js";
import { benchmarkQueryTokens, buildBenchmarkArtifact, DEFAULT_BENCHMARK_QUESTIONS, estimateCorpusWords } from "./benchmark.js";
import { buildCodeIndex, enrichResolvedCodeImports, modulePageTitle } from "./code-analysis.js";
import { conflictConfidence, edgeConfidence, nodeConfidence } from "./confidence.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { runDeepLint } from "./deep-lint.js";
import { explainGraphTarget, queryGraph, shortestGraphPath, topGodNodes } from "./graph-tools.js";
import { ingestInput, listManifests, readExtractedText } from "./ingest.js";
import { recordSession } from "./logs.js";
import {
  buildAggregatePage,
  buildCommunitySummaryPage,
  buildExploreHubPage,
  buildGraphReportPage,
  buildIndexPage,
  buildModulePage,
  buildOutputPage,
  buildProjectIndex,
  buildProjectsIndex,
  buildSectionIndex,
  buildSourcePage,
  candidatePagePathFor,
  type ManagedGraphPageMetadata,
  type ManagedPageMetadata
} from "./markdown.js";
import { runConfiguredRoles, summarizeRoleQuestions } from "./orchestration.js";
import {
  buildOutputAssetManifest,
  chartSpecSchema,
  renderChartSvg,
  renderRasterPosterSvg,
  renderSceneSvg,
  sceneSpecSchema
} from "./output-artifacts.js";
import { loadSavedOutputPages, relatedOutputsForPage, resolveUniqueOutputSlug } from "./outputs.js";
import { loadExistingManagedPageState, loadInsightPages, parseStoredPage } from "./pages.js";
import { getProviderForTask } from "./providers/registry.js";
import {
  buildSchemaPrompt,
  composeVaultSchema,
  getEffectiveSchema,
  type LoadedVaultSchemas,
  loadVaultSchemas,
  schemaCategoryLabels
} from "./schema.js";
import { rebuildSearchIndex, searchPages } from "./search.js";
import type {
  ApprovalDetail,
  ApprovalEntry,
  ApprovalManifest,
  ApprovalSummary,
  BenchmarkArtifact,
  BenchmarkOptions,
  CandidateRecord,
  CodeIndexArtifact,
  CompileOptions,
  CompileResult,
  CompileState,
  ExploreOptions,
  ExploreResult,
  ExploreStepResult,
  GraphArtifact,
  GraphEdge,
  GraphExplainResult,
  GraphNode,
  GraphPage,
  GraphPathResult,
  GraphQueryResult,
  InitOptions,
  LintFinding,
  LintOptions,
  OutputAsset,
  OutputFormat,
  PageManager,
  PageStatus,
  QueryOptions,
  QueryResult,
  ReviewActionResult,
  SearchResult,
  SourceAnalysis,
  SourceManifest,
  VaultConfig
} from "./types.js";
import {
  ensureDir,
  fileExists,
  listFilesRecursive,
  normalizeWhitespace,
  readJsonFile,
  sha256,
  slugify,
  toPosix,
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
  schemaHash: string;
  projectIds: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

type PersistedOutputPageResult = {
  page: GraphPage;
  savedPath: string;
  outputAssets: OutputAsset[];
};

type GeneratedOutputArtifacts = {
  answer: string;
  outputAssets: OutputAsset[];
  assetFiles: Array<{
    relativePath: string;
    content: string | Uint8Array;
    encoding?: BufferEncoding;
  }>;
};

type ProjectEntry = {
  id: string;
  roots: string[];
  schemaPath?: string;
};

type CandidateHistoryEntry = NonNullable<CompileState["candidateHistory"][string]>;
type ManagedPageRecord = {
  page: GraphPage;
  content: string;
};

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function normalizeOutputFormat(format: OutputFormat | undefined): OutputFormat {
  return format === "report" || format === "slides" || format === "chart" || format === "image" ? format : "markdown";
}

function outputFormatInstruction(format: OutputFormat): string {
  switch (format) {
    case "report":
      return "Return a concise markdown report with a title, a brief summary, key findings, and cited evidence.";
    case "slides":
      return "Return Marp-compatible markdown slide content with short slide titles, `---` separators, and cited evidence. Do not include YAML frontmatter.";
    case "chart":
      return "Return concise markdown that explains the key visual takeaway for a chart and cites the supporting source IDs.";
    case "image":
      return "Return concise markdown that explains the key visual takeaway for an illustrative image and cites the supporting source IDs.";
    default:
      return "Return concise markdown grounded in the provided context with cited evidence.";
  }
}

function outputAssetPath(slug: string, fileName: string): string {
  return toPosix(path.join("outputs", "assets", slug, fileName));
}

function outputAssetId(slug: string, role: OutputAsset["role"]): string {
  return `output:${slug}:asset:${role}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "application/json":
      return "json";
    default:
      return "bin";
  }
}

function defaultChartSpec(question: string, answer: string, citations: string[], relatedPageCount: number, relatedNodeCount: number) {
  return {
    kind: "bar" as const,
    title: question,
    subtitle: truncate(normalizeWhitespace(answer), 120),
    xLabel: "Metric",
    yLabel: "Count",
    seriesLabel: "Vault context",
    data: [
      { label: "Citations", value: citations.length },
      { label: "Pages", value: relatedPageCount },
      { label: "Nodes", value: relatedNodeCount }
    ],
    notes: citations.length ? [`Sources: ${citations.join(", ")}`] : ["No citations recorded."]
  };
}

function defaultSceneSpec(question: string, answer: string, citations: string[]): z.infer<typeof sceneSpecSchema> {
  const summary = truncate(normalizeWhitespace(answer), 140);
  const citationLine = citations.length ? `Sources: ${citations.join(", ")}` : "No citations recorded.";
  return {
    title: question,
    alt: `${question}. ${summary}`,
    background: "#f8fafc",
    width: 1200,
    height: 720,
    elements: [
      {
        kind: "shape",
        shape: "rect",
        x: 48,
        y: 112,
        width: 1104,
        height: 220,
        fill: "#dbeafe",
        stroke: "#0ea5e9",
        strokeWidth: 3
      },
      {
        kind: "label",
        x: 78,
        y: 170,
        text: "Vault Summary",
        fontSize: 30,
        fill: "#0f172a"
      },
      {
        kind: "label",
        x: 78,
        y: 218,
        text: summary,
        fontSize: 22,
        fill: "#1e293b"
      },
      {
        kind: "shape",
        shape: "rect",
        x: 48,
        y: 372,
        width: 520,
        height: 210,
        fill: "#ecfccb",
        stroke: "#65a30d",
        strokeWidth: 3
      },
      {
        kind: "label",
        x: 78,
        y: 430,
        text: `Citations: ${citations.length}`,
        fontSize: 28,
        fill: "#14532d"
      },
      {
        kind: "label",
        x: 78,
        y: 476,
        text: citationLine,
        fontSize: 20,
        fill: "#166534"
      },
      {
        kind: "shape",
        shape: "circle",
        x: 864,
        y: 478,
        radius: 116,
        fill: "#fee2e2",
        stroke: "#ef4444",
        strokeWidth: 4
      },
      {
        kind: "label",
        x: 792,
        y: 470,
        text: "Image",
        fontSize: 34,
        fill: "#7f1d1d"
      },
      {
        kind: "label",
        x: 754,
        y: 512,
        text: "Fallback",
        fontSize: 26,
        fill: "#991b1b"
      }
    ]
  };
}

async function resolveImageGenerationProvider(rootDir: string) {
  const { config } = await loadVaultConfig(rootDir);
  const preferredProviderId = config.tasks.imageProvider;
  if (!preferredProviderId) {
    return getProviderForTask(rootDir, "queryProvider");
  }
  const providerConfig = config.providers[preferredProviderId];
  if (!providerConfig) {
    throw new Error(`No provider configured with id "${preferredProviderId}" for task "imageProvider".`);
  }
  const { createProvider } = await import("./providers/registry.js");
  return createProvider(preferredProviderId, providerConfig, rootDir);
}

async function generateOutputArtifacts(
  rootDir: string,
  input: {
    slug: string;
    title: string;
    question: string;
    answer: string;
    citations: string[];
    format: OutputFormat;
    relatedPageCount: number;
    relatedNodeCount: number;
    projectId?: string | null;
  }
): Promise<GeneratedOutputArtifacts> {
  if (input.format !== "chart" && input.format !== "image") {
    return {
      answer: input.answer,
      outputAssets: [],
      assetFiles: []
    };
  }

  const schemas = await loadVaultSchemas(rootDir);
  const schema = getEffectiveSchema(schemas, input.projectId ?? null);

  if (input.format === "chart") {
    const provider = await getProviderForTask(rootDir, "queryProvider");
    const chartSpec =
      provider.type === "heuristic"
        ? defaultChartSpec(input.question, input.answer, input.citations, input.relatedPageCount, input.relatedNodeCount)
        : await provider.generateStructured(
            {
              system: buildSchemaPrompt(
                schema,
                "Create a grounded chart spec. Use only the supplied answer and citations. Prefer simple bar or line charts with 2-12 points."
              ),
              prompt: [
                `Question: ${input.question}`,
                "",
                "Answer:",
                input.answer,
                "",
                `Citations: ${input.citations.join(", ") || "none"}`,
                `Related pages: ${input.relatedPageCount}`,
                `Related nodes: ${input.relatedNodeCount}`
              ].join("\n")
            },
            chartSpecSchema
          );
    const rendered = renderChartSvg(chartSpec);
    const primaryAsset: OutputAsset = {
      id: outputAssetId(input.slug, "primary"),
      role: "primary",
      path: outputAssetPath(input.slug, "primary.svg"),
      mimeType: "image/svg+xml",
      width: rendered.width,
      height: rendered.height
    };
    const manifestAsset: OutputAsset = {
      id: outputAssetId(input.slug, "manifest"),
      role: "manifest",
      path: outputAssetPath(input.slug, "manifest.json"),
      mimeType: "application/json"
    };
    const outputAssets = [primaryAsset, manifestAsset];
    return {
      answer: input.answer,
      outputAssets,
      assetFiles: [
        { relativePath: primaryAsset.path, content: rendered.svg, encoding: "utf8" },
        {
          relativePath: manifestAsset.path,
          content: buildOutputAssetManifest({
            slug: input.slug,
            format: input.format,
            question: input.question,
            title: input.title,
            citations: input.citations,
            answer: input.answer,
            assets: outputAssets,
            spec: chartSpec
          }),
          encoding: "utf8"
        }
      ]
    };
  }

  const imageProvider = await resolveImageGenerationProvider(rootDir);
  const nativePrompt = [
    `Create a single grounded illustration for: ${input.question}`,
    "",
    "Use only the supplied vault context.",
    input.answer,
    "",
    `Citations: ${input.citations.join(", ") || "none"}`
  ].join("\n");

  if (imageProvider.capabilities.has("image_generation") && typeof imageProvider.generateImage === "function") {
    try {
      const image = await imageProvider.generateImage({
        prompt: nativePrompt,
        system: buildSchemaPrompt(schema, "Create one grounded image prompt. Avoid text-heavy diagrams."),
        width: 1200,
        height: 720
      });
      const extension = extensionForMimeType(image.mimeType);
      const primaryAsset: OutputAsset = {
        id: outputAssetId(input.slug, "primary"),
        role: "primary",
        path: outputAssetPath(input.slug, `primary.${extension}`),
        mimeType: image.mimeType,
        width: image.width,
        height: image.height
      };
      const poster = renderRasterPosterSvg({
        title: input.title,
        alt: image.revisedPrompt ?? input.answer,
        rasterFileName: `primary.${extension}`,
        width: image.width,
        height: image.height
      });
      const posterAsset: OutputAsset = {
        id: outputAssetId(input.slug, "poster"),
        role: "poster",
        path: outputAssetPath(input.slug, "poster.svg"),
        mimeType: "image/svg+xml",
        width: poster.width,
        height: poster.height
      };
      const manifestAsset: OutputAsset = {
        id: outputAssetId(input.slug, "manifest"),
        role: "manifest",
        path: outputAssetPath(input.slug, "manifest.json"),
        mimeType: "application/json"
      };
      const outputAssets = [primaryAsset, posterAsset, manifestAsset];
      return {
        answer: input.answer,
        outputAssets,
        assetFiles: [
          { relativePath: primaryAsset.path, content: image.bytes },
          { relativePath: posterAsset.path, content: poster.svg, encoding: "utf8" },
          {
            relativePath: manifestAsset.path,
            content: buildOutputAssetManifest({
              slug: input.slug,
              format: input.format,
              question: input.question,
              title: input.title,
              citations: input.citations,
              answer: input.answer,
              assets: outputAssets,
              spec: {
                mode: "native",
                prompt: nativePrompt,
                revisedPrompt: image.revisedPrompt
              }
            }),
            encoding: "utf8"
          }
        ]
      };
    } catch {
      // Fall back to deterministic SVG scene generation below.
    }
  }

  const sceneSpec =
    imageProvider.type === "heuristic"
      ? defaultSceneSpec(input.question, input.answer, input.citations)
      : await imageProvider.generateStructured(
          {
            system: buildSchemaPrompt(
              schema,
              "Create a grounded SVG scene spec with shapes and short labels only. Avoid inventing unsupported details."
            ),
            prompt: nativePrompt
          },
          sceneSpecSchema
        );
  const renderedScene = renderSceneSvg(sceneSpec);
  const primaryAsset: OutputAsset = {
    id: outputAssetId(input.slug, "primary"),
    role: "primary",
    path: outputAssetPath(input.slug, "primary.svg"),
    mimeType: "image/svg+xml",
    width: renderedScene.width,
    height: renderedScene.height
  };
  const manifestAsset: OutputAsset = {
    id: outputAssetId(input.slug, "manifest"),
    role: "manifest",
    path: outputAssetPath(input.slug, "manifest.json"),
    mimeType: "application/json"
  };
  const outputAssets = [primaryAsset, manifestAsset];
  return {
    answer: input.answer,
    outputAssets,
    assetFiles: [
      { relativePath: primaryAsset.path, content: renderedScene.svg, encoding: "utf8" },
      {
        relativePath: manifestAsset.path,
        content: buildOutputAssetManifest({
          slug: input.slug,
          format: input.format,
          question: input.question,
          title: input.title,
          citations: input.citations,
          answer: input.answer,
          assets: outputAssets,
          spec: sceneSpec
        }),
        encoding: "utf8"
      }
    ]
  };
}

function normalizeProjectRoot(root: string): string {
  const normalized = toPosix(path.posix.normalize(root.replace(/\\/g, "/")))
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return normalized;
}

function projectEntries(config: VaultConfig): ProjectEntry[] {
  return Object.entries(config.projects ?? {})
    .map(([id, project]) => ({
      id,
      roots: uniqueStrings(project.roots.map(normalizeProjectRoot)).filter(Boolean),
      schemaPath: project.schemaPath
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function projectConfigHash(config: VaultConfig): string {
  return sha256(
    JSON.stringify(
      projectEntries(config).map((project) => ({
        id: project.id,
        roots: project.roots,
        schemaPath: project.schemaPath ?? null
      }))
    )
  );
}

function manifestPathForProject(rootDir: string, manifest: SourceManifest): string {
  const rawPath = manifest.originalPath ?? manifest.storedPath;
  if (!rawPath) {
    return toPosix(manifest.storedPath);
  }
  if (!path.isAbsolute(rawPath)) {
    return normalizeProjectRoot(rawPath);
  }
  const relative = toPosix(path.relative(rootDir, rawPath));
  return relative.startsWith("..") ? toPosix(rawPath) : normalizeProjectRoot(relative);
}

function prefixMatches(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function resolveSourceProjectId(rootDir: string, manifest: SourceManifest, config: VaultConfig): string | null {
  const comparablePath = manifestPathForProject(rootDir, manifest);
  let best: { id: string; length: number } | null = null;
  for (const project of projectEntries(config)) {
    for (const root of project.roots) {
      if (!root || !prefixMatches(comparablePath, root)) {
        continue;
      }
      if (!best || root.length > best.length || (root.length === best.length && project.id.localeCompare(best.id) < 0)) {
        best = { id: project.id, length: root.length };
      }
    }
  }
  return best?.id ?? null;
}

function resolveSourceProjects(rootDir: string, manifests: SourceManifest[], config: VaultConfig): Record<string, string | null> {
  return Object.fromEntries(manifests.map((manifest) => [manifest.sourceId, resolveSourceProjectId(rootDir, manifest, config)]));
}

function scopedProjectIdsFromSources(sourceIds: string[], sourceProjects: Record<string, string | null>): string[] {
  const projectIds = uniqueStrings(sourceIds.map((sourceId) => sourceProjects[sourceId] ?? "").filter(Boolean));
  return projectIds.length === 1 ? projectIds : [];
}

function schemaProjectIdsFromPages(pageIds: string[], pageMap: Map<string, GraphPage>): string[] {
  return uniqueStrings(
    pageIds
      .flatMap((pageId) => pageMap.get(pageId)?.projectIds ?? [])
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  );
}

function categoryTagsForSchema(schema: { content: string }, texts: string[]): string[] {
  const haystack = normalizeWhitespace(texts.filter(Boolean).join(" ")).toLowerCase();
  if (!haystack) {
    return [];
  }
  return uniqueStrings(
    schemaCategoryLabels({ path: "", hash: "", content: schema.content })
      .filter((label) => haystack.includes(label.toLowerCase()))
      .map((label) => `category/${slugify(label)}`)
  ).slice(0, 3);
}

function effectiveHashForProject(schemas: LoadedVaultSchemas, projectId: string | null): string {
  return getEffectiveSchema(schemas, projectId).hash;
}

function previousGlobalSchemaHash(previousState: CompileState | null | undefined): string {
  return (
    previousState?.effectiveSchemaHashes?.global ??
    (previousState as { schemaHash?: string } | null)?.schemaHash ??
    previousState?.rootSchemaHash ??
    ""
  );
}

function previousProjectSchemaHash(previousState: CompileState | null | undefined, projectId: string | null): string {
  if (!projectId) {
    return previousGlobalSchemaHash(previousState);
  }
  return (
    previousState?.effectiveSchemaHashes?.projects?.[projectId] ??
    previousState?.projectSchemaHashes?.[projectId] ??
    previousGlobalSchemaHash(previousState)
  );
}

function expectedSchemaHashForPage(
  page: GraphPage,
  schemas: LoadedVaultSchemas,
  pageMap: Map<string, GraphPage>,
  sourceProjects: Record<string, string | null>
): string {
  if (page.kind === "source" || page.kind === "module" || page.kind === "concept" || page.kind === "entity") {
    return effectiveHashForProject(schemas, scopedProjectIdsFromSources(page.sourceIds, sourceProjects)[0] ?? null);
  }
  if (page.kind === "output") {
    const projectIds = schemaProjectIdsFromPages(page.relatedPageIds, pageMap);
    if (projectIds.length) {
      return composeVaultSchema(
        schemas.root,
        projectIds
          .map((projectId) => schemas.projects[projectId])
          .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema?.hash))
      ).hash;
    }
    return effectiveHashForProject(
      schemas,
      scopedProjectIdsFromSources(page.relatedSourceIds.length ? page.relatedSourceIds : page.sourceIds, sourceProjects)[0] ?? null
    );
  }
  if (page.path === "projects/index.md" || page.kind === "insight") {
    return schemas.effective.global.hash;
  }
  if (page.path.startsWith("projects/") && page.path.endsWith("/index.md")) {
    const projectId = page.projectIds[0] ?? page.path.split("/")[1] ?? null;
    return effectiveHashForProject(schemas, projectId);
  }
  return schemas.effective.global.hash;
}

function formatHeuristicAnswer(
  question: string,
  excerpts: string[],
  rawExcerpts: string[],
  searchResults: SearchResult[],
  format: OutputFormat
): string {
  switch (format) {
    case "report":
      return [
        `# Report: ${question}`,
        "",
        "## Summary",
        "",
        searchResults.length
          ? `The vault surfaces ${searchResults.length} relevant page(s) for this question.`
          : "No relevant pages found yet.",
        "",
        "## Relevant Pages",
        "",
        ...(searchResults.length ? searchResults.map((result) => `- ${result.title} (${result.path})`) : ["- None found."]),
        "",
        "## Evidence",
        "",
        ...(excerpts.length ? excerpts : ["No wiki evidence available yet."]),
        ...(rawExcerpts.length ? ["", "## Raw Sources", "", ...rawExcerpts] : []),
        ""
      ].join("\n");
    case "slides":
      return [
        `# ${question}`,
        "",
        searchResults.length ? `- ${searchResults.length} relevant page(s) found` : "- No relevant pages found yet",
        "---",
        "",
        "# Key Pages",
        "",
        ...(searchResults.length ? searchResults.map((result) => `- ${result.title}`) : ["- None found."]),
        ...(rawExcerpts.length
          ? [
              "---",
              "",
              "# Raw Sources",
              "",
              ...rawExcerpts.map((excerpt) => `- ${truncate(normalizeWhitespace(excerpt.replace(/^#.*\n/, "")), 140)}`)
            ]
          : []),
        ""
      ].join("\n");
    default:
      return [
        `Question: ${question}`,
        "",
        "Relevant pages:",
        ...searchResults.map((result) => `- ${result.title} (${result.path})`),
        "",
        excerpts.length ? excerpts.join("\n\n") : "No relevant pages found yet.",
        ...(rawExcerpts.length ? ["", "Raw source material:", "", ...rawExcerpts] : [])
      ].join("\n");
  }
}

function jaccardSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 1;
  }
  const intersection = [...leftSet].filter((item) => rightSet.has(item));
  return intersection.length / union.size;
}

function shouldPromoteCandidate(previous: CandidateHistoryEntry | undefined, sourceIds: string[]): boolean {
  return Boolean(previous && previous.status === "candidate" && jaccardSimilarity(previous.sourceIds, sourceIds) >= 0.5);
}

function activeAggregatePath(kind: "concept" | "entity", slug: string): string {
  return kind === "entity" ? `entities/${slug}.md` : `concepts/${slug}.md`;
}

function approvalSummary(manifest: ApprovalManifest): ApprovalSummary {
  return {
    approvalId: manifest.approvalId,
    createdAt: manifest.createdAt,
    entryCount: manifest.entries.length,
    pendingCount: manifest.entries.filter((entry) => entry.status === "pending").length,
    acceptedCount: manifest.entries.filter((entry) => entry.status === "accepted").length,
    rejectedCount: manifest.entries.filter((entry) => entry.status === "rejected").length
  };
}

function pageSlug(page: Pick<GraphPage, "id">): string {
  return page.id.includes(":") ? page.id.slice(page.id.indexOf(":") + 1) : slugify(page.id);
}

function candidateActivePath(page: Pick<GraphPage, "kind" | "id">): string {
  if (page.kind !== "concept" && page.kind !== "entity") {
    throw new Error(`Only concept and entity candidates can be promoted: ${page.id}`);
  }
  return activeAggregatePath(page.kind, pageSlug(page));
}

function buildCommunityId(seed: string, index: number): string {
  const slug = slugify(seed) || "cluster";
  return `community:${slug}-${index + 1}`;
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
    statePathCandidates?: string[];
  },
  build: (metadata: ManagedGraphPageMetadata) => { page: GraphPage; content: string }
): Promise<{ page: GraphPage; content: string }> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  let existing = await loadExistingManagedPageState(absolutePath, {
    status: defaults.status ?? "active",
    managedBy: defaults.managedBy
  });
  let usedFallbackState = false;
  if (!existingContent && defaults.statePathCandidates?.length) {
    for (const candidatePath of defaults.statePathCandidates) {
      if (candidatePath === absolutePath || !(await fileExists(candidatePath))) {
        continue;
      }
      existing = await loadExistingManagedPageState(candidatePath, {
        status: defaults.status ?? "active",
        managedBy: defaults.managedBy
      });
      usedFallbackState = true;
      break;
    }
  }

  let metadata: ManagedGraphPageMetadata = {
    status: usedFallbackState && defaults.status ? defaults.status : existing.status,
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
    statePathCandidates?: string[];
  },
  build: (metadata: ManagedPageMetadata) => string
): Promise<string> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  let existing = await loadExistingManagedPageState(absolutePath, {
    status: defaults.status ?? "active",
    managedBy: defaults.managedBy
  });
  let usedFallbackState = false;
  if (!existingContent && defaults.statePathCandidates?.length) {
    for (const candidatePath of defaults.statePathCandidates) {
      if (candidatePath === absolutePath || !(await fileExists(candidatePath))) {
        continue;
      }
      existing = await loadExistingManagedPageState(candidatePath, {
        status: defaults.status ?? "active",
        managedBy: defaults.managedBy
      });
      usedFallbackState = true;
      break;
    }
  }

  let metadata: ManagedPageMetadata = {
    status: usedFallbackState && defaults.status ? defaults.status : existing.status,
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

function deriveGraphMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[]
): {
  nodes: GraphNode[];
  communities: GraphArtifact["communities"];
} {
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!adjacency.has(left)) {
      adjacency.set(left, new Set());
    }
    adjacency.get(left)?.add(right);
  };

  for (const edge of edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const nonSourceNodes = nodes.filter((node) => node.type !== "source");
  for (let index = 0; index < nonSourceNodes.length; index++) {
    const left = nonSourceNodes[index];
    for (let cursor = index + 1; cursor < nonSourceNodes.length; cursor++) {
      const right = nonSourceNodes[cursor];
      if (left.sourceIds.some((sourceId) => right.sourceIds.includes(sourceId))) {
        connect(left.id, right.id);
        connect(right.id, left.id);
      }
    }
  }

  const communityMap = new Map<string, string>();
  const communities: Array<{ id: string; label: string; nodeIds: string[] }> = [];
  const visited = new Set<string>();

  for (const node of nonSourceNodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const queue = [node.id];
    const memberIds: string[] = [];
    visited.add(node.id);

    while (queue.length) {
      const current = queue.shift() as string;
      memberIds.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor) && nodes.find((candidate) => candidate.id === neighbor)?.type !== "source") {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const labelSeed = nodes.find((candidate) => candidate.id === memberIds[0])?.label ?? `cluster-${communities.length + 1}`;
    const communityId = buildCommunityId(labelSeed, communities.length);
    communities.push({
      id: communityId,
      label: labelSeed,
      nodeIds: memberIds.sort((left, right) => left.localeCompare(right))
    });
    for (const memberId of memberIds) {
      communityMap.set(memberId, communityId);
    }
  }

  const degreeMap = new Map<string, number>();
  for (const node of nodes) {
    degreeMap.set(node.id, adjacency.get(node.id)?.size ?? 0);
  }

  const degreeValues = nodes
    .filter((node) => node.type !== "source")
    .map((node) => degreeMap.get(node.id) ?? 0)
    .sort((left, right) => right - left);
  const godNodeThreshold = degreeValues[Math.max(0, Math.floor(degreeValues.length * 0.1) - 1)] ?? 0;

  const nextNodes = nodes.map((node) => {
    const neighborCommunities = new Set(
      [...(adjacency.get(node.id) ?? [])]
        .map((neighborId) => communityMap.get(neighborId) ?? communityMap.get(node.id))
        .filter((communityId): communityId is string => Boolean(communityId))
    );
    const degree = degreeMap.get(node.id) ?? 0;
    const bridgeScore = node.type === "source" ? neighborCommunities.size : Math.max(0, neighborCommunities.size - 1);
    const inferredCommunityId =
      communityMap.get(node.id) ??
      [...(adjacency.get(node.id) ?? [])]
        .map((neighborId) => communityMap.get(neighborId))
        .find((communityId): communityId is string => Boolean(communityId));

    return {
      ...node,
      communityId: inferredCommunityId,
      degree,
      bridgeScore,
      isGodNode: node.type !== "source" && degree >= godNodeThreshold && degree > 0
    };
  });

  return {
    nodes: nextNodes,
    communities
  };
}

function buildGraph(
  manifests: SourceManifest[],
  analyses: SourceAnalysis[],
  pages: GraphPage[],
  sourceProjects: Record<string, string | null>,
  _codeIndex: CodeIndexArtifact
): GraphArtifact {
  const sourceNodes: GraphNode[] = manifests.map((manifest) => ({
    id: `source:${manifest.sourceId}`,
    type: "source",
    label: manifest.title,
    pageId: `source:${manifest.sourceId}`,
    freshness: "fresh",
    confidence: 1,
    sourceIds: [manifest.sourceId],
    projectIds: scopedProjectIdsFromSources([manifest.sourceId], sourceProjects),
    language: manifest.language
  }));

  const conceptMap = new Map<string, GraphNode>();
  const entityMap = new Map<string, GraphNode>();
  const moduleMap = new Map<string, GraphNode>();
  const symbolMap = new Map<string, GraphNode>();
  const rationaleMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgesById = new Set<string>();

  const pushEdge = (edge: GraphEdge) => {
    if (edgesById.has(edge.id)) {
      return;
    }
    edgesById.add(edge.id);
    edges.push(edge);
  };

  const manifestsById = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  const analysesBySourceId = new Map(analyses.map((analysis) => [analysis.sourceId, analysis]));

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
        sourceIds,
        projectIds: scopedProjectIdsFromSources(sourceIds, sourceProjects)
      });
      pushEdge({
        id: `${analysis.sourceId}->${concept.id}`,
        source: `source:${analysis.sourceId}`,
        target: concept.id,
        relation: "mentions",
        status: "extracted",
        evidenceClass: "extracted",
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
        sourceIds,
        projectIds: scopedProjectIdsFromSources(sourceIds, sourceProjects)
      });
      pushEdge({
        id: `${analysis.sourceId}->${entity.id}`,
        source: `source:${analysis.sourceId}`,
        target: entity.id,
        relation: "mentions",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: edgeConfidence(analysis.claims, entity.name),
        provenance: [analysis.sourceId]
      });
    }

    if (analysis.code) {
      const manifest = manifestsById.get(analysis.sourceId);
      if (!manifest) {
        continue;
      }

      const moduleId = analysis.code.moduleId;
      moduleMap.set(moduleId, {
        id: moduleId,
        type: "module",
        label: modulePageTitle(manifest),
        pageId: moduleId,
        freshness: "fresh",
        confidence: 1,
        sourceIds: [analysis.sourceId],
        projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
        language: analysis.code.language,
        moduleId
      });

      pushEdge({
        id: `source:${analysis.sourceId}->${moduleId}:contains_code`,
        source: `source:${analysis.sourceId}`,
        target: moduleId,
        relation: "contains_code",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 1,
        provenance: [analysis.sourceId]
      });

      for (const symbol of analysis.code.symbols) {
        symbolMap.set(symbol.id, {
          id: symbol.id,
          type: "symbol",
          label: symbol.name,
          pageId: moduleId,
          freshness: "fresh",
          confidence: symbol.exported ? 0.88 : 0.74,
          sourceIds: [analysis.sourceId],
          projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
          language: analysis.code.language,
          moduleId,
          symbolKind: symbol.kind
        });

        pushEdge({
          id: `${moduleId}->${symbol.id}:defines`,
          source: moduleId,
          target: symbol.id,
          relation: "defines",
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: [analysis.sourceId]
        });

        if (symbol.exported) {
          pushEdge({
            id: `${moduleId}->${symbol.id}:exports`,
            source: moduleId,
            target: symbol.id,
            relation: "exports",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }

      const symbolIdsByName = new Map(analysis.code.symbols.map((symbol) => [symbol.name, symbol.id]));

      for (const rationale of analysis.rationales) {
        const targetSymbolId = rationale.symbolName ? symbolIdsByName.get(rationale.symbolName) : undefined;
        const targetId = targetSymbolId ?? moduleId;
        rationaleMap.set(rationale.id, {
          id: rationale.id,
          type: "rationale",
          label: truncate(rationale.text, 80),
          pageId: moduleId,
          freshness: "fresh",
          confidence: 1,
          sourceIds: [analysis.sourceId],
          projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
          language: analysis.code.language,
          moduleId
        });
        pushEdge({
          id: `${rationale.id}->${targetId}:rationale_for`,
          source: rationale.id,
          target: targetId,
          relation: "rationale_for",
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: [analysis.sourceId]
        });
      }
      const importedSymbolIdsByName = new Map<string, string>();
      for (const codeImport of analysis.code.imports.filter((item) => !item.isExternal)) {
        const targetSourceId = codeImport.resolvedSourceId;
        const targetAnalysis = targetSourceId ? analysesBySourceId.get(targetSourceId) : undefined;
        if (!targetSourceId || !targetAnalysis?.code) {
          continue;
        }

        if (codeImport.importedSymbols.length === 0) {
          for (const targetSymbol of targetAnalysis.code.symbols.filter((symbol) => symbol.exported)) {
            importedSymbolIdsByName.set(targetSymbol.name, targetSymbol.id);
          }
        }

        for (const importedSymbol of codeImport.importedSymbols) {
          const [rawExportedName, rawLocalName] = importedSymbol.split(/\s+as\s+/i);
          const exportedName = (rawExportedName ?? "").trim();
          const localName = (rawLocalName ?? rawExportedName ?? "").trim();
          if (!exportedName || !localName) {
            continue;
          }
          const targetSymbol = targetAnalysis.code.symbols.find((symbol) => symbol.name === exportedName && symbol.exported);
          if (targetSymbol) {
            importedSymbolIdsByName.set(localName, targetSymbol.id);
          }
        }
      }

      for (const symbol of analysis.code.symbols) {
        for (const targetName of symbol.calls) {
          const targetId = symbolIdsByName.get(targetName);
          if (!targetId || targetId === symbol.id) {
            continue;
          }
          pushEdge({
            id: `${symbol.id}->${targetId}:calls`,
            source: symbol.id,
            target: targetId,
            relation: "calls",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }

        for (const targetName of symbol.extends) {
          const targetId = symbolIdsByName.get(targetName) ?? importedSymbolIdsByName.get(targetName);
          if (!targetId) {
            continue;
          }
          pushEdge({
            id: `${symbol.id}->${targetId}:extends`,
            source: symbol.id,
            target: targetId,
            relation: "extends",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }

        for (const targetName of symbol.implements) {
          const targetId = symbolIdsByName.get(targetName) ?? importedSymbolIdsByName.get(targetName);
          if (!targetId) {
            continue;
          }
          pushEdge({
            id: `${symbol.id}->${targetId}:implements`,
            source: symbol.id,
            target: targetId,
            relation: "implements",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }

      for (const codeImport of analysis.code.imports) {
        const targetSourceId = codeImport.resolvedSourceId;
        if (!targetSourceId) {
          continue;
        }

        const targetModuleId = `module:${targetSourceId}`;
        pushEdge({
          id: `${moduleId}->${targetModuleId}:${codeImport.reExport ? "exports" : "imports"}:${codeImport.specifier}`,
          source: moduleId,
          target: targetModuleId,
          relation: codeImport.reExport ? "exports" : "imports",
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: [analysis.sourceId, targetSourceId]
        });
      }
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
        pushEdge({
          id: `conflict:${positiveClaim.claim.id}->${negativeClaim.claim.id}`,
          source: `source:${positiveClaim.sourceId}`,
          target: `source:${negativeClaim.sourceId}`,
          relation: "conflicted_with",
          status: "conflicted",
          evidenceClass: "ambiguous",
          confidence: conflictConfidence(positiveClaim.claim, negativeClaim.claim),
          provenance: [positiveClaim.sourceId, negativeClaim.sourceId]
        });
      }
    }
  }

  const graphNodes = [
    ...sourceNodes,
    ...moduleMap.values(),
    ...symbolMap.values(),
    ...rationaleMap.values(),
    ...conceptMap.values(),
    ...entityMap.values()
  ];
  const metrics = deriveGraphMetrics(graphNodes, edges);

  return {
    generatedAt: new Date().toISOString(),
    nodes: metrics.nodes,
    edges,
    communities: metrics.communities,
    sources: manifests,
    pages
  };
}

async function buildGraphOrientationPages(
  graph: GraphArtifact,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  schemaHash: string
): Promise<ManagedPageRecord[]> {
  const benchmark = await readJsonFile<BenchmarkArtifact>(paths.benchmarkPath);
  const communityRecords: ManagedPageRecord[] = [];

  for (const community of graph.communities ?? []) {
    const absolutePath = path.join(paths.wikiDir, "graph", "communities", `${community.id.replace(/^community:/, "")}.md`);
    communityRecords.push(
      await buildManagedGraphPage(
        absolutePath,
        {
          managedBy: "system",
          compiledFrom: uniqueStrings(
            community.nodeIds.flatMap((nodeId) => graph.nodes.find((node) => node.id === nodeId)?.sourceIds ?? [])
          ),
          confidence: 1
        },
        (metadata) =>
          buildCommunitySummaryPage({
            graph,
            community,
            schemaHash,
            metadata
          })
      )
    );
  }

  const reportAbsolutePath = path.join(paths.wikiDir, "graph", "report.md");
  const reportRecord = await buildManagedGraphPage(
    reportAbsolutePath,
    {
      managedBy: "system",
      compiledFrom: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      confidence: 1
    },
    (metadata) =>
      buildGraphReportPage({
        graph,
        schemaHash,
        metadata,
        communityPages: communityRecords.map((record) => record.page),
        benchmark
      })
  );

  return [reportRecord, ...communityRecords];
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
  projectIds?: string[];
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
    projectIds: input.projectIds ?? [],
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
    paths.codeIndexPath,
    paths.searchDbPath,
    path.join(paths.wikiDir, "index.md"),
    path.join(paths.wikiDir, "sources", "index.md"),
    path.join(paths.wikiDir, "code", "index.md"),
    path.join(paths.wikiDir, "concepts", "index.md"),
    path.join(paths.wikiDir, "entities", "index.md"),
    path.join(paths.wikiDir, "outputs", "index.md"),
    path.join(paths.wikiDir, "projects", "index.md"),
    path.join(paths.wikiDir, "candidates", "index.md")
  ];

  const checks = await Promise.all(requiredPaths.map((filePath) => fileExists(filePath)));
  return checks.every(Boolean);
}

async function loadAvailableCachedAnalyses(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  manifests: SourceManifest[]
): Promise<SourceAnalysis[]> {
  const analyses = await Promise.all(
    manifests.map(async (manifest) => readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${manifest.sourceId}.json`)))
  );
  return analyses.filter((analysis): analysis is SourceAnalysis => Boolean(analysis));
}

function approvalManifestPath(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"], approvalId: string): string {
  return path.join(paths.approvalsDir, approvalId, "manifest.json");
}

function approvalGraphPath(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"], approvalId: string): string {
  return path.join(paths.approvalsDir, approvalId, "state", "graph.json");
}

async function readApprovalManifest(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  approvalId: string
): Promise<ApprovalManifest> {
  const manifest = await readJsonFile<ApprovalManifest>(approvalManifestPath(paths, approvalId));
  if (!manifest) {
    throw new Error(`Approval bundle not found: ${approvalId}`);
  }
  return manifest;
}

async function writeApprovalManifest(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  manifest: ApprovalManifest
): Promise<void> {
  await fs.writeFile(approvalManifestPath(paths, manifest.approvalId), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function buildApprovalEntries(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  changedFiles: Array<{ relativePath: string; content: string }>,
  deletedPaths: string[],
  previousGraph: GraphArtifact | null,
  graph: GraphArtifact
): Promise<ApprovalEntry[]> {
  const previousPagesById = new Map((previousGraph?.pages ?? []).map((page) => [page.id, page]));
  const previousPagesByPath = new Map((previousGraph?.pages ?? []).map((page) => [page.path, page]));
  const nextPagesByPath = new Map(graph.pages.map((page) => [page.path, page]));
  const handledDeletedPaths = new Set<string>();
  const entries: ApprovalEntry[] = [];

  for (const file of changedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const nextPage = nextPagesByPath.get(file.relativePath);
    if (!nextPage) {
      continue;
    }
    const previousPage = previousPagesById.get(nextPage.id);
    const currentExists = await fileExists(path.join(paths.wikiDir, file.relativePath));
    if (previousPage && previousPage.path !== nextPage.path) {
      entries.push({
        pageId: nextPage.id,
        title: nextPage.title,
        kind: nextPage.kind,
        changeType: "promote",
        status: "pending",
        sourceIds: nextPage.sourceIds,
        nextPath: nextPage.path,
        previousPath: previousPage.path
      });
      handledDeletedPaths.add(previousPage.path);
      continue;
    }

    entries.push({
      pageId: nextPage.id,
      title: nextPage.title,
      kind: nextPage.kind,
      changeType: previousPage || currentExists ? "update" : "create",
      status: "pending",
      sourceIds: nextPage.sourceIds,
      nextPath: nextPage.path,
      previousPath: previousPage?.path
    });
  }

  for (const deletedPath of deletedPaths.sort((left, right) => left.localeCompare(right))) {
    if (handledDeletedPaths.has(deletedPath)) {
      continue;
    }
    const previousPage = previousPagesByPath.get(deletedPath);
    entries.push({
      pageId: previousPage?.id ?? `page:${slugify(deletedPath)}`,
      title: previousPage?.title ?? path.basename(deletedPath, ".md"),
      kind: previousPage?.kind ?? "index",
      changeType: "delete",
      status: "pending",
      sourceIds: previousPage?.sourceIds ?? [],
      previousPath: deletedPath
    });
  }

  return uniqueBy(entries, (entry) => `${entry.pageId}:${entry.changeType}:${entry.nextPath ?? ""}:${entry.previousPath ?? ""}`);
}

async function stageApprovalBundle(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  changedFiles: Array<{ relativePath: string; content: string }>,
  deletedPaths: string[],
  previousGraph: GraphArtifact | null,
  graph: GraphArtifact
): Promise<{ approvalId: string; approvalDir: string }> {
  const approvalId = `compile-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const approvalDir = path.join(paths.approvalsDir, approvalId);
  await ensureDir(approvalDir);
  await ensureDir(path.join(approvalDir, "wiki"));
  await ensureDir(path.join(approvalDir, "state"));

  for (const file of changedFiles) {
    const targetPath = path.join(approvalDir, "wiki", file.relativePath);
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, file.content, "utf8");
  }

  await fs.writeFile(path.join(approvalDir, "state", "graph.json"), JSON.stringify(graph, null, 2), "utf8");
  await writeApprovalManifest(paths, {
    approvalId,
    createdAt: new Date().toISOString(),
    entries: await buildApprovalEntries(paths, changedFiles, deletedPaths, previousGraph, graph)
  });

  return { approvalId, approvalDir };
}

async function syncVaultArtifacts(
  rootDir: string,
  input: {
    schemas: LoadedVaultSchemas;
    manifests: SourceManifest[];
    analyses: SourceAnalysis[];
    codeIndex: CodeIndexArtifact;
    sourceProjects: Record<string, string | null>;
    outputPages: GraphPage[];
    insightPages: GraphPage[];
    outputHashes: Record<string, string>;
    insightHashes: Record<string, string>;
    previousState: CompileState | null;
    approve?: boolean;
    promoteCandidates?: boolean;
  }
): Promise<{
  graph: GraphArtifact;
  allPages: GraphPage[];
  changedPages: string[];
  promotedPageIds: string[];
  candidatePageCount: number;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
}> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const previousGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const globalSchemaHash = input.schemas.effective.global.hash;
  const changedPages: string[] = [];
  const promotedPageIds: string[] = [];
  const candidateHistory: CompileState["candidateHistory"] = {};
  const records: ManagedPageRecord[] = [];
  const promoteCandidates = input.promoteCandidates ?? true;

  for (const manifest of input.manifests) {
    const analysis = input.analyses.find((item) => item.sourceId === manifest.sourceId);
    if (!analysis) {
      continue;
    }
    const sourceProjectIds = scopedProjectIdsFromSources([manifest.sourceId], input.sourceProjects);
    const sourceSchemaHash = effectiveHashForProject(input.schemas, sourceProjectIds[0] ?? null);
    const sourceCategoryTags = categoryTagsForSchema(getEffectiveSchema(input.schemas, sourceProjectIds[0] ?? null), [
      analysis.title,
      analysis.summary,
      ...analysis.concepts.map((item) => item.description),
      ...analysis.entities.map((item) => item.description)
    ]);

    const modulePreview = analysis.code
      ? emptyGraphPage({
          id: analysis.code.moduleId,
          path: `code/${manifest.sourceId}.md`,
          title: modulePageTitle(manifest),
          kind: "module",
          sourceIds: [manifest.sourceId],
          projectIds: sourceProjectIds,
          nodeIds: [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)],
          schemaHash: sourceSchemaHash,
          sourceHashes: { [manifest.sourceId]: manifest.contentHash },
          confidence: 1
        })
      : null;
    const preview = emptyGraphPage({
      id: `source:${manifest.sourceId}`,
      path: `sources/${manifest.sourceId}.md`,
      title: analysis.title,
      kind: "source",
      sourceIds: [manifest.sourceId],
      projectIds: sourceProjectIds,
      nodeIds: [
        `source:${manifest.sourceId}`,
        ...analysis.concepts.map((item) => item.id),
        ...analysis.entities.map((item) => item.id),
        ...(analysis.code ? [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)] : [])
      ],
      schemaHash: sourceSchemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
      confidence: 1
    });
    const sourceRecord = await buildManagedGraphPage(
      path.join(paths.wikiDir, preview.path),
      {
        managedBy: "system",
        confidence: 1,
        compiledFrom: [manifest.sourceId]
      },
      (metadata) =>
        buildSourcePage(
          manifest,
          analysis,
          sourceSchemaHash,
          metadata,
          relatedOutputsForPage(preview, input.outputPages),
          modulePreview ?? undefined,
          {
            projectIds: sourceProjectIds,
            extraTags: sourceCategoryTags
          }
        )
    );
    records.push(sourceRecord);

    if (modulePreview && analysis.code) {
      const localModules = analysis.code.imports
        .map((codeImport) => {
          const resolvedSourceId = codeImport.resolvedSourceId;
          if (!resolvedSourceId) {
            return null;
          }
          const targetManifest = input.manifests.find((item) => item.sourceId === resolvedSourceId);
          if (!targetManifest) {
            return null;
          }
          return {
            specifier: codeImport.specifier,
            sourceId: resolvedSourceId,
            reExport: codeImport.reExport,
            page: {
              id: `module:${resolvedSourceId}`,
              path: `code/${resolvedSourceId}.md`,
              title: modulePageTitle(targetManifest)
            }
          };
        })
        .filter(
          (item): item is { specifier: string; sourceId: string; reExport: boolean; page: Pick<GraphPage, "id" | "path" | "title"> } =>
            Boolean(item)
        );

      records.push(
        await buildManagedGraphPage(
          path.join(paths.wikiDir, modulePreview.path),
          {
            managedBy: "system",
            confidence: 1,
            compiledFrom: [manifest.sourceId]
          },
          (metadata) =>
            buildModulePage({
              manifest,
              analysis,
              schemaHash: sourceSchemaHash,
              metadata,
              sourcePage: sourceRecord.page,
              localModules,
              relatedOutputs: relatedOutputsForPage(modulePreview, input.outputPages),
              projectIds: sourceProjectIds,
              extraTags: sourceCategoryTags
            })
        )
      );
    }
  }

  for (const kind of ["concepts", "entities"] as const) {
    for (const aggregate of aggregateItems(input.analyses, kind)) {
      const itemKind = kind === "concepts" ? "concept" : "entity";
      const slug = slugify(aggregate.name);
      const pageId = `${itemKind}:${slug}`;
      const sourceIds = uniqueStrings(aggregate.sourceAnalyses.map((item) => item.sourceId));
      const projectIds = scopedProjectIdsFromSources(sourceIds, input.sourceProjects);
      const schemaHash = effectiveHashForProject(input.schemas, projectIds[0] ?? null);
      const previousEntry = input.previousState?.candidateHistory?.[pageId];
      const promoted = previousEntry?.status === "active" || (promoteCandidates && shouldPromoteCandidate(previousEntry, sourceIds));
      const relativePath = promoted ? activeAggregatePath(itemKind, slug) : candidatePagePathFor(itemKind, slug);
      const fallbackPaths = [
        path.join(paths.wikiDir, activeAggregatePath(itemKind, slug)),
        path.join(paths.wikiDir, candidatePagePathFor(itemKind, slug))
      ];
      const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
      const preview = emptyGraphPage({
        id: pageId,
        path: relativePath,
        title: aggregate.name,
        kind: itemKind,
        sourceIds,
        projectIds,
        nodeIds: [pageId],
        schemaHash,
        sourceHashes: aggregate.sourceHashes,
        confidence,
        status: promoted ? "active" : "candidate"
      });
      const pageRecord = await buildManagedGraphPage(
        path.join(paths.wikiDir, relativePath),
        {
          status: promoted ? "active" : "candidate",
          managedBy: "system",
          confidence,
          compiledFrom: sourceIds,
          statePathCandidates: fallbackPaths
        },
        (metadata) =>
          buildAggregatePage(
            itemKind,
            aggregate.name,
            aggregate.descriptions,
            aggregate.sourceAnalyses,
            aggregate.sourceHashes,
            schemaHash,
            metadata,
            relativePath,
            relatedOutputsForPage(preview, input.outputPages),
            {
              projectIds,
              extraTags: categoryTagsForSchema(getEffectiveSchema(input.schemas, projectIds[0] ?? null), [
                aggregate.name,
                ...aggregate.descriptions,
                ...aggregate.sourceAnalyses.map((item) => item.summary)
              ])
            }
          )
      );
      if (promoted && previousEntry?.status === "candidate") {
        promotedPageIds.push(pageId);
      }
      candidateHistory[pageId] = {
        sourceIds,
        status: promoted ? "active" : "candidate"
      };
      records.push(pageRecord);
    }
  }

  const compiledPages = records.map((record) => record.page);
  const basePages = [...compiledPages, ...input.outputPages, ...input.insightPages];
  const baseGraph = buildGraph(input.manifests, input.analyses, basePages, input.sourceProjects, input.codeIndex);
  const graphOrientationRecords = await buildGraphOrientationPages(baseGraph, paths, globalSchemaHash);
  records.push(...graphOrientationRecords);
  const allPages = [...basePages, ...graphOrientationRecords.map((record) => record.page)];
  const graph: GraphArtifact = {
    ...baseGraph,
    pages: allPages
  };
  const activeConceptPages = allPages.filter((page) => page.kind === "concept" && page.status !== "candidate");
  const activeEntityPages = allPages.filter((page) => page.kind === "entity" && page.status !== "candidate");
  const modulePages = allPages.filter((page) => page.kind === "module");
  const candidatePages = allPages.filter((page) => page.status === "candidate");
  const configuredProjects = projectEntries(config);
  const projectIndexRefs = configuredProjects.map((project) =>
    emptyGraphPage({
      id: `project:${project.id}:index`,
      path: `projects/${project.id}/index.md`,
      title: `Project: ${project.id}`,
      kind: "index",
      sourceIds: [],
      projectIds: [project.id],
      nodeIds: [],
      schemaHash: effectiveHashForProject(input.schemas, project.id),
      sourceHashes: {},
      confidence: 1
    })
  );

  records.push({
    page: emptyGraphPage({
      id: "projects:index",
      path: "projects/index.md",
      title: "Projects",
      kind: "index",
      sourceIds: [],
      projectIds: [],
      nodeIds: [],
      schemaHash: globalSchemaHash,
      sourceHashes: {},
      confidence: 1
    }),
    content: await buildManagedContent(
      path.join(paths.wikiDir, "projects", "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(projectIndexRefs)
      },
      (metadata) => buildProjectsIndex(projectIndexRefs, globalSchemaHash, metadata)
    )
  });

  for (const project of configuredProjects) {
    const projectIndexRef = projectIndexRefs.find((page) => page.projectIds.includes(project.id));
    if (!projectIndexRef) {
      continue;
    }
    const sections = {
      sources: allPages.filter((page) => page.kind === "source" && page.projectIds.includes(project.id)),
      code: allPages.filter((page) => page.kind === "module" && page.projectIds.includes(project.id)),
      concepts: allPages.filter((page) => page.kind === "concept" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      entities: allPages.filter((page) => page.kind === "entity" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      outputs: allPages.filter((page) => page.kind === "output" && page.projectIds.includes(project.id)),
      candidates: allPages.filter((page) => page.status === "candidate" && page.projectIds.includes(project.id))
    } as const;
    records.push({
      page: projectIndexRef,
      content: await buildManagedContent(
        path.join(paths.wikiDir, projectIndexRef.path),
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(Object.values(sections).flat())
        },
        (metadata) =>
          buildProjectIndex({
            projectId: project.id,
            schemaHash: effectiveHashForProject(input.schemas, project.id),
            metadata,
            sections
          })
      )
    });
  }

  records.push({
    page: emptyGraphPage({
      id: "index",
      path: "index.md",
      title: "SwarmVault Index",
      kind: "index",
      sourceIds: [],
      projectIds: [],
      nodeIds: [],
      schemaHash: globalSchemaHash,
      sourceHashes: {},
      confidence: 1
    }),
    content: await buildManagedContent(
      path.join(paths.wikiDir, "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages)
      },
      (metadata) => buildIndexPage(allPages, globalSchemaHash, metadata, projectIndexRefs)
    )
  });

  for (const [relativePath, kind, pages] of [
    ["sources/index.md", "sources", allPages.filter((page) => page.kind === "source")],
    ["code/index.md", "code", modulePages],
    ["concepts/index.md", "concepts", activeConceptPages],
    ["entities/index.md", "entities", activeEntityPages],
    ["outputs/index.md", "outputs", allPages.filter((page) => page.kind === "output")],
    ["candidates/index.md", "candidates", candidatePages],
    ["graph/index.md", "graph", allPages.filter((page) => page.kind === "graph_report" || page.kind === "community_summary")]
  ] as const) {
    records.push({
      page: emptyGraphPage({
        id: `${kind}:index`,
        path: relativePath,
        title: kind,
        kind: "index",
        sourceIds: [],
        projectIds: [],
        nodeIds: [],
        schemaHash: globalSchemaHash,
        sourceHashes: {},
        confidence: 1
      }),
      content: await buildManagedContent(
        path.join(paths.wikiDir, relativePath),
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(pages)
        },
        (metadata) => buildSectionIndex(kind, pages, globalSchemaHash, metadata)
      )
    });
  }

  const nextPagePaths = new Set(records.map((record) => record.page.path));
  const obsoleteGraphPaths = (previousGraph?.pages ?? [])
    .filter((page) => page.kind !== "output" && page.kind !== "insight")
    .map((page) => page.path)
    .filter((relativePath) => !nextPagePaths.has(relativePath));
  const existingProjectIndexPaths = (await listFilesRecursive(paths.projectsDir))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)))
    .filter((relativePath) => !nextPagePaths.has(relativePath));
  const obsoletePaths = uniqueStrings([...obsoleteGraphPaths, ...existingProjectIndexPaths]);

  const changedFiles: Array<{ relativePath: string; content: string }> = [];
  for (const record of records) {
    const absolutePath = path.join(paths.wikiDir, record.page.path);
    const current = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
    if (current !== record.content) {
      changedPages.push(record.page.path);
      changedFiles.push({ relativePath: record.page.path, content: record.content });
    }
  }
  changedPages.push(...obsoletePaths.filter((relativePath) => !changedPages.includes(relativePath)));

  if (input.approve) {
    const approval = await stageApprovalBundle(paths, changedFiles, obsoletePaths, previousGraph ?? null, graph);
    return {
      graph,
      allPages,
      changedPages,
      promotedPageIds,
      candidatePageCount: candidatePages.length,
      staged: true,
      approvalId: approval.approvalId,
      approvalDir: approval.approvalDir
    };
  }

  const writeChanges: string[] = [];
  for (const record of records) {
    await writePage(paths.wikiDir, record.page.path, record.content, writeChanges);
  }
  for (const relativePath of obsoletePaths) {
    await fs.rm(path.join(paths.wikiDir, relativePath), { force: true });
  }

  await writeJsonFile(paths.graphPath, graph);
  await writeJsonFile(paths.codeIndexPath, input.codeIndex);
  await writeJsonFile(paths.compileStatePath, {
    generatedAt: graph.generatedAt,
    rootSchemaHash: input.schemas.root.hash,
    projectSchemaHashes: Object.fromEntries(
      Object.keys(input.schemas.projects)
        .sort((left, right) => left.localeCompare(right))
        .map((projectId) => [projectId, input.schemas.projects[projectId]?.hash ?? ""])
    ),
    effectiveSchemaHashes: {
      global: input.schemas.effective.global.hash,
      projects: Object.fromEntries(
        Object.keys(input.schemas.effective.projects)
          .sort((left, right) => left.localeCompare(right))
          .map((projectId) => [projectId, input.schemas.effective.projects[projectId]?.hash ?? input.schemas.effective.global.hash])
      )
    },
    projectConfigHash: projectConfigHash(config),
    analyses: Object.fromEntries(input.analyses.map((analysis) => [analysis.sourceId, analysisSignature(analysis)])),
    sourceHashes: Object.fromEntries(input.manifests.map((manifest) => [manifest.sourceId, manifest.contentHash])),
    sourceProjects: input.sourceProjects,
    outputHashes: input.outputHashes,
    insightHashes: input.insightHashes,
    candidateHistory
  } satisfies CompileState);
  await rebuildSearchIndex(paths.searchDbPath, allPages, paths.wikiDir);

  return {
    graph,
    allPages,
    changedPages: uniqueStrings([...changedPages, ...writeChanges]),
    promotedPageIds,
    candidatePageCount: candidatePages.length,
    staged: false
  };
}

async function refreshIndexesAndSearch(rootDir: string, pages: GraphPage[]): Promise<void> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const globalSchemaHash = schemas.effective.global.hash;
  const currentGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const basePages = pages.filter((page) => page.kind !== "graph_report" && page.kind !== "community_summary");
  const graphOrientationRecords = currentGraph
    ? await buildGraphOrientationPages(
        {
          ...currentGraph,
          pages: basePages
        },
        paths,
        globalSchemaHash
      )
    : [];
  const pagesWithGraph = sortGraphPages([...basePages, ...graphOrientationRecords.map((record) => record.page)]);
  if (currentGraph) {
    await writeJsonFile(paths.graphPath, {
      ...currentGraph,
      pages: pagesWithGraph
    });
  }
  const configuredProjects = projectEntries(config);
  const projectIndexRefs = configuredProjects.map((project) =>
    emptyGraphPage({
      id: `project:${project.id}:index`,
      path: `projects/${project.id}/index.md`,
      title: `Project: ${project.id}`,
      kind: "index",
      sourceIds: [],
      projectIds: [project.id],
      nodeIds: [],
      schemaHash: effectiveHashForProject(schemas, project.id),
      sourceHashes: {},
      confidence: 1
    })
  );
  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "code")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs")),
    ensureDir(path.join(paths.wikiDir, "graph")),
    ensureDir(path.join(paths.wikiDir, "graph", "communities")),
    ensureDir(path.join(paths.wikiDir, "projects")),
    ensureDir(path.join(paths.wikiDir, "candidates"))
  ]);
  const projectsIndexPath = path.join(paths.wikiDir, "projects", "index.md");
  await writeFileIfChanged(
    projectsIndexPath,
    await buildManagedContent(
      projectsIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(projectIndexRefs)
      },
      (metadata) => buildProjectsIndex(projectIndexRefs, globalSchemaHash, metadata)
    )
  );

  for (const project of configuredProjects) {
    const sections = {
      sources: pages.filter((page) => page.kind === "source" && page.projectIds.includes(project.id)),
      code: pages.filter((page) => page.kind === "module" && page.projectIds.includes(project.id)),
      concepts: pages.filter((page) => page.kind === "concept" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      entities: pages.filter((page) => page.kind === "entity" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      outputs: pages.filter((page) => page.kind === "output" && page.projectIds.includes(project.id)),
      candidates: pages.filter((page) => page.status === "candidate" && page.projectIds.includes(project.id))
    } as const;
    const absolutePath = path.join(paths.wikiDir, "projects", project.id, "index.md");
    await writeFileIfChanged(
      absolutePath,
      await buildManagedContent(
        absolutePath,
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(Object.values(sections).flat())
        },
        (metadata) =>
          buildProjectIndex({
            projectId: project.id,
            schemaHash: effectiveHashForProject(schemas, project.id),
            metadata,
            sections
          })
      )
    );
  }

  const rootIndexPath = path.join(paths.wikiDir, "index.md");
  await writeFileIfChanged(
    rootIndexPath,
    await buildManagedContent(
      rootIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(pagesWithGraph)
      },
      (metadata) => buildIndexPage(pagesWithGraph, globalSchemaHash, metadata, projectIndexRefs)
    )
  );

  for (const [relativePath, kind, sectionPages] of [
    ["sources/index.md", "sources", pagesWithGraph.filter((page) => page.kind === "source")],
    ["code/index.md", "code", pagesWithGraph.filter((page) => page.kind === "module")],
    ["concepts/index.md", "concepts", pagesWithGraph.filter((page) => page.kind === "concept" && page.status !== "candidate")],
    ["entities/index.md", "entities", pagesWithGraph.filter((page) => page.kind === "entity" && page.status !== "candidate")],
    ["outputs/index.md", "outputs", pagesWithGraph.filter((page) => page.kind === "output")],
    ["candidates/index.md", "candidates", pagesWithGraph.filter((page) => page.status === "candidate")],
    ["graph/index.md", "graph", pagesWithGraph.filter((page) => page.kind === "graph_report" || page.kind === "community_summary")]
  ] as const) {
    const absolutePath = path.join(paths.wikiDir, relativePath);
    await writeFileIfChanged(
      absolutePath,
      await buildManagedContent(
        absolutePath,
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(sectionPages)
        },
        (metadata) => buildSectionIndex(kind, sectionPages, globalSchemaHash, metadata)
      )
    );
  }

  for (const record of graphOrientationRecords) {
    await writeFileIfChanged(path.join(paths.wikiDir, record.page.path), record.content);
  }

  const existingProjectIndexPaths = (await listFilesRecursive(paths.projectsDir))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)));
  const allowedProjectIndexPaths = new Set([
    "projects/index.md",
    ...configuredProjects.map((project) => `projects/${project.id}/index.md`)
  ]);
  await Promise.all(
    existingProjectIndexPaths
      .filter((relativePath) => !allowedProjectIndexPaths.has(relativePath))
      .map((relativePath) => fs.rm(path.join(paths.wikiDir, relativePath), { force: true }))
  );

  const existingGraphPages = (await listFilesRecursive(path.join(paths.wikiDir, "graph").replace(/\/$/, "")).catch(() => []))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)));
  const allowedGraphPages = new Set(["graph/index.md", ...graphOrientationRecords.map((record) => record.page.path)]);
  await Promise.all(
    existingGraphPages
      .filter((relativePath) => !allowedGraphPages.has(relativePath))
      .map((relativePath) => fs.rm(path.join(paths.wikiDir, relativePath), { force: true }))
  );

  await rebuildSearchIndex(paths.searchDbPath, pagesWithGraph, paths.wikiDir);
}

async function prepareOutputPageSave(
  rootDir: string,
  input: Omit<Parameters<typeof buildOutputPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult & { content: string; assetFiles: GeneratedOutputArtifacts["assetFiles"] }> {
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
  return {
    page: output.page,
    savedPath: absolutePath,
    outputAssets: output.page.outputAssets ?? [],
    content: output.content,
    assetFiles: input.assetFiles ?? []
  };
}

async function persistOutputPage(
  rootDir: string,
  input: Omit<Parameters<typeof buildOutputPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const prepared = await prepareOutputPageSave(rootDir, input);
  await ensureDir(path.dirname(prepared.savedPath));
  await fs.writeFile(prepared.savedPath, prepared.content, "utf8");
  for (const assetFile of prepared.assetFiles) {
    const assetPath = path.join(paths.wikiDir, assetFile.relativePath);
    await ensureDir(path.dirname(assetPath));
    if (typeof assetFile.content === "string") {
      await fs.writeFile(assetPath, assetFile.content, assetFile.encoding ?? "utf8");
    } else {
      await fs.writeFile(assetPath, assetFile.content);
    }
  }
  return { page: prepared.page, savedPath: prepared.savedPath, outputAssets: prepared.outputAssets };
}

async function prepareExploreHubSave(
  rootDir: string,
  input: Omit<Parameters<typeof buildExploreHubPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult & { content: string; assetFiles: GeneratedOutputArtifacts["assetFiles"] }> {
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
  return {
    page: hub.page,
    savedPath: absolutePath,
    outputAssets: hub.page.outputAssets ?? [],
    content: hub.content,
    assetFiles: input.assetFiles ?? []
  };
}

async function persistExploreHub(
  rootDir: string,
  input: Omit<Parameters<typeof buildExploreHubPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const prepared = await prepareExploreHubSave(rootDir, input);
  await ensureDir(path.dirname(prepared.savedPath));
  await fs.writeFile(prepared.savedPath, prepared.content, "utf8");
  for (const assetFile of prepared.assetFiles) {
    const assetPath = path.join(paths.wikiDir, assetFile.relativePath);
    await ensureDir(path.dirname(assetPath));
    if (typeof assetFile.content === "string") {
      await fs.writeFile(assetPath, assetFile.content, assetFile.encoding ?? "utf8");
    } else {
      await fs.writeFile(assetPath, assetFile.content);
    }
  }
  return { page: prepared.page, savedPath: prepared.savedPath, outputAssets: prepared.outputAssets };
}

async function stageOutputApprovalBundle(
  rootDir: string,
  stagedPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"] }>
): Promise<{ approvalId: string; approvalDir: string }> {
  const { paths } = await loadVaultConfig(rootDir);
  const previousGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const changedFiles = stagedPages.flatMap((item) => [
    { relativePath: item.page.path, content: item.content },
    ...((item.assetFiles ?? []).map((assetFile) => ({
      relativePath: assetFile.relativePath,
      content: typeof assetFile.content === "string" ? assetFile.content : Buffer.from(assetFile.content).toString("base64"),
      binary: typeof assetFile.content !== "string"
    })) as Array<{ relativePath: string; content: string; binary: boolean }>)
  ]);

  const approvalId = `schedule-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const approvalDir = path.join(paths.approvalsDir, approvalId);
  await ensureDir(approvalDir);
  await ensureDir(path.join(approvalDir, "wiki"));
  await ensureDir(path.join(approvalDir, "state"));

  for (const file of changedFiles) {
    const targetPath = path.join(approvalDir, "wiki", file.relativePath);
    await ensureDir(path.dirname(targetPath));
    if ("binary" in file && file.binary) {
      await fs.writeFile(targetPath, Buffer.from(file.content, "base64"));
    } else {
      await fs.writeFile(targetPath, file.content, "utf8");
    }
  }

  const nextPages = sortGraphPages([
    ...(previousGraph?.pages ?? []).filter((page) => !stagedPages.some((item) => item.page.id === page.id || item.page.path === page.path)),
    ...stagedPages.map((item) => item.page)
  ]);
  const graph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: previousGraph?.nodes ?? [],
    edges: previousGraph?.edges ?? [],
    sources: previousGraph?.sources ?? [],
    pages: nextPages
  };
  await fs.writeFile(path.join(approvalDir, "state", "graph.json"), JSON.stringify(graph, null, 2), "utf8");
  await writeApprovalManifest(paths, {
    approvalId,
    createdAt: new Date().toISOString(),
    entries: await buildApprovalEntries(
      paths,
      stagedPages.map((item) => ({ relativePath: item.page.path, content: item.content })),
      [],
      previousGraph ?? null,
      graph
    )
  });

  return { approvalId, approvalDir };
}

async function executeQuery(rootDir: string, question: string, format: OutputFormat): Promise<QueryExecutionResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (!(await fileExists(paths.searchDbPath)) || !(await fileExists(paths.graphPath))) {
    await compileVault(rootDir, {});
  }

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const pageMap = new Map((graph?.pages ?? []).map((page) => [page.id, page]));
  const sourceProjects = Object.fromEntries(
    (graph?.pages ?? [])
      .filter((page) => page.kind === "source" && page.sourceIds.length)
      .map((page) => [page.sourceIds[0], page.projectIds[0] ?? null])
  );
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
  const schemaProjectIds = schemaProjectIdsFromPages(relatedPageIds, pageMap);
  const querySchema = composeVaultSchema(
    schemas.root,
    schemaProjectIds
      .map((projectId) => schemas.projects[projectId])
      .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema?.hash))
  );
  const pageProjectIds = scopedProjectIdsFromSources(relatedSourceIds, sourceProjects);

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
    answer = formatHeuristicAnswer(question, excerpts, rawExcerpts, searchResults, format);
  } else {
    const context = [
      "Wiki context:",
      excerpts.join("\n\n---\n\n"),
      ...(rawExcerpts.length ? ["", "Raw source material:", rawExcerpts.join("\n\n---\n\n")] : [])
    ].join("\n\n");
    const response = await provider.generateText({
      system: buildSchemaPrompt(
        querySchema,
        [
          "Answer using the provided context. Prefer raw source material over wiki summaries when they differ. Cite source IDs.",
          outputFormatInstruction(format)
        ].join(" ")
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
    schemaHash: querySchema.hash,
    projectIds: pageProjectIds,
    usage
  };
}

async function generateFollowUpQuestions(rootDir: string, question: string, answer: string): Promise<string[]> {
  const provider = await getProviderForTask(rootDir, "queryProvider");
  const schema = (await loadVaultSchemas(rootDir)).effective.global;

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

async function refreshVaultAfterOutputSave(rootDir: string): Promise<void> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const manifests = await listManifests(rootDir);
  const sourceProjects = resolveSourceProjects(rootDir, manifests, config);
  const cachedAnalyses = manifests.length ? await loadAvailableCachedAnalyses(paths, manifests) : [];
  const codeIndex = await buildCodeIndex(rootDir, manifests, cachedAnalyses);
  const analyses = cachedAnalyses.map((analysis) => {
    const manifest = manifests.find((item) => item.sourceId === analysis.sourceId);
    return manifest ? enrichResolvedCodeImports(manifest, analysis, codeIndex) : analysis;
  });
  const storedOutputs = await loadSavedOutputPages(paths.wikiDir);
  const storedInsights = await loadInsightPages(paths.wikiDir);
  await syncVaultArtifacts(rootDir, {
    schemas,
    manifests,
    analyses,
    codeIndex,
    sourceProjects,
    outputPages: storedOutputs.map((page) => page.page),
    insightPages: storedInsights.map((page) => page.page),
    outputHashes: pageHashes(storedOutputs),
    insightHashes: pageHashes(storedInsights),
    previousState: await readJsonFile<CompileState>(paths.compileStatePath),
    approve: false,
    promoteCandidates: false
  });
}

function resolveApprovalTargets(manifest: ApprovalManifest, targets: string[]): ApprovalEntry[] {
  const pendingEntries = manifest.entries.filter((entry) => entry.status === "pending");
  if (!targets.length) {
    return pendingEntries;
  }

  const resolved = pendingEntries.filter(
    (entry) =>
      targets.includes(entry.pageId) ||
      (entry.nextPath ? targets.includes(entry.nextPath) : false) ||
      (entry.previousPath ? targets.includes(entry.previousPath) : false)
  );
  if (!resolved.length) {
    throw new Error(`No pending approval entries matched: ${targets.join(", ")}`);
  }
  return uniqueBy(resolved, (entry) => `${entry.pageId}:${entry.nextPath ?? ""}:${entry.previousPath ?? ""}`);
}

function emptyCompileState(): CompileState {
  return {
    generatedAt: new Date().toISOString(),
    rootSchemaHash: "",
    projectSchemaHashes: {},
    effectiveSchemaHashes: {
      global: "",
      projects: {}
    },
    projectConfigHash: "",
    analyses: {},
    sourceHashes: {},
    sourceProjects: {},
    outputHashes: {},
    insightHashes: {},
    candidateHistory: {}
  };
}

function updateCandidateHistory(compileState: CompileState, page: GraphPage | null, deleted = false): void {
  if (!page || (page.kind !== "concept" && page.kind !== "entity")) {
    return;
  }
  if (deleted) {
    delete compileState.candidateHistory[page.id];
    return;
  }
  compileState.candidateHistory[page.id] = {
    sourceIds: page.sourceIds,
    status: page.status === "candidate" ? "candidate" : "active"
  };
}

function sortGraphPages(pages: GraphPage[]): GraphPage[] {
  return [...pages].sort((left, right) => left.path.localeCompare(right.path) || left.title.localeCompare(right.title));
}

export async function listApprovals(rootDir: string): Promise<ApprovalSummary[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifests = await Promise.all(
    (await fs.readdir(paths.approvalsDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await readApprovalManifest(paths, entry.name);
        } catch {
          return null;
        }
      })
  );

  return manifests
    .filter((manifest): manifest is ApprovalManifest => Boolean(manifest))
    .map(approvalSummary)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readApproval(rootDir: string, approvalId: string): Promise<ApprovalDetail> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifest = await readApprovalManifest(paths, approvalId);
  const details = await Promise.all(
    manifest.entries.map(async (entry) => {
      const currentPath = entry.previousPath ?? entry.nextPath;
      const currentContent = currentPath
        ? await fs.readFile(path.join(paths.wikiDir, currentPath), "utf8").catch(() => undefined)
        : undefined;
      const stagedContent = entry.nextPath
        ? await fs.readFile(path.join(paths.approvalsDir, approvalId, "wiki", entry.nextPath), "utf8").catch(() => undefined)
        : undefined;
      return {
        ...entry,
        currentContent,
        stagedContent
      };
    })
  );

  return {
    ...approvalSummary(manifest),
    entries: details
  };
}

export async function acceptApproval(rootDir: string, approvalId: string, targets: string[] = []): Promise<ReviewActionResult> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const manifest = await readApprovalManifest(paths, approvalId);
  const selectedEntries = resolveApprovalTargets(manifest, targets);
  const bundleGraph = await readJsonFile<GraphArtifact>(approvalGraphPath(paths, approvalId));
  const currentGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const basePages =
    currentGraph?.pages ??
    (bundleGraph?.pages ?? []).filter((page) => page.kind === "index" || page.kind === "output" || page.kind === "insight");
  let nextPages = [...basePages];
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();

  for (const entry of selectedEntries) {
    if (entry.changeType !== "delete") {
      if (!entry.nextPath) {
        throw new Error(`Approval entry ${entry.pageId} is missing a staged path.`);
      }
      const stagedAbsolutePath = path.join(paths.approvalsDir, approvalId, "wiki", entry.nextPath);
      const stagedContent = await fs.readFile(stagedAbsolutePath, "utf8");
      const targetAbsolutePath = path.join(paths.wikiDir, entry.nextPath);
      await ensureDir(path.dirname(targetAbsolutePath));
      await fs.writeFile(targetAbsolutePath, stagedContent, "utf8");

      if (entry.changeType === "promote" && entry.previousPath) {
        await fs.rm(path.join(paths.wikiDir, entry.previousPath), { force: true });
      }

      const nextPage =
        bundleGraph?.pages.find((page) => page.id === entry.pageId && page.path === entry.nextPath) ??
        parseStoredPage(entry.nextPath, stagedContent);
      if (nextPage.kind === "output" && nextPage.outputAssets?.length) {
        const outputAssetDir = path.join(paths.wikiDir, "outputs", "assets", path.basename(nextPage.path, ".md"));
        await fs.rm(outputAssetDir, { recursive: true, force: true });
        for (const asset of nextPage.outputAssets) {
          const stagedAssetPath = path.join(paths.approvalsDir, approvalId, "wiki", asset.path);
          if (!(await fileExists(stagedAssetPath))) {
            continue;
          }
          const targetAssetPath = path.join(paths.wikiDir, asset.path);
          await ensureDir(path.dirname(targetAssetPath));
          await fs.copyFile(stagedAssetPath, targetAssetPath);
        }
      }
      nextPages = nextPages.filter(
        (page) => page.id !== entry.pageId && page.path !== entry.nextPath && (!entry.previousPath || page.path !== entry.previousPath)
      );
      nextPages.push(nextPage);
      updateCandidateHistory(compileState, nextPage);
    } else {
      const deletedPage =
        nextPages.find((page) => page.id === entry.pageId || page.path === entry.previousPath) ??
        bundleGraph?.pages.find((page) => page.id === entry.pageId || page.path === entry.previousPath) ??
        null;
      if (entry.previousPath) {
        await fs.rm(path.join(paths.wikiDir, entry.previousPath), { force: true });
      }
      if (deletedPage?.kind === "output") {
        await fs.rm(path.join(paths.wikiDir, "outputs", "assets", path.basename(deletedPage.path, ".md")), {
          recursive: true,
          force: true
        });
      }
      nextPages = nextPages.filter((page) => page.id !== entry.pageId && page.path !== entry.previousPath);
      updateCandidateHistory(compileState, deletedPage, true);
    }
    entry.status = "accepted";
  }

  const nextGraph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: currentGraph?.nodes ?? bundleGraph?.nodes ?? [],
    edges: currentGraph?.edges ?? bundleGraph?.edges ?? [],
    sources: currentGraph?.sources ?? bundleGraph?.sources ?? [],
    pages: sortGraphPages(nextPages)
  };
  compileState.generatedAt = nextGraph.generatedAt;

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextGraph.pages);
  await writeApprovalManifest(paths, manifest);
  await recordSession(rootDir, {
    operation: "review",
    title: `Accepted review entries from ${approvalId}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: selectedEntries.map((entry) => entry.pageId),
    changedPages: selectedEntries.flatMap((entry) =>
      [entry.nextPath, entry.previousPath].filter((value): value is string => Boolean(value))
    ),
    lines: selectedEntries.map((entry) => `accepted=${entry.pageId}`)
  });

  return {
    ...approvalSummary(manifest),
    updatedEntries: selectedEntries.map((entry) => entry.pageId)
  };
}

export async function rejectApproval(rootDir: string, approvalId: string, targets: string[] = []): Promise<ReviewActionResult> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const manifest = await readApprovalManifest(paths, approvalId);
  const selectedEntries = resolveApprovalTargets(manifest, targets);
  for (const entry of selectedEntries) {
    entry.status = "rejected";
  }
  await writeApprovalManifest(paths, manifest);
  await recordSession(rootDir, {
    operation: "review",
    title: `Rejected review entries from ${approvalId}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: selectedEntries.map((entry) => entry.pageId),
    changedPages: [],
    lines: selectedEntries.map((entry) => `rejected=${entry.pageId}`)
  });

  return {
    ...approvalSummary(manifest),
    updatedEntries: selectedEntries.map((entry) => entry.pageId)
  };
}

export async function listCandidates(rootDir: string): Promise<CandidateRecord[]> {
  const pages = await listPages(rootDir);
  return pages
    .filter(
      (page): page is GraphPage & { kind: "concept" | "entity" } =>
        page.status === "candidate" && (page.kind === "concept" || page.kind === "entity")
    )
    .map((page) => ({
      pageId: page.id,
      title: page.title,
      kind: page.kind,
      path: page.path,
      activePath: candidateActivePath(page),
      sourceIds: page.sourceIds,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
}

function resolveCandidateTarget(pages: GraphPage[], target: string): GraphPage {
  const candidate = pages.find((page) => page.status === "candidate" && (page.id === target || page.path === target));
  if (!candidate || (candidate.kind !== "concept" && candidate.kind !== "entity")) {
    throw new Error(`Candidate not found: ${target}`);
  }
  return candidate;
}

export async function promoteCandidate(rootDir: string, target: string): Promise<CandidateRecord> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const candidate = resolveCandidateTarget(graph?.pages ?? [], target);
  const raw = await fs.readFile(path.join(paths.wikiDir, candidate.path), "utf8");
  const parsed = matter(raw);
  const nextUpdatedAt = new Date().toISOString();
  const nextContent = matter.stringify(parsed.content, {
    ...parsed.data,
    status: "active",
    updated_at: nextUpdatedAt,
    tags: uniqueStrings([candidate.kind, ...((Array.isArray(parsed.data.tags) ? parsed.data.tags : []) as string[])]).filter(
      (tag) => tag !== "candidate"
    )
  });
  const nextPath = candidateActivePath(candidate);
  const nextAbsolutePath = path.join(paths.wikiDir, nextPath);
  await ensureDir(path.dirname(nextAbsolutePath));
  await fs.writeFile(nextAbsolutePath, nextContent, "utf8");
  await fs.rm(path.join(paths.wikiDir, candidate.path), { force: true });

  const nextPage = parseStoredPage(nextPath, nextContent, { createdAt: candidate.createdAt, updatedAt: nextUpdatedAt });
  const nextPages = sortGraphPages(
    (graph?.pages ?? []).filter((page) => page.id !== candidate.id && page.path !== candidate.path).concat(nextPage)
  );
  const nextGraph: GraphArtifact = {
    generatedAt: nextUpdatedAt,
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    sources: graph?.sources ?? [],
    pages: nextPages
  };
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();
  compileState.generatedAt = nextUpdatedAt;
  updateCandidateHistory(compileState, nextPage);

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextPages);
  await recordSession(rootDir, {
    operation: "candidate",
    title: `Promoted ${candidate.id}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: [candidate.id],
    changedPages: [candidate.path, nextPath],
    lines: [`promoted=${candidate.id}`]
  });

  return {
    pageId: nextPage.id,
    title: nextPage.title,
    kind: nextPage.kind as "concept" | "entity",
    path: nextPage.path,
    activePath: nextPage.path,
    sourceIds: nextPage.sourceIds,
    createdAt: nextPage.createdAt,
    updatedAt: nextPage.updatedAt
  };
}

export async function archiveCandidate(rootDir: string, target: string): Promise<CandidateRecord> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const candidate = resolveCandidateTarget(graph?.pages ?? [], target);
  await fs.rm(path.join(paths.wikiDir, candidate.path), { force: true });

  const nextPages = sortGraphPages((graph?.pages ?? []).filter((page) => page.id !== candidate.id && page.path !== candidate.path));
  const nextGraph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    sources: graph?.sources ?? [],
    pages: nextPages
  };
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();
  compileState.generatedAt = nextGraph.generatedAt;
  updateCandidateHistory(compileState, candidate, true);

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextPages);
  await recordSession(rootDir, {
    operation: "candidate",
    title: `Archived ${candidate.id}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: [candidate.id],
    changedPages: [candidate.path],
    lines: [`archived=${candidate.id}`]
  });

  return {
    pageId: candidate.id,
    title: candidate.title,
    kind: candidate.kind as "concept" | "entity",
    path: candidate.path,
    activePath: candidateActivePath(candidate),
    sourceIds: candidate.sourceIds,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  };
}

async function ensureObsidianWorkspace(rootDir: string): Promise<void> {
  const { config } = await loadVaultConfig(rootDir);
  const obsidianDir = path.join(rootDir, ".obsidian");
  const projectIds = projectEntries(config).map((project) => project.id);
  await ensureDir(obsidianDir);
  await Promise.all([
    writeJsonFile(path.join(obsidianDir, "app.json"), {
      alwaysUpdateLinks: true,
      newFileLocation: "folder",
      newFileFolderPath: "wiki/insights",
      useMarkdownLinks: false,
      attachmentFolderPath: "raw/assets"
    }),
    writeJsonFile(path.join(obsidianDir, "core-plugins.json"), [
      "file-explorer",
      "global-search",
      "switcher",
      "graph",
      "backlink",
      "outgoing-link",
      "tag-pane",
      "page-preview"
    ]),
    writeJsonFile(path.join(obsidianDir, "graph.json"), {
      "collapse-filter": false,
      search: "",
      showTags: true,
      showAttachments: false,
      hideUnresolved: false,
      colorGroups: projectIds.map((projectId, index) => ({
        query: `tag:#project/${projectId}`,
        color: ["#0ea5e9", "#22c55e", "#f59e0b", "#fb7185", "#8b5cf6", "#14b8a6"][index % 6]
      })),
      localJumps: false
    }),
    writeJsonFile(path.join(obsidianDir, "workspace.json"), {
      active: "root",
      lastOpenFiles: ["wiki/index.md", "wiki/projects/index.md", "wiki/candidates/index.md", "wiki/insights/index.md"],
      left: {
        collapsed: false
      },
      right: {
        collapsed: false
      }
    })
  ]);
}

export async function initVault(rootDir: string, options: InitOptions = {}): Promise<void> {
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
        project_ids: [],
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
  await writeFileIfChanged(
    path.join(paths.wikiDir, "projects", "index.md"),
    matter.stringify(["# Projects", "", "- Run `swarmvault compile` to build project rollups.", ""].join("\n"), {
      page_id: "projects:index",
      kind: "index",
      title: "Projects",
      tags: ["index", "projects"],
      source_ids: [],
      project_ids: [],
      node_ids: [],
      freshness: "fresh",
      status: "active",
      confidence: 1,
      created_at: now,
      updated_at: now,
      compiled_from: [],
      managed_by: "system",
      backlinks: [],
      schema_hash: "",
      source_hashes: {}
    })
  );
  await writeFileIfChanged(
    path.join(paths.wikiDir, "candidates", "index.md"),
    matter.stringify(["# Candidates", "", "- Run `swarmvault compile` to stage candidate pages.", ""].join("\n"), {
      page_id: "candidates:index",
      kind: "index",
      title: "Candidates",
      tags: ["index", "candidates"],
      source_ids: [],
      project_ids: [],
      node_ids: [],
      freshness: "fresh",
      status: "active",
      confidence: 1,
      created_at: now,
      updated_at: now,
      compiled_from: [],
      managed_by: "system",
      backlinks: [],
      schema_hash: "",
      source_hashes: {}
    })
  );
  if (options.obsidian) {
    await ensureObsidianWorkspace(rootDir);
  }
}

export async function compileVault(rootDir: string, options: CompileOptions = {}): Promise<CompileResult> {
  const startedAt = new Date().toISOString();
  const { config, paths } = await initWorkspace(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const provider = await getProviderForTask(rootDir, "compileProvider");
  const manifests = await listManifests(rootDir);
  const sourceProjects = resolveSourceProjects(rootDir, manifests, config);
  const storedOutputPages = await loadSavedOutputPages(paths.wikiDir);
  const storedInsightPages = await loadInsightPages(paths.wikiDir);
  const outputPages = storedOutputPages.map((page) => page.page);
  const insightPages = storedInsightPages.map((page) => page.page);
  const currentOutputHashes = pageHashes(storedOutputPages);
  const currentInsightHashes = pageHashes(storedInsightPages);

  const previousState = await readJsonFile<CompileState>(paths.compileStatePath);
  const rootSchemaChanged = !previousState || previousState.rootSchemaHash !== schemas.root.hash;
  const effectiveSchemaChanged =
    !previousState ||
    previousGlobalSchemaHash(previousState) !== schemas.effective.global.hash ||
    uniqueStrings([...Object.keys(previousState?.effectiveSchemaHashes?.projects ?? {}), ...Object.keys(schemas.effective.projects)]).some(
      (projectId) => previousProjectSchemaHash(previousState, projectId) !== effectiveHashForProject(schemas, projectId)
    );
  const nextProjectConfigHash = projectConfigHash(config);
  const projectConfigChanged = !previousState || previousState.projectConfigHash !== nextProjectConfigHash;
  const previousSourceHashes = previousState?.sourceHashes ?? {};
  const previousAnalyses = previousState?.analyses ?? {};
  const previousSourceProjects = previousState?.sourceProjects ?? {};
  const previousOutputHashes = previousState?.outputHashes ?? {};
  const previousInsightHashes = previousState?.insightHashes ?? {};
  const currentSourceIds = new Set(manifests.map((item) => item.sourceId));
  const previousSourceIds = new Set(Object.keys(previousSourceHashes));
  const sourcesChanged =
    currentSourceIds.size !== previousSourceIds.size || [...currentSourceIds].some((sourceId) => !previousSourceIds.has(sourceId));
  const outputsChanged = !recordsEqual(currentOutputHashes, previousOutputHashes);
  const insightsChanged = !recordsEqual(currentInsightHashes, previousInsightHashes);
  const artifactsExist = await requiredCompileArtifactsExist(paths);
  const pendingCandidatePromotion = Object.values(previousState?.candidateHistory ?? {}).some((entry) => entry.status === "candidate");

  const dirty: SourceManifest[] = [];
  const clean: SourceManifest[] = [];
  for (const manifest of manifests) {
    const hashChanged = previousSourceHashes[manifest.sourceId] !== manifest.contentHash;
    const noAnalysis = !previousAnalyses[manifest.sourceId];
    const projectId = sourceProjects[manifest.sourceId] ?? null;
    const projectChanged = (previousSourceProjects[manifest.sourceId] ?? null) !== projectId;
    const effectiveHashChanged = previousProjectSchemaHash(previousState, projectId) !== effectiveHashForProject(schemas, projectId);
    if (hashChanged || noAnalysis || projectChanged || effectiveHashChanged) {
      dirty.push(manifest);
    } else {
      clean.push(manifest);
    }
  }

  if (
    dirty.length === 0 &&
    !rootSchemaChanged &&
    !effectiveSchemaChanged &&
    !projectConfigChanged &&
    !sourcesChanged &&
    !outputsChanged &&
    !insightsChanged &&
    !pendingCandidatePromotion &&
    artifactsExist &&
    !options.approve
  ) {
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
        `schema=${schemas.effective.global.hash.slice(0, 12)}`
      ]
    });
    return {
      graphPath: paths.graphPath,
      pageCount: graph?.pages.length ?? outputPages.length + insightPages.length,
      changedPages: [],
      sourceCount: manifests.length,
      staged: false,
      promotedPageIds: [],
      candidatePageCount: (graph?.pages ?? []).filter((page) => page.status === "candidate").length
    };
  }

  const [dirtyAnalyses, cleanAnalyses] = await Promise.all([
    Promise.all(
      dirty.map(async (manifest) =>
        analyzeSource(
          manifest,
          await readExtractedText(rootDir, manifest),
          provider,
          paths,
          getEffectiveSchema(schemas, sourceProjects[manifest.sourceId] ?? null)
        )
      )
    ),
    Promise.all(
      clean.map(async (manifest) => {
        const cached = await readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${manifest.sourceId}.json`));
        if (cached) {
          return cached;
        }
        return analyzeSource(
          manifest,
          await readExtractedText(rootDir, manifest),
          provider,
          paths,
          getEffectiveSchema(schemas, sourceProjects[manifest.sourceId] ?? null)
        );
      })
    )
  ]);

  const initialAnalyses = [...dirtyAnalyses, ...cleanAnalyses];
  const codeIndex = await buildCodeIndex(rootDir, manifests, initialAnalyses);
  const analyses = await Promise.all(
    initialAnalyses.map(async (analysis) => {
      const manifest = manifests.find((item) => item.sourceId === analysis.sourceId);
      if (!manifest || !analysis.code) {
        return analysis;
      }
      const enriched = enrichResolvedCodeImports(manifest, analysis, codeIndex);
      if (analysisSignature(enriched) !== analysisSignature(analysis)) {
        await writeJsonFile(path.join(paths.analysesDir, `${analysis.sourceId}.json`), enriched);
      }
      return enriched;
    })
  );

  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "code")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs")),
    ensureDir(path.join(paths.wikiDir, "projects")),
    ensureDir(path.join(paths.wikiDir, "insights")),
    ensureDir(path.join(paths.wikiDir, "candidates")),
    ensureDir(path.join(paths.wikiDir, "candidates", "concepts")),
    ensureDir(path.join(paths.wikiDir, "candidates", "entities"))
  ]);
  const sync = await syncVaultArtifacts(rootDir, {
    schemas,
    manifests,
    analyses,
    codeIndex,
    sourceProjects,
    outputPages,
    insightPages,
    outputHashes: currentOutputHashes,
    insightHashes: currentInsightHashes,
    previousState,
    approve: options.approve
  });
  let postPassApprovalId: string | undefined;
  let postPassApprovalDir: string | undefined;
  if (!options.approve && !sync.staged && config.orchestration?.compilePostPass) {
    const roleResults = await runConfiguredRoles(rootDir, ["context", "safety"], {
      title: "Compile post-pass",
      instructions:
        "Review the compiled vault and optionally propose markdown page updates. Proposals must be complete markdown files with frontmatter.",
      context: [
        `Pages: ${sync.allPages.length}`,
        `Changed pages: ${sync.changedPages.join(", ") || "none"}`,
        "",
        sync.allPages
          .slice(0, 18)
          .map((page) => [`# ${page.title}`, `path=${page.path}`, `kind=${page.kind}`, `status=${page.status}`].join("\n"))
          .join("\n\n---\n\n")
      ].join("\n")
    });
    const proposals = roleResults
      .flatMap((result) => result.proposals)
      .map((proposal) => ({
        ...proposal,
        path: toPosix(proposal.path.replace(/^wiki\//, "").replace(/^\/+/, ""))
      }))
      .filter((proposal) => proposal.path.endsWith(".md"))
      .filter((proposal) => !proposal.path.startsWith("insights/"))
      .filter((proposal) => !proposal.path.startsWith("../"));

    if (proposals.length) {
      const proposedPages = proposals.map((proposal) => parseStoredPage(proposal.path, proposal.content));
      const proposalGraph: GraphArtifact = {
        ...sync.graph,
        generatedAt: new Date().toISOString(),
        pages: sortGraphPages(
          sync.graph.pages
            .filter((page) => !proposedPages.some((proposalPage) => proposalPage.id === page.id || proposalPage.path === page.path))
            .concat(proposedPages)
        )
      };
      const staged = await stageApprovalBundle(
        paths,
        proposals.map((proposal) => ({ relativePath: proposal.path, content: proposal.content })),
        [],
        sync.graph,
        proposalGraph
      );
      postPassApprovalId = staged.approvalId;
      postPassApprovalDir = staged.approvalDir;
    }
  }

  await recordSession(rootDir, {
    operation: "compile",
    title: `Compiled ${manifests.length} source(s)`,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: manifests.map((manifest) => manifest.sourceId),
    relatedPageIds: sync.allPages.map((page) => page.id),
    changedPages: sync.changedPages,
    lines: [
      `provider=${provider.id}`,
      `pages=${sync.allPages.length}`,
      `dirty=${dirty.length}`,
      `clean=${clean.length}`,
      `outputs=${outputPages.length}`,
      `insights=${insightPages.length}`,
      `candidates=${sync.candidatePageCount}`,
      `promoted=${sync.promotedPageIds.length}`,
      `staged=${sync.staged}`,
      `postPassApproval=${postPassApprovalId ?? "none"}`,
      `schema=${schemas.effective.global.hash.slice(0, 12)}`
    ]
  });

  return {
    graphPath: paths.graphPath,
    pageCount: sync.allPages.length,
    changedPages: sync.changedPages,
    sourceCount: manifests.length,
    staged: sync.staged,
    approvalId: sync.approvalId,
    approvalDir: sync.approvalDir,
    postPassApprovalId,
    postPassApprovalDir,
    promotedPageIds: sync.promotedPageIds,
    candidatePageCount: sync.candidatePageCount
  };
}

export async function queryVault(rootDir: string, options: QueryOptions): Promise<QueryResult> {
  const startedAt = new Date().toISOString();
  const save = options.save ?? true;
  const review = options.review ?? false;
  const outputFormat = normalizeOutputFormat(options.format);
  const schemas = await loadVaultSchemas(rootDir);
  const query = await executeQuery(rootDir, options.question, outputFormat);
  let savedPath: string | undefined;
  let stagedPath: string | undefined;
  let savedPageId: string | undefined;
  let approvalId: string | undefined;
  let approvalDir: string | undefined;
  let outputAssets: OutputAsset[] = [];

  if (save) {
    const assetBundle = await generateOutputArtifacts(rootDir, {
      slug: slugify(options.question),
      title: options.question,
      question: options.question,
      answer: query.answer,
      citations: query.citations,
      format: outputFormat,
      relatedPageCount: query.relatedPageIds.length,
      relatedNodeCount: query.relatedNodeIds.length,
      projectId: query.projectIds[0] ?? null
    });
    outputAssets = assetBundle.outputAssets;
    const outputInput = {
      question: options.question,
      answer: assetBundle.answer,
      citations: query.citations,
      schemaHash: query.schemaHash,
      outputFormat,
      outputAssets: assetBundle.outputAssets,
      relatedPageIds: query.relatedPageIds,
      relatedNodeIds: query.relatedNodeIds,
      relatedSourceIds: query.relatedSourceIds,
      projectIds: query.projectIds,
      extraTags: categoryTagsForSchema(getEffectiveSchema(schemas, query.projectIds[0] ?? null), [options.question, assetBundle.answer]),
      origin: "query"
    } satisfies Omit<Parameters<typeof buildOutputPage>[0], "metadata">;
    if (review) {
      const staged = await prepareOutputPageSave(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      const approval = await stageOutputApprovalBundle(rootDir, [
        {
          page: staged.page,
          content: staged.content,
          assetFiles: staged.assetFiles
        }
      ]);
      stagedPath = path.join(approval.approvalDir, "wiki", staged.page.path);
      savedPageId = staged.page.id;
      approvalId = approval.approvalId;
      approvalDir = approval.approvalDir;
    } else {
      const saved = await persistOutputPage(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      await refreshVaultAfterOutputSave(rootDir);
      savedPath = saved.savedPath;
      savedPageId = saved.page.id;
    }
  }

  const provider = await getProviderForTask(rootDir, "queryProvider");
  await recordSession(rootDir, {
    operation: "query",
    title: options.question,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: query.relatedSourceIds,
    relatedPageIds: savedPageId ? [...query.relatedPageIds, savedPageId] : query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    citations: query.citations,
    tokenUsage: query.usage,
    lines: [
      `citations=${query.citations.join(",") || "none"}`,
      `saved=${Boolean(savedPath)}`,
      `staged=${Boolean(stagedPath)}`,
      `format=${outputFormat}`,
      `rawSources=${query.relatedSourceIds.length}`
    ]
  });

  return {
    answer: query.answer,
    savedPath,
    stagedPath,
    savedPageId,
    citations: query.citations,
    relatedPageIds: query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    relatedSourceIds: query.relatedSourceIds,
    outputFormat,
    saved: Boolean(savedPath),
    staged: Boolean(stagedPath),
    approvalId,
    approvalDir,
    outputAssets
  };
}

export async function exploreVault(rootDir: string, options: ExploreOptions): Promise<ExploreResult> {
  const startedAt = new Date().toISOString();
  const stepLimit = Math.max(1, options.steps ?? 3);
  const outputFormat = normalizeOutputFormat(options.format);
  const review = options.review ?? false;
  const schemas = await loadVaultSchemas(rootDir);
  const stepResults: ExploreStepResult[] = [];
  const stepPages: GraphPage[] = [];
  const stagedStepPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"] }> = [];
  const visited = new Set<string>();
  const suggestedQuestions: string[] = [];
  const relatedPageIds = new Set<string>();
  const relatedNodeIds = new Set<string>();
  const relatedSourceIds = new Set<string>();
  const tokenUsage = {
    inputTokens: 0,
    outputTokens: 0
  };
  let currentQuestion = options.question;
  let approvalId: string | undefined;
  let approvalDir: string | undefined;

  for (let step = 1; step <= stepLimit; step++) {
    const normalizedQuestion = normalizeWhitespace(currentQuestion).toLowerCase();
    if (!normalizedQuestion || visited.has(normalizedQuestion)) {
      break;
    }

    visited.add(normalizedQuestion);
    const query = await executeQuery(rootDir, currentQuestion, outputFormat);
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
    const roleResults = await runConfiguredRoles(rootDir, ["research", "context", "safety"], {
      title: currentQuestion,
      instructions:
        "Review this exploration step. Research should suggest follow-up questions, context should highlight cross-links, and safety should flag caveats.",
      context: [
        `Question: ${currentQuestion}`,
        "",
        "Answer:",
        query.answer,
        "",
        `Related pages: ${query.relatedPageIds.join(", ") || "none"}`,
        `Related nodes: ${query.relatedNodeIds.join(", ") || "none"}`,
        `Citations: ${query.citations.join(", ") || "none"}`
      ].join("\n")
    });
    const orchestrationNotes = roleResults.flatMap((result) => result.findings.map((finding) => `- [${result.role}] ${finding.message}`));
    const enrichedAnswer = orchestrationNotes.length
      ? `${query.answer}\n\n## Agent Review\n\n${orchestrationNotes.join("\n")}\n`
      : query.answer;
    const assetBundle = await generateOutputArtifacts(rootDir, {
      slug: `explore-${slugify(options.question)}-step-${step}`,
      title: `Explore Step ${step}: ${currentQuestion}`,
      question: currentQuestion,
      answer: enrichedAnswer,
      citations: query.citations,
      format: outputFormat,
      relatedPageCount: query.relatedPageIds.length,
      relatedNodeCount: query.relatedNodeIds.length,
      projectId: query.projectIds[0] ?? null
    });
    const outputInput = {
      title: `Explore Step ${step}: ${currentQuestion}`,
      question: currentQuestion,
      answer: assetBundle.answer,
      citations: query.citations,
      schemaHash: query.schemaHash,
      outputFormat,
      outputAssets: assetBundle.outputAssets,
      relatedPageIds: query.relatedPageIds,
      relatedNodeIds: query.relatedNodeIds,
      relatedSourceIds: query.relatedSourceIds,
      projectIds: query.projectIds,
      extraTags: categoryTagsForSchema(getEffectiveSchema(schemas, query.projectIds[0] ?? null), [currentQuestion, assetBundle.answer]),
      origin: "explore",
      slug: `explore-${slugify(options.question)}-step-${step}`
    } satisfies Omit<Parameters<typeof buildOutputPage>[0], "metadata">;
    let savedPathForStep: string | undefined;
    let stagedPathForStep: string | undefined;
    let savedPage: GraphPage;
    let savedAssets: OutputAsset[];
    if (review) {
      const staged = await prepareOutputPageSave(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      stagedStepPages.push({
        page: staged.page,
        content: staged.content,
        assetFiles: staged.assetFiles
      });
      savedPage = staged.page;
      savedAssets = staged.outputAssets;
      stagedPathForStep = staged.savedPath;
    } else {
      const saved = await persistOutputPage(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      savedPage = saved.page;
      savedAssets = saved.outputAssets;
      savedPathForStep = saved.savedPath;
    }

    const followUpQuestions = uniqueBy(
      [...(await generateFollowUpQuestions(rootDir, currentQuestion, enrichedAnswer)), ...summarizeRoleQuestions(roleResults)],
      (item) => item
    );
    stepResults.push({
      step,
      question: currentQuestion,
      answer: enrichedAnswer,
      savedPath: savedPathForStep,
      stagedPath: stagedPathForStep,
      savedPageId: savedPage.id,
      citations: query.citations,
      followUpQuestions,
      outputFormat,
      outputAssets: savedAssets
    });
    stepPages.push(savedPage);
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
  const hubAssetBundle = await generateOutputArtifacts(rootDir, {
    slug: `explore-${slugify(options.question)}`,
    title: `Explore: ${options.question}`,
    question: options.question,
    answer: stepResults.map((step) => step.answer).join("\n\n"),
    citations: allCitations,
    format: outputFormat,
    relatedPageCount: stepPages.length,
    relatedNodeCount: uniqueStrings(stepPages.flatMap((page) => page.nodeIds)).length,
    projectId: stepPages[0]?.projectIds[0] ?? null
  });
  const hubInput = {
    question: options.question,
    stepPages,
    followUpQuestions: uniqueBy(suggestedQuestions, (item) => item),
    citations: allCitations,
    schemaHash: composeVaultSchema(
      schemas.root,
      uniqueStrings(stepPages.flatMap((page) => page.projectIds).sort((left, right) => left.localeCompare(right)))
        .map((projectId) => schemas.projects[projectId])
        .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema?.hash))
    ).hash,
    outputFormat,
    outputAssets: hubAssetBundle.outputAssets,
    projectIds: scopedProjectIdsFromSources(
      allCitations,
      Object.fromEntries(stepPages.flatMap((page) => page.sourceIds.map((sourceId) => [sourceId, page.projectIds[0] ?? null])))
    ),
    extraTags: categoryTagsForSchema(schemas.effective.global, [options.question, ...stepResults.map((step) => step.answer)]),
    slug: `explore-${slugify(options.question)}`
  } satisfies Omit<Parameters<typeof buildExploreHubPage>[0], "metadata">;
  let hubPath: string | undefined;
  let stagedHubPath: string | undefined;
  let hubPage: GraphPage;
  let hubAssets: OutputAsset[];
  let stagedHubRecord: (PersistedOutputPageResult & { content: string; assetFiles: GeneratedOutputArtifacts["assetFiles"] }) | undefined;
  if (review) {
    stagedHubRecord = await prepareExploreHubSave(rootDir, {
      ...hubInput,
      assetFiles: hubAssetBundle.assetFiles
    });
    hubPage = stagedHubRecord.page;
    hubAssets = stagedHubRecord.outputAssets;
    stagedHubPath = stagedHubRecord.savedPath;
  } else {
    const savedHub = await persistExploreHub(rootDir, {
      ...hubInput,
      assetFiles: hubAssetBundle.assetFiles
    });
    hubPage = savedHub.page;
    hubAssets = savedHub.outputAssets;
    hubPath = savedHub.savedPath;
  }
  if (review) {
    const approval = await stageOutputApprovalBundle(rootDir, [
      ...stagedStepPages,
      {
        page: stagedHubRecord?.page ?? hubPage,
        content: stagedHubRecord?.content ?? "",
        assetFiles: stagedHubRecord?.assetFiles
      }
    ]);
    approvalId = approval.approvalId;
    approvalDir = approval.approvalDir;
    stepResults.forEach((result, index) => {
      result.stagedPath = path.join(approval.approvalDir as string, "wiki", stagedStepPages[index]?.page.path ?? "");
    });
    stagedHubPath = path.join(approval.approvalDir, "wiki", hubPage.path);
  } else {
    await refreshVaultAfterOutputSave(rootDir);
  }

  const provider = await getProviderForTask(rootDir, "queryProvider");
  await recordSession(rootDir, {
    operation: "explore",
    title: options.question,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: [...relatedSourceIds],
    relatedPageIds: uniqueStrings([...relatedPageIds, ...stepPages.map((page) => page.id), hubPage.id]),
    relatedNodeIds: [...relatedNodeIds],
    citations: allCitations,
    tokenUsage:
      tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0
        ? {
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens
          }
        : undefined,
    lines: [
      `steps=${stepResults.length}`,
      `hub=${hubPage.id}`,
      `format=${outputFormat}`,
      `citations=${allCitations.join(",") || "none"}`,
      `staged=${review}`
    ]
  });

  return {
    rootQuestion: options.question,
    hubPath,
    stagedHubPath,
    hubPageId: hubPage.id,
    stepCount: stepResults.length,
    steps: stepResults,
    suggestedQuestions: uniqueBy(suggestedQuestions, (item) => item),
    outputFormat,
    staged: review,
    approvalId,
    approvalDir,
    hubAssets
  };
}

export async function searchVault(rootDir: string, query: string, limit = 5): Promise<SearchResult[]> {
  const { paths } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir, {});
  }

  return searchPages(paths.searchDbPath, query, limit);
}

async function ensureCompiledGraph(rootDir: string): Promise<GraphArtifact> {
  const { paths } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.searchDbPath)) || !(await fileExists(paths.graphPath))) {
    await compileVault(rootDir, {});
  }
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` first.");
  }
  return graph;
}

export async function queryGraphVault(
  rootDir: string,
  question: string,
  options: {
    traversal?: "bfs" | "dfs";
    budget?: number;
  } = {}
): Promise<GraphQueryResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await ensureCompiledGraph(rootDir);
  const searchResults = searchPages(paths.searchDbPath, question, { limit: Math.max(5, options.budget ?? 10) });
  return queryGraph(graph, question, searchResults, options);
}

export async function benchmarkVault(rootDir: string, options: BenchmarkOptions = {}): Promise<BenchmarkArtifact> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await ensureCompiledGraph(rootDir);
  const manifests = await listManifests(rootDir);
  const pageContentsById = new Map<string, string>();
  let corpusWords = 0;

  for (const manifest of manifests) {
    const extractedText = await readExtractedText(rootDir, manifest);
    if (extractedText) {
      corpusWords += estimateCorpusWords([extractedText]);
    }
  }

  for (const page of graph.pages) {
    const absolutePath = path.join(paths.wikiDir, page.path);
    if (!(await fileExists(absolutePath))) {
      continue;
    }
    const parsed = matter(await fs.readFile(absolutePath, "utf8"));
    pageContentsById.set(page.id, parsed.content);
  }

  const questions = (options.questions ?? []).map((question) => normalizeWhitespace(question)).filter(Boolean);
  const sampleQuestions = questions.length ? questions : [...DEFAULT_BENCHMARK_QUESTIONS];
  const perQuestion = sampleQuestions.map((question) => {
    const searchResults = searchPages(paths.searchDbPath, question, { limit: 12 });
    const result = queryGraph(graph, question, searchResults, { budget: 12 });
    const metrics = benchmarkQueryTokens(graph, result, pageContentsById);
    return {
      question,
      queryTokens: metrics.queryTokens,
      reduction: metrics.reduction,
      visitedNodeIds: result.visitedNodeIds,
      pageIds: result.pageIds
    };
  });

  const artifact = buildBenchmarkArtifact({
    graph,
    corpusWords,
    questions: sampleQuestions,
    perQuestion
  });

  await writeJsonFile(paths.benchmarkPath, artifact);
  await refreshIndexesAndSearch(rootDir, graph.pages);
  return artifact;
}

export async function pathGraphVault(rootDir: string, from: string, to: string): Promise<GraphPathResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return shortestGraphPath(graph, from, to);
}

export async function explainGraphVault(rootDir: string, target: string): Promise<GraphExplainResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return explainGraphTarget(graph, target);
}

export async function listGodNodes(rootDir: string, limit = 10): Promise<GraphNode[]> {
  const graph = await ensureCompiledGraph(rootDir);
  return topGodNodes(graph, limit);
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
  schemas: LoadedVaultSchemas,
  manifests: SourceManifest[],
  sourceProjects: Record<string, string | null>
): Promise<LintFinding[]> {
  const manifestMap = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  const pageMap = new Map(graph.pages.map((page) => [page.id, page]));
  return Promise.all(
    graph.pages.map(async (page) => {
      const findings: LintFinding[] = [];

      if (page.kind === "insight") {
        return findings;
      }

      if (page.schemaHash !== expectedSchemaHashForPage(page, schemas, pageMap, sourceProjects)) {
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

  const { config, paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const manifests = await listManifests(rootDir);
  const sourceProjects = resolveSourceProjects(rootDir, manifests, config);
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

  const findings = await structuralLintFindings(rootDir, paths, graph, schemas, manifests, sourceProjects);
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
  const compile = await compileVault(rootDir, {});
  return {
    manifestId: manifest.sourceId,
    compile
  };
}
