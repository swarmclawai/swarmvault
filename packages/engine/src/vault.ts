import fs from "node:fs/promises";
import path from "node:path";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import matter from "gray-matter";
import { z } from "zod";
import { installConfiguredAgents } from "./agents.js";
import { analysisSignature, analyzeSource } from "./analysis.js";
import {
  benchmarkQueryTokens,
  buildBenchmarkArtifact,
  defaultBenchmarkQuestionsForGraph,
  estimateCorpusWords,
  graphHash
} from "./benchmark.js";
import { buildCodeIndex, enrichResolvedCodeImports, modulePageTitle } from "./code-analysis.js";
import { conflictConfidence, edgeConfidence, nodeConfidence } from "./confidence.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { runDeepLint } from "./deep-lint.js";
import { embeddingSimilarityEdges, semanticGraphMatches, semanticPageSearch } from "./embeddings.js";
import { enrichGraph } from "./graph-enrichment.js";
import { blastRadius, explainGraphTarget, listHyperedges, queryGraph, shortestGraphPath, topGodNodes } from "./graph-tools.js";
import { ingestInput, listManifests, readExtractedText } from "./ingest.js";
import { recordSession } from "./logs.js";
import {
  buildAggregatePage,
  buildCommunitySummaryPage,
  buildExploreHubPage,
  buildGraphReportArtifact,
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
import { mergeSearchResults, rebuildSearchIndex, searchPages } from "./search.js";
import { aggregateManifestSourceClass } from "./source-classification.js";
import { listGuidedSourceSessions, updateGuidedSourceSessionStatus } from "./source-sessions.js";
import type {
  ApprovalBundleType,
  ApprovalChangeType,
  ApprovalDetail,
  ApprovalEntry,
  ApprovalEntryDetail,
  ApprovalEntryLabel,
  ApprovalManifest,
  ApprovalSummary,
  BenchmarkArtifact,
  BenchmarkOptions,
  BlastRadiusResult,
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
  GraphHyperedge,
  GraphNode,
  GraphPage,
  GraphPathResult,
  GraphQueryResult,
  GraphReportArtifact,
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
  SourceClass,
  SourceManifest,
  VaultConfig
} from "./types.js";
import {
  ensureDir,
  fileExists,
  isPathWithin,
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

const COMPILE_PROGRESS_THRESHOLD = 120;
const COMPILE_PROGRESS_UPDATE_INTERVAL = 50;

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function createCompileProgressReporter(
  phase: string,
  totalItems: number
): { tick: (label?: string) => void; finish: (summary?: string) => void } {
  if (totalItems < COMPILE_PROGRESS_THRESHOLD || !process.stderr?.isTTY) {
    return {
      tick: () => {},
      finish: () => {}
    };
  }

  let completed = 0;
  let nextUpdate = Math.min(COMPILE_PROGRESS_UPDATE_INTERVAL, totalItems);
  process.stderr.write(`[swarmvault compile] ${phase}: 0/${totalItems}\n`);

  return {
    tick: (label) => {
      completed += 1;
      if (completed >= nextUpdate || completed === totalItems) {
        process.stderr.write(`[swarmvault compile] ${phase}: ${completed}/${totalItems}${label ? ` (${label})` : ""}\n`);
        while (completed >= nextUpdate) {
          nextUpdate += COMPILE_PROGRESS_UPDATE_INTERVAL;
        }
      }
    },
    finish: (summary) => {
      process.stderr.write(`[swarmvault compile] ${phase}: ${totalItems}/${totalItems}${summary ? ` (${summary})` : ""}\n`);
    }
  };
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
    bundleType: manifest.bundleType,
    title: manifest.title,
    sourceSessionId: manifest.sourceSessionId,
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
  build: (metadata: ManagedGraphPageMetadata, existingContent?: string | null) => { page: GraphPage; content: string }
): Promise<{ page: GraphPage; content: string }> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  let carriedContent = existingContent;
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
      carriedContent = await fs.readFile(candidatePath, "utf8");
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
  let built = build(metadata, carriedContent);

  if (carriedContent && carriedContent !== built.content) {
    metadata = {
      ...metadata,
      updatedAt: new Date().toISOString()
    };
    built = build(metadata, carriedContent);
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

function manifestDetailValue(manifest: SourceManifest, key: string): string | undefined {
  const value = manifest.details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadAnalysesBySourceIds(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  sourceIds: string[]
): Promise<SourceAnalysis[]> {
  const analyses = await Promise.all(
    sourceIds.map(async (sourceId) => await readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${sourceId}.json`)))
  );
  return analyses.filter((analysis): analysis is SourceAnalysis => Boolean(analysis?.sourceId));
}

async function buildDashboardRecords(
  config: VaultConfig,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  graph: GraphArtifact,
  schemaHash: string,
  report: GraphReportArtifact | null
): Promise<ManagedPageRecord[]> {
  const dataviewEnabled = config.profile.dataviewBlocks;
  const profilePresets = config.profile.presets;
  const dashboardPack = config.profile.dashboardPack;
  const sourcePages = graph.pages.filter((page) => page.kind === "source");
  const reviewPages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-reviews/"));
  const briefPages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-briefs/"));
  const guidePages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-guides/"));
  const sessionPages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-sessions/"));
  const conceptPages = graph.pages.filter((page) => page.kind === "concept" && page.status !== "candidate").slice(0, 16);
  const entityPages = graph.pages.filter((page) => page.kind === "entity" && page.status !== "candidate").slice(0, 16);
  const manifests = graph.sources;
  const manifestBySourceId = new Map(manifests.map((manifest) => [manifest.sourceId, manifest] as const));
  const timelineManifests = manifests
    .filter((manifest) => manifestDetailValue(manifest, "occurred_at"))
    .sort((left, right) => (manifestDetailValue(right, "occurred_at") ?? "").localeCompare(manifestDetailValue(left, "occurred_at") ?? ""))
    .slice(0, 25);
  const recentSourcePages = [...sourcePages].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 20);
  const analyses = await loadAnalysesBySourceIds(paths, uniqueStrings(sourcePages.flatMap((page) => page.sourceIds)));
  const openQuestions = uniqueStrings(
    analyses.flatMap((analysis) => analysis.questions.map((question) => `${analysis.title}: ${question}`))
  ).slice(0, 20);
  const sourceSessions = await listGuidedSourceSessions(paths.rootDir);
  const stagedGuideBundles = (
    await Promise.all(
      (
        await fs.readdir(paths.approvalsDir, { withFileTypes: true }).catch(() => [])
      )
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => await readApprovalManifest(paths, entry.name).catch(() => null))
    )
  )
    .filter((manifest): manifest is ApprovalManifest => Boolean(manifest))
    .filter((manifest) => manifest.bundleType === "guided-source" || manifest.bundleType === "guided-session")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12);
  const readerFocusPages = uniqueBy([...guidePages, ...briefPages, ...conceptPages, ...entityPages], (page) => page.id).slice(0, 8);
  const diligenceSessions = sourceSessions
    .filter((session) => session.status === "staged" || session.status === "awaiting_input")
    .slice(0, 8);

  const dashboards: Array<{ relativePath: string; title: string; content: (metadata: ManagedPageMetadata) => string }> = [
    {
      relativePath: "dashboards/index.md",
      title: "Dashboards",
      content: (metadata) =>
        matter.stringify(
          [
            "# Dashboards",
            "",
            "- [[dashboards/recent-sources|Recent Sources]]",
            "- [[dashboards/reading-log|Reading Log]]",
            "- [[dashboards/timeline|Timeline]]",
            "- [[dashboards/source-sessions|Source Sessions]]",
            "- [[dashboards/source-guides|Source Guides]]",
            "- [[dashboards/research-map|Research Map]]",
            "- [[dashboards/contradictions|Contradictions]]",
            "- [[dashboards/open-questions|Open Questions]]",
            "",
            `Profile Presets: ${profilePresets.length ? profilePresets.map((preset) => `\`${preset}\``).join(", ") : "_default_"}`,
            `Dashboard Pack: \`${dashboardPack}\``,
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE file.mtime AS updated",
                  'FROM "dashboards"',
                  'WHERE file.name != "index"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:index",
            kind: "index",
            title: "Dashboards",
            tags: ["index", "dashboards"],
            source_ids: [],
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: metadata.compiledFrom,
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/recent-sources.md",
      title: "Recent Sources",
      content: (metadata) =>
        matter.stringify(
          [
            "# Recent Sources",
            "",
            ...(recentSourcePages.length
              ? recentSourcePages.map((page) => `- ${page.updatedAt}: [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No source pages yet."]),
            ...(dashboardPack === "reader" && readerFocusPages.length
              ? ["", "## Reader Focus", "", ...readerFocusPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE source_type, occurred_at, participants",
                  'FROM "sources"',
                  "SORT updated_at desc",
                  "LIMIT 25",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:recent-sources",
            kind: "index",
            title: "Recent Sources",
            tags: ["index", "dashboard", "recent-sources"],
            source_ids: recentSourcePages.flatMap((page) => page.sourceIds),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: recentSourcePages.flatMap((page) => page.sourceIds),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/reading-log.md",
      title: "Reading Log",
      content: (metadata) =>
        matter.stringify(
          [
            "# Reading Log",
            "",
            ...(timelineManifests.length
              ? timelineManifests.map((manifest) => {
                  const occurredAt = manifestDetailValue(manifest, "occurred_at") ?? manifest.updatedAt;
                  const participants = manifestDetailValue(manifest, "participants");
                  return `- ${occurredAt}: ${manifest.title}${participants ? ` (${participants})` : ""}`;
                })
              : recentSourcePages.map((page) => `- ${page.updatedAt}: [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)),
            ...(sourceSessions.length
              ? [
                  "",
                  "## Active Guided Sessions",
                  "",
                  ...sourceSessions
                    .slice(0, 8)
                    .map(
                      (session) =>
                        `- ${session.updatedAt}: \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`
                    )
                ]
              : []),
            ...(dashboardPack === "reader" && conceptPages.length
              ? [
                  "",
                  "## Thesis And Hub Pages",
                  "",
                  ...conceptPages.slice(0, 6).map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
                ]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE occurred_at, source_type, participants, container_title",
                  'FROM "sources"',
                  "SORT occurred_at desc",
                  "LIMIT 25",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:reading-log",
            kind: "index",
            title: "Reading Log",
            tags: ["index", "dashboard", "reading-log"],
            source_ids: timelineManifests.map((manifest) => manifest.sourceId),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: timelineManifests.map((manifest) => manifest.sourceId),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/timeline.md",
      title: "Timeline",
      content: (metadata) =>
        matter.stringify(
          [
            "# Timeline",
            "",
            ...(timelineManifests.length
              ? timelineManifests.map((manifest) => {
                  const occurredAt = manifestDetailValue(manifest, "occurred_at") ?? manifest.updatedAt;
                  const sourcePage = sourcePages.find((page) => page.sourceIds.includes(manifest.sourceId));
                  return `- ${occurredAt}: ${sourcePage ? `[[${sourcePage.path.replace(/\.md$/, "")}|${sourcePage.title}]]` : manifest.title}`;
                })
              : ["- No timeline-aware sources yet."]),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE occurred_at, participants, container_title",
                  'FROM "sources"',
                  "WHERE occurred_at",
                  "SORT occurred_at desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:timeline",
            kind: "index",
            title: "Timeline",
            tags: ["index", "dashboard", "timeline"],
            source_ids: timelineManifests.map((manifest) => manifest.sourceId),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: timelineManifests.map((manifest) => manifest.sourceId),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/source-sessions.md",
      title: "Source Sessions",
      content: (metadata) =>
        matter.stringify(
          [
            "# Source Sessions",
            "",
            "## Active Sessions",
            "",
            ...(sourceSessions.length
              ? sourceSessions
                  .slice(0, 16)
                  .map(
                    (session) =>
                      `- ${session.updatedAt}: \`${session.status}\` \`${session.sessionId}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`
                  )
              : ["- No guided source sessions yet."]),
            "",
            "## Pending Guided Bundles",
            "",
            ...(stagedGuideBundles.length
              ? stagedGuideBundles.map(
                  (bundle) =>
                    `- ${bundle.createdAt}: \`${bundle.approvalId}\`${bundle.title ? ` ${bundle.title}` : ""} (${bundle.entries.length} staged entr${bundle.entries.length === 1 ? "y" : "ies"})`
                )
              : ["- No staged guided bundles right now."]),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE session_status, evidence_state, canonical_targets",
                  'FROM "outputs/source-sessions"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:source-sessions",
            kind: "index",
            title: "Source Sessions",
            tags: ["index", "dashboard", "source-sessions"],
            source_ids: uniqueStrings([
              ...sessionPages.flatMap((page) => page.sourceIds),
              ...sourceSessions.flatMap((session) => session.sourceIds)
            ]),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: uniqueStrings([
              ...sessionPages.flatMap((page) => page.sourceIds),
              ...sourceSessions.flatMap((session) => session.sourceIds)
            ]),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/source-guides.md",
      title: "Source Guides",
      content: (metadata) =>
        matter.stringify(
          [
            "# Source Guides",
            "",
            ...(guidePages.length
              ? guidePages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No accepted source guides yet."]),
            "",
            "## Pending Guided Bundles",
            "",
            ...(stagedGuideBundles.length
              ? stagedGuideBundles.map(
                  (bundle) =>
                    `- ${bundle.createdAt}: \`${bundle.approvalId}\`${bundle.title ? ` ${bundle.title}` : ""} (${bundle.entries.length} staged entr${bundle.entries.length === 1 ? "y" : "ies"})`
                )
              : ["- No staged guided bundles right now."]),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE evidence_state, canonical_targets, file.mtime AS updated",
                  'FROM "outputs/source-guides"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:source-guides",
            kind: "index",
            title: "Source Guides",
            tags: ["index", "dashboard", "source-guides"],
            source_ids: uniqueStrings([
              ...guidePages.flatMap((page) => page.sourceIds),
              ...stagedGuideBundles.flatMap((bundle) => bundle.entries.flatMap((entry) => entry.sourceIds))
            ]),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: uniqueStrings([
              ...guidePages.flatMap((page) => page.sourceIds),
              ...stagedGuideBundles.flatMap((bundle) => bundle.entries.flatMap((entry) => entry.sourceIds))
            ]),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/research-map.md",
      title: "Research Map",
      content: (metadata) =>
        matter.stringify(
          [
            "# Research Map",
            "",
            "## Canonical Concept Pages",
            "",
            ...(conceptPages.length
              ? conceptPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No concept pages yet."]),
            "",
            "## Canonical Entity Pages",
            "",
            ...(entityPages.length
              ? entityPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No entity pages yet."]),
            "",
            "## Recently Guided Sources",
            "",
            ...(guidePages.length
              ? guidePages.slice(0, 8).map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No accepted source guides yet."]),
            "",
            "## Active Source Sessions",
            "",
            ...(sourceSessions.length
              ? sourceSessions
                  .slice(0, 8)
                  .map((session) => `- \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`)
              : ["- No active source sessions yet."]),
            ...(report?.suggestedQuestions?.length
              ? ["", "## Suggested Questions", "", ...report.suggestedQuestions.slice(0, 8).map((question) => `- ${question}`)]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  'TABLE file.folder, file.mtime FROM "concepts" OR "entities"',
                  "SORT file.mtime desc",
                  "LIMIT 30",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:research-map",
            kind: "index",
            title: "Research Map",
            tags: ["index", "dashboard", "research-map"],
            source_ids: uniqueStrings([
              ...conceptPages.flatMap((page) => page.sourceIds),
              ...entityPages.flatMap((page) => page.sourceIds),
              ...guidePages.flatMap((page) => page.sourceIds)
            ]),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: uniqueStrings([
              ...conceptPages.flatMap((page) => page.sourceIds),
              ...entityPages.flatMap((page) => page.sourceIds),
              ...guidePages.flatMap((page) => page.sourceIds)
            ]),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/contradictions.md",
      title: "Contradictions",
      content: (metadata) =>
        matter.stringify(
          [
            "# Contradictions",
            "",
            ...(report?.contradictions.length
              ? report.contradictions.map((contradiction) => {
                  const left = manifestBySourceId.get(contradiction.sourceIdA)?.title ?? contradiction.sourceIdA;
                  const right = manifestBySourceId.get(contradiction.sourceIdB)?.title ?? contradiction.sourceIdB;
                  return `- ${left} / ${right}: ${contradiction.claimA} <> ${contradiction.claimB}`;
                })
              : ["- No contradictions are currently flagged."]),
            "",
            ...(reviewPages.length || briefPages.length || guidePages.length
              ? [
                  "## Related Reviews",
                  "",
                  ...[...guidePages, ...reviewPages, ...briefPages]
                    .slice(0, 12)
                    .map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`),
                  ""
                ]
              : []),
            ...(dashboardPack === "diligence" && diligenceSessions.length
              ? [
                  "## Active Evidence Review Sessions",
                  "",
                  ...diligenceSessions.map(
                    (session) => `- \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`
                  ),
                  ""
                ]
              : []),
            ...(dataviewEnabled
              ? [
                  "```dataview",
                  'TABLE evidence_state, session_status, canonical_targets FROM "outputs/source-reviews" OR "outputs/source-guides" OR "outputs/source-sessions"',
                  'WHERE evidence_state = "conflicting"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:contradictions",
            kind: "index",
            title: "Contradictions",
            tags: ["index", "dashboard", "contradictions"],
            source_ids: report?.contradictions.flatMap((item) => [item.sourceIdA, item.sourceIdB]) ?? [],
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: report?.contradictions.flatMap((item) => [item.sourceIdA, item.sourceIdB]) ?? [],
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/open-questions.md",
      title: "Open Questions",
      content: (metadata) =>
        matter.stringify(
          [
            "# Open Questions",
            "",
            ...(openQuestions.length ? openQuestions.map((question) => `- ${question}`) : ["- No open questions are currently extracted."]),
            ...(sourceSessions.length
              ? [
                  "",
                  "## Active Guided Sessions",
                  "",
                  ...sourceSessions
                    .filter((session) => session.status === "awaiting_input" || session.status === "staged")
                    .slice(0, 8)
                    .map((session) => `- \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`)
                ]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  'TABLE question_state, session_status, evidence_state FROM "outputs/source-briefs" OR "outputs/source-reviews" OR "outputs/source-guides" OR "outputs/source-sessions"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:open-questions",
            kind: "index",
            title: "Open Questions",
            tags: ["index", "dashboard", "open-questions"],
            source_ids: analyses.map((analysis) => analysis.sourceId),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: analyses.map((analysis) => analysis.sourceId),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    }
  ];

  const records: ManagedPageRecord[] = [];
  for (const dashboard of dashboards) {
    const absolutePath = path.join(paths.wikiDir, dashboard.relativePath);
    const compiledFrom =
      dashboard.relativePath === "dashboards/recent-sources.md" ? recentSourcePages.flatMap((page) => page.sourceIds) : [];
    const content = await buildManagedContent(
      absolutePath,
      {
        managedBy: "system",
        compiledFrom
      },
      dashboard.content
    );
    records.push({
      page: emptyGraphPage({
        id: `dashboard:${dashboard.relativePath.replace(/\.md$/, "")}`,
        path: dashboard.relativePath,
        title: dashboard.title,
        kind: "index",
        sourceIds: compiledFrom,
        nodeIds: [],
        schemaHash,
        sourceHashes: {},
        confidence: 1
      }),
      content
    });
  }
  return records;
}

function indexCompiledFrom(pages: GraphPage[]): string[] {
  return uniqueStrings(pages.flatMap((page) => page.sourceIds));
}

function autoResolution(nodeCount: number, edgeCount: number): number {
  if (nodeCount <= 20) return 0.5;
  if (edgeCount / Math.max(1, nodeCount) < 2) return 0.8;
  return 1.0;
}

function deriveGraphMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options?: { resolution?: number }
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

  const nonSourceIdSet = new Set(nonSourceNodes.map((node) => node.id));

  /* Build a graphology UndirectedGraph for Louvain community detection.
     Only non-source nodes participate; edges are derived from the adjacency
     map which already includes both explicit edges and co-occurrence links. */
  const louvainGraph = new Graph({ type: "undirected" });
  for (const node of nonSourceNodes) {
    louvainGraph.addNode(node.id);
  }
  for (const node of nonSourceNodes) {
    for (const neighbor of adjacency.get(node.id) ?? []) {
      if (nonSourceIdSet.has(neighbor) && !louvainGraph.hasEdge(node.id, neighbor)) {
        louvainGraph.addEdge(node.id, neighbor);
      }
    }
  }

  /* Louvain requires at least one edge; fall back to singleton communities
     for disconnected graphs (e.g. single-source vaults). */
  const effectiveResolution = options?.resolution ?? autoResolution(louvainGraph.order, louvainGraph.size);
  const louvainMapping: Record<string, number> = louvainGraph.size > 0 ? louvain(louvainGraph, { resolution: effectiveResolution }) : {};

  /* Group nodes by their Louvain community number.  Isolated nodes (no edges)
     each get their own singleton community. */
  const groupByCommunity = new Map<number, string[]>();
  let nextIsolated = -1;
  for (const node of nonSourceNodes) {
    const communityNumber = louvainMapping[node.id] ?? nextIsolated--;
    if (!groupByCommunity.has(communityNumber)) {
      groupByCommunity.set(communityNumber, []);
    }
    groupByCommunity.get(communityNumber)!.push(node.id);
  }

  let communityIndex = 0;
  for (const memberIds of groupByCommunity.values()) {
    const labelSeed = nodes.find((candidate) => candidate.id === memberIds[0])?.label ?? `cluster-${communityIndex + 1}`;
    const communityId = buildCommunityId(labelSeed, communityIndex);
    communities.push({
      id: communityId,
      label: labelSeed,
      nodeIds: memberIds.sort((left, right) => left.localeCompare(right))
    });
    for (const memberId of memberIds) {
      communityMap.set(memberId, communityId);
    }
    communityIndex++;
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

function resetGraphNodeMetrics(nodes: GraphNode[]): GraphNode[] {
  return nodes.map(({ communityId: _communityId, degree: _degree, bridgeScore: _bridgeScore, isGodNode: _isGodNode, ...node }) => node);
}

type GoPackageSymbolLookup = {
  byName: Map<string, string>;
  uniqueMethodIdsByShortName: Map<string, string>;
};

function manifestRepoPath(manifest: SourceManifest): string {
  return toPosix(manifest.repoRelativePath ?? path.basename(manifest.originalPath ?? manifest.storedPath));
}

function goPackageScopeKey(manifest: SourceManifest, analysis: SourceAnalysis): string | null {
  if (analysis.code?.language !== "go") {
    return null;
  }
  const packageName = analysis.code.namespace?.trim();
  if (!packageName) {
    return null;
  }
  return `${packageName}:${path.posix.dirname(manifestRepoPath(manifest))}`;
}

function buildGoPackageSymbolLookups(
  analyses: SourceAnalysis[],
  manifestsById: Map<string, SourceManifest>
): Map<string, GoPackageSymbolLookup> {
  const lookups = new Map<
    string,
    {
      byName: Map<string, string>;
      methodIdsByShortName: Map<string, Set<string>>;
    }
  >();

  for (const analysis of analyses) {
    if (analysis.code?.language !== "go") {
      continue;
    }
    const manifest = manifestsById.get(analysis.sourceId);
    if (!manifest) {
      continue;
    }
    const scopeKey = goPackageScopeKey(manifest, analysis);
    if (!scopeKey) {
      continue;
    }
    const current = lookups.get(scopeKey) ?? {
      byName: new Map<string, string>(),
      methodIdsByShortName: new Map<string, Set<string>>()
    };

    for (const symbol of analysis.code.symbols) {
      current.byName.set(symbol.name, symbol.id);
      const separator = symbol.name.lastIndexOf(".");
      if (separator > 0) {
        const shortName = symbol.name.slice(separator + 1);
        const matches = current.methodIdsByShortName.get(shortName) ?? new Set<string>();
        matches.add(symbol.id);
        current.methodIdsByShortName.set(shortName, matches);
      }
    }

    lookups.set(scopeKey, current);
  }

  return new Map(
    [...lookups.entries()].map(([scopeKey, value]) => [
      scopeKey,
      {
        byName: value.byName,
        uniqueMethodIdsByShortName: new Map(
          [...value.methodIdsByShortName.entries()]
            .filter(([, ids]) => ids.size === 1)
            .map(([shortName, ids]) => [shortName, [...ids][0] as string])
        )
      } satisfies GoPackageSymbolLookup
    ])
  );
}

function claimTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g)
      ?.filter((t) => !new Set(["the", "and", "for", "that", "this", "with", "are", "was", "from", "has", "not", "all", "but"]).has(t)) ??
      []
  );
}

function claimJaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

interface DetectedContradiction {
  sourceIdA: string;
  sourceIdB: string;
  claimA: { text: string; confidence: number };
  claimB: { text: string; confidence: number };
  similarity: number;
}

function detectContradictions(analyses: SourceAnalysis[]): DetectedContradiction[] {
  const contradictions: DetectedContradiction[] = [];
  const claimsWithTokens = analyses.flatMap((analysis) =>
    analysis.claims
      .filter((c) => c.polarity === "positive" || c.polarity === "negative")
      .map((c) => ({ sourceId: analysis.sourceId, claim: c, tokens: claimTokens(c.text) }))
  );

  for (let i = 0; i < claimsWithTokens.length; i++) {
    for (let j = i + 1; j < claimsWithTokens.length; j++) {
      const a = claimsWithTokens[i];
      const b = claimsWithTokens[j];
      if (a.sourceId === b.sourceId) continue;
      if (a.claim.polarity === b.claim.polarity) continue;
      const similarity = claimJaccardSimilarity(a.tokens, b.tokens);
      if (similarity >= 0.3) {
        contradictions.push({
          sourceIdA: a.sourceId,
          sourceIdB: b.sourceId,
          claimA: { text: a.claim.text, confidence: a.claim.confidence },
          claimB: { text: b.claim.text, confidence: b.claim.confidence },
          similarity
        });
      }
    }
  }

  return contradictions;
}

function buildGraph(
  manifests: SourceManifest[],
  analyses: SourceAnalysis[],
  pages: GraphPage[],
  sourceProjects: Record<string, string | null>,
  _codeIndex: CodeIndexArtifact,
  options?: { communityResolution?: number }
): GraphArtifact {
  const manifestsById = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  const goPackageSymbolLookups = buildGoPackageSymbolLookups(analyses, manifestsById);
  const analysesBySourceId = new Map(analyses.map((analysis) => [analysis.sourceId, analysis]));
  const sourceNodes: GraphNode[] = manifests.map((manifest) => {
    const analysis = analysesBySourceId.get(manifest.sourceId);
    return {
      id: `source:${manifest.sourceId}`,
      type: "source",
      label: manifest.title,
      pageId: `source:${manifest.sourceId}`,
      freshness: "fresh",
      confidence: 1,
      sourceIds: [manifest.sourceId],
      projectIds: scopedProjectIdsFromSources([manifest.sourceId], sourceProjects),
      sourceClass: manifest.sourceClass,
      language: manifest.language,
      tags: analysis?.tags ?? []
    };
  });

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
        projectIds: scopedProjectIdsFromSources(sourceIds, sourceProjects),
        sourceClass: aggregateManifestSourceClass(manifests, sourceIds)
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
        projectIds: scopedProjectIdsFromSources(sourceIds, sourceProjects),
        sourceClass: aggregateManifestSourceClass(manifests, sourceIds)
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
        sourceClass: manifest.sourceClass,
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
          sourceClass: manifest.sourceClass,
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
      const goPackageLookup =
        analysis.code.language === "go" ? goPackageSymbolLookups.get(goPackageScopeKey(manifest, analysis) ?? "") : undefined;
      const localSymbolIdsByName = goPackageLookup?.byName ?? symbolIdsByName;
      const localGoMethodIdsByShortName = goPackageLookup?.uniqueMethodIdsByShortName ?? new Map<string, string>();
      const resolveLocalSymbolId = (targetName: string): string | undefined =>
        localSymbolIdsByName.get(targetName) ??
        (analysis.code?.language === "go" ? localGoMethodIdsByShortName.get(targetName) : undefined);

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
          sourceClass: manifest.sourceClass,
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

      if (analysis.code.language === "go") {
        for (const symbol of analysis.code.symbols) {
          const separator = symbol.name.lastIndexOf(".");
          if (separator <= 0) {
            continue;
          }
          const receiverTypeId = localSymbolIdsByName.get(symbol.name.slice(0, separator));
          if (!receiverTypeId || receiverTypeId === symbol.id) {
            continue;
          }
          pushEdge({
            id: `${receiverTypeId}->${symbol.id}:defines:receiver`,
            source: receiverTypeId,
            target: symbol.id,
            relation: "defines",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }

      for (const symbol of analysis.code.symbols) {
        for (const targetName of symbol.calls) {
          const targetId = resolveLocalSymbolId(targetName);
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
          const targetId = resolveLocalSymbolId(targetName) ?? importedSymbolIdsByName.get(targetName);
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
          const targetId = resolveLocalSymbolId(targetName) ?? importedSymbolIdsByName.get(targetName);
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
  const enriched = enrichGraph(
    {
      generatedAt: new Date().toISOString(),
      nodes: graphNodes,
      edges,
      communities: [],
      sources: manifests,
      pages
    },
    manifests,
    analyses
  );
  const metrics = deriveGraphMetrics(graphNodes, enriched.edges, { resolution: options?.communityResolution });

  return {
    generatedAt: new Date().toISOString(),
    nodes: metrics.nodes,
    edges: enriched.edges,
    hyperedges: enriched.hyperedges,
    communities: metrics.communities,
    sources: manifests,
    pages
  };
}

function recentResearchSourcePages(
  graph: GraphArtifact,
  previousCompiledAt?: string
): Array<{
  id: string;
  path: string;
  title: string;
  updatedAt: string;
  sourceType: NonNullable<GraphPage["sourceType"]>;
}> {
  const previousTimestamp = previousCompiledAt ? Date.parse(previousCompiledAt) : Number.NaN;
  return graph.pages
    .filter(
      (page): page is GraphPage & { sourceType: NonNullable<GraphPage["sourceType"]> } =>
        page.kind === "source" && Boolean(page.sourceType) && page.sourceType !== "url"
    )
    .filter((page) => Number.isNaN(previousTimestamp) || Date.parse(page.updatedAt) > previousTimestamp)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title))
    .slice(0, 8)
    .map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title,
      updatedAt: page.updatedAt,
      sourceType: page.sourceType
    }));
}

async function buildGraphOrientationPages(
  graph: GraphArtifact,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  schemaHash: string,
  previousCompiledAt?: string,
  contradictions: DetectedContradiction[] = []
): Promise<{ records: ManagedPageRecord[]; report: GraphReportArtifact }> {
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

  const report = buildGraphReportArtifact({
    graph,
    communityPages: communityRecords.map((record) => record.page),
    benchmark,
    benchmarkStale: benchmark ? benchmark.graphHash !== graphHash(graph) : false,
    recentResearchSources: recentResearchSourcePages(graph, previousCompiledAt),
    graphHash: graphHash(graph),
    contradictions
  });
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
        report
      })
  );

  return {
    records: [reportRecord, ...communityRecords],
    report
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
): Array<{
  name: string;
  descriptions: string[];
  sourceAnalyses: SourceAnalysis[];
  sourceHashes: Record<string, string>;
  sourceSemanticHashes: Record<string, string>;
}> {
  const grouped = new Map<
    string,
    {
      name: string;
      descriptions: string[];
      sourceAnalyses: SourceAnalysis[];
      sourceHashes: Record<string, string>;
      sourceSemanticHashes: Record<string, string>;
    }
  >();

  for (const analysis of analyses) {
    for (const item of analysis[kind]) {
      const key = slugify(item.name);
      const existing = grouped.get(key) ?? {
        name: item.name,
        descriptions: [],
        sourceAnalyses: [],
        sourceHashes: {},
        sourceSemanticHashes: {}
      };
      existing.descriptions.push(item.description);
      existing.sourceAnalyses.push(analysis);
      existing.sourceHashes[analysis.sourceId] = analysis.sourceHash;
      existing.sourceSemanticHashes[analysis.sourceId] = analysis.semanticHash;
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
  sourceClass?: SourceClass;
  projectIds?: string[];
  nodeIds: string[];
  schemaHash: string;
  sourceHashes: Record<string, string>;
  sourceSemanticHashes?: Record<string, string>;
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
    sourceClass: input.sourceClass,
    sourceIds: input.sourceIds,
    projectIds: input.projectIds ?? [],
    nodeIds: input.nodeIds,
    freshness: "fresh",
    status: input.status ?? "active",
    confidence: input.confidence,
    backlinks: [],
    schemaHash: input.schemaHash,
    sourceHashes: input.sourceHashes,
    sourceSemanticHashes: input.sourceSemanticHashes ?? {},
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

function normalizeApprovalBundleType(raw: string | undefined): ApprovalBundleType | undefined {
  if (!raw) return undefined;
  const legacy: Record<string, ApprovalBundleType> = {
    generated_output: "generated-output",
    source_review: "source-review",
    guided_source: "guided-source",
    guided_session: "guided-session"
  };
  return legacy[raw] ?? (raw as ApprovalBundleType);
}

async function readApprovalManifest(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  approvalId: string
): Promise<ApprovalManifest> {
  const manifest = await readJsonFile<ApprovalManifest>(approvalManifestPath(paths, approvalId));
  if (!manifest) {
    throw new Error(`Approval bundle not found: ${approvalId}`);
  }
  manifest.bundleType = normalizeApprovalBundleType(manifest.bundleType);
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
  graph: GraphArtifact,
  labelsByPath: Map<string, ApprovalEntryLabel> = new Map()
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
        previousPath: previousPage.path,
        label: labelsByPath.get(nextPage.path) ?? labelsByPath.get(previousPage.path)
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
      previousPath: previousPage?.path,
      label: labelsByPath.get(nextPage.path) ?? (previousPage?.path ? labelsByPath.get(previousPage.path) : undefined)
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
      previousPath: deletedPath,
      label: labelsByPath.get(deletedPath)
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
    bundleType: "compile",
    title: "Compile Approval",
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
          sourceClass: manifest.sourceClass,
          projectIds: sourceProjectIds,
          nodeIds: [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)],
          schemaHash: sourceSchemaHash,
          sourceHashes: { [manifest.sourceId]: manifest.contentHash },
          sourceSemanticHashes: { [manifest.sourceId]: manifest.semanticHash },
          confidence: 1
        })
      : null;
    const preview = emptyGraphPage({
      id: `source:${manifest.sourceId}`,
      path: `sources/${manifest.sourceId}.md`,
      title: analysis.title,
      kind: "source",
      sourceIds: [manifest.sourceId],
      sourceClass: manifest.sourceClass,
      projectIds: sourceProjectIds,
      nodeIds: [
        `source:${manifest.sourceId}`,
        ...analysis.concepts.map((item) => item.id),
        ...analysis.entities.map((item) => item.id),
        ...(analysis.code ? [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)] : [])
      ],
      schemaHash: sourceSchemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
      sourceSemanticHashes: { [manifest.sourceId]: manifest.semanticHash },
      confidence: 1
    });
    const sourceRecord = await buildManagedGraphPage(
      path.join(paths.wikiDir, preview.path),
      {
        managedBy: "system",
        confidence: 1,
        compiledFrom: [manifest.sourceId]
      },
      (metadata, existingContent) =>
        buildSourcePage(
          manifest,
          analysis,
          sourceSchemaHash,
          metadata,
          relatedOutputsForPage(preview, input.outputPages),
          modulePreview ?? undefined,
          {
            projectIds: sourceProjectIds,
            extraTags: [...sourceCategoryTags, ...(analysis.tags ?? [])],
            sourceClass: manifest.sourceClass
          },
          existingContent
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
              extraTags: [...sourceCategoryTags, ...(analysis.tags ?? [])]
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
      const aggregateSourceClass = aggregateManifestSourceClass(input.manifests, sourceIds);
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
        sourceClass: aggregateSourceClass,
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
        (metadata, existingContent) =>
          buildAggregatePage(
            itemKind,
            aggregate.name,
            aggregate.descriptions,
            aggregate.sourceAnalyses,
            aggregate.sourceHashes,
            aggregate.sourceSemanticHashes,
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
              ]),
              sourceClass: aggregateSourceClass
            },
            existingContent
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
  const structuralGraph = buildGraph(input.manifests, input.analyses, basePages, input.sourceProjects, input.codeIndex, {
    communityResolution: config.graph?.communityResolution
  });
  const contradictions = detectContradictions(input.analyses);
  for (const contradiction of contradictions) {
    const edgeId = `contradiction:${contradiction.sourceIdA}->${contradiction.sourceIdB}`;
    if (!structuralGraph.edges.some((e) => e.id === edgeId)) {
      structuralGraph.edges.push({
        id: edgeId,
        source: `source:${contradiction.sourceIdA}`,
        target: `source:${contradiction.sourceIdB}`,
        relation: "contradicts",
        status: "conflicted",
        evidenceClass: "ambiguous",
        confidence: Math.abs(contradiction.claimA.confidence - contradiction.claimB.confidence),
        provenance: [contradiction.sourceIdA, contradiction.sourceIdB]
      });
    }
  }
  const embeddingEdges = await embeddingSimilarityEdges(rootDir, structuralGraph).catch(() => []);
  const baseGraph =
    embeddingEdges.length > 0
      ? (() => {
          const edges = uniqueBy([...structuralGraph.edges, ...embeddingEdges], (edge) => edge.id).sort((left, right) =>
            left.id.localeCompare(right.id)
          );
          const metrics = deriveGraphMetrics(resetGraphNodeMetrics(structuralGraph.nodes), edges, {
            resolution: config.graph?.communityResolution
          });
          return {
            ...structuralGraph,
            nodes: metrics.nodes,
            edges,
            communities: metrics.communities
          } satisfies GraphArtifact;
        })()
      : structuralGraph;
  const graphOrientation = await buildGraphOrientationPages(
    baseGraph,
    paths,
    globalSchemaHash,
    input.previousState?.generatedAt,
    contradictions
  );
  const preliminaryPages = [...basePages, ...graphOrientation.records.map((record) => record.page)];
  const dashboardRecords = await buildDashboardRecords(
    config,
    paths,
    {
      ...baseGraph,
      sources: input.manifests,
      pages: preliminaryPages
    },
    globalSchemaHash,
    graphOrientation.report
  );
  records.push(...graphOrientation.records, ...dashboardRecords);
  const allPages = uniqueBy([...preliminaryPages, ...dashboardRecords.map((record) => record.page)], (page) => page.id);
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
    [
      "dashboards/index.md",
      "dashboards",
      allPages.filter((page) => page.kind === "index" && page.path.startsWith("dashboards/") && page.path !== "dashboards/index.md")
    ],
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
  await writeJsonFile(path.join(paths.wikiDir, "graph", "report.json"), graphOrientation.report);
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
    sourceSemanticHashes: Object.fromEntries(input.manifests.map((manifest) => [manifest.sourceId, manifest.semanticHash])),
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
  const compileState = await readJsonFile<CompileState>(paths.compileStatePath);
  const globalSchemaHash = schemas.effective.global.hash;
  const currentGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const orientationPages = uniqueBy(
    pages.filter((page) => page.kind !== "graph_report" && page.kind !== "community_summary"),
    (page) => page.id
  );
  const basePages = uniqueBy(
    pages.filter(
      (page) =>
        page.kind !== "graph_report" && page.kind !== "community_summary" && !(page.kind === "index" && page.path.startsWith("dashboards/"))
    ),
    (page) => page.id
  );
  const graphOrientation: { records: ManagedPageRecord[]; report: GraphReportArtifact | null } = currentGraph
    ? await buildGraphOrientationPages(
        {
          ...currentGraph,
          pages: orientationPages
        },
        paths,
        globalSchemaHash,
        compileState?.generatedAt
      )
    : { records: [], report: null };
  const dashboardRecords = currentGraph
    ? await buildDashboardRecords(
        config,
        paths,
        {
          ...currentGraph,
          pages: [...basePages, ...graphOrientation.records.map((record) => record.page)]
        },
        globalSchemaHash,
        graphOrientation.report
      )
    : [];
  const pagesWithGraph = sortGraphPages(
    uniqueBy(
      [...basePages, ...graphOrientation.records.map((record) => record.page), ...dashboardRecords.map((record) => record.page)],
      (page) => page.id
    )
  );
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
    ensureDir(path.join(paths.wikiDir, "dashboards")),
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
    [
      "dashboards/index.md",
      "dashboards",
      pagesWithGraph.filter((page) => page.kind === "index" && page.path.startsWith("dashboards/") && page.path !== "dashboards/index.md")
    ],
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

  for (const record of graphOrientation.records) {
    await writeFileIfChanged(path.join(paths.wikiDir, record.page.path), record.content);
  }
  for (const record of dashboardRecords) {
    await writeFileIfChanged(path.join(paths.wikiDir, record.page.path), record.content);
  }
  if (graphOrientation.report) {
    await writeJsonFile(path.join(paths.wikiDir, "graph", "report.json"), graphOrientation.report);
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
  const allowedGraphPages = new Set(["graph/index.md", ...graphOrientation.records.map((record) => record.page.path)]);
  await Promise.all(
    existingGraphPages
      .filter((relativePath) => !allowedGraphPages.has(relativePath))
      .map((relativePath) => fs.rm(path.join(paths.wikiDir, relativePath), { force: true }))
  );

  const existingDashboardPages = (await listFilesRecursive(path.join(paths.wikiDir, "dashboards")).catch(() => []))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)));
  const allowedDashboardPages = new Set(["dashboards/index.md", ...dashboardRecords.map((record) => record.page.path)]);
  await Promise.all(
    existingDashboardPages
      .filter((relativePath) => !allowedDashboardPages.has(relativePath))
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
  stagedPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"]; label?: ApprovalEntryLabel }>,
  options: {
    bundleType?: ApprovalBundleType;
    title?: string;
    sourceSessionId?: string;
  } = {}
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
  const labelsByPath = new Map(stagedPages.filter((item) => item.label).map((item) => [item.page.path, item.label as ApprovalEntryLabel]));

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
    hyperedges: previousGraph?.hyperedges ?? [],
    sources: previousGraph?.sources ?? [],
    pages: nextPages
  };
  await fs.writeFile(path.join(approvalDir, "state", "graph.json"), JSON.stringify(graph, null, 2), "utf8");
  await writeApprovalManifest(paths, {
    approvalId,
    createdAt: new Date().toISOString(),
    bundleType: options.bundleType ?? "generated-output",
    title: options.title,
    sourceSessionId: options.sourceSessionId,
    entries: await buildApprovalEntries(
      paths,
      stagedPages.map((item) => ({ relativePath: item.page.path, content: item.content })),
      [],
      previousGraph ?? null,
      graph,
      labelsByPath
    )
  });

  return { approvalId, approvalDir };
}

export async function stageGeneratedOutputPages(
  rootDir: string,
  stagedPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"]; label?: ApprovalEntryLabel }>,
  options: {
    bundleType?: ApprovalBundleType;
    title?: string;
    sourceSessionId?: string;
  } = {}
): Promise<{ approvalId: string; approvalDir: string }> {
  return await stageOutputApprovalBundle(rootDir, stagedPages, options);
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

export async function refreshVaultAfterOutputSave(rootDir: string): Promise<void> {
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
    sourceSemanticHashes: {},
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

function computeUnifiedDiff(current: string, staged: string, label: string): string {
  const currentLines = current.split("\n");
  const stagedLines = staged.split("\n");
  const output: string[] = [`--- a/${label}`, `+++ b/${label}`];

  const n = currentLines.length;
  const m = stagedLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = currentLines[i] === stagedLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && currentLines[i] === stagedLines[j]) {
      output.push(` ${currentLines[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      output.push(`+${stagedLines[j]}`);
      j++;
    } else {
      output.push(`-${currentLines[i]}`);
      i++;
    }
  }

  return output.join("\n");
}

function computeChangeSummary(current: string | undefined, staged: string | undefined, changeType: ApprovalChangeType): string {
  if (changeType === "create") return "New page";
  if (changeType === "delete") return "Removed page";
  if (changeType === "promote") return "Promoted from candidate";
  if (!current || !staged) return "Updated page";

  const currentParsed = matter(current);
  const stagedParsed = matter(staged);
  const changes: string[] = [];

  const currentTags = (currentParsed.data.tags ?? []) as string[];
  const stagedTags = (stagedParsed.data.tags ?? []) as string[];
  const addedTags = stagedTags.filter((t: string) => !currentTags.includes(t));
  const removedTags = currentTags.filter((t: string) => !stagedTags.includes(t));
  if (addedTags.length) changes.push(`added ${addedTags.length} tag(s)`);
  if (removedTags.length) changes.push(`removed ${removedTags.length} tag(s)`);

  if (currentParsed.data.title !== stagedParsed.data.title) changes.push("updated title");

  const currentLines = currentParsed.content.trim().split("\n").length;
  const stagedLines = stagedParsed.content.trim().split("\n").length;
  const lineDelta = stagedLines - currentLines;
  if (lineDelta > 0) changes.push(`added ${lineDelta} line(s)`);
  else if (lineDelta < 0) changes.push(`removed ${Math.abs(lineDelta)} line(s)`);
  else if (currentParsed.content !== stagedParsed.content) changes.push("modified content");

  return changes.length ? changes.join(", ") : "no visible changes";
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

export async function readApproval(rootDir: string, approvalId: string, options?: { diff?: boolean }): Promise<ApprovalDetail> {
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
      const detail: ApprovalEntryDetail = {
        ...entry,
        currentContent,
        stagedContent
      };
      detail.changeSummary = computeChangeSummary(detail.currentContent, detail.stagedContent, detail.changeType);
      if (options?.diff && detail.currentContent && detail.stagedContent) {
        detail.diff = computeUnifiedDiff(detail.currentContent, detail.stagedContent, detail.nextPath ?? detail.pageId);
      }
      return detail;
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
    hyperedges: currentGraph?.hyperedges ?? bundleGraph?.hyperedges ?? [],
    sources: currentGraph?.sources ?? bundleGraph?.sources ?? [],
    pages: sortGraphPages(nextPages)
  };
  compileState.generatedAt = nextGraph.generatedAt;

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextGraph.pages);
  await writeApprovalManifest(paths, manifest);
  if (manifest.sourceSessionId) {
    await updateGuidedSourceSessionStatus(rootDir, manifest.sourceSessionId, "accepted");
  }
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
  if (manifest.sourceSessionId) {
    await updateGuidedSourceSessionStatus(rootDir, manifest.sourceSessionId, "rejected");
  }
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
    hyperedges: graph?.hyperedges ?? [],
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
    hyperedges: graph?.hyperedges ?? [],
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
  const requestedProfile = options.profile ?? "default";
  const { config, paths } = await initWorkspace(rootDir, { profile: requestedProfile });
  const profile = config.profile;
  const isResearchProfile = profile.presets.length > 0 || profile.guidedSessionMode === "canonical_review" || profile.dataviewBlocks;
  await installConfiguredAgents(rootDir);
  const insightsIndexPath = path.join(paths.wikiDir, "insights", "index.md");
  const now = new Date().toISOString();
  await writeFileIfChanged(
    insightsIndexPath,
    matter.stringify(
      (isResearchProfile
        ? [
            "# Insights",
            "",
            "Human-authored research notes live here.",
            "",
            "- Use this folder for thesis notes, reading reflections, synthesis drafts, and decisions you want to keep explicitly human-authored.",
            ...(profile.guidedSessionMode === "canonical_review"
              ? [
                  "- Guided sessions can stage approval-queued updates for canonical pages and fall back to `wiki/insights/` when a claim still needs judgment."
                ]
              : [
                  "- Guided sessions fall back to `wiki/insights/` for exploratory synthesis until you decide what should become canonical."
                ]),
            "- Treat these pages as the human judgment layer for your vault.",
            ""
          ]
        : [
            "# Insights",
            "",
            "Human-authored notes live here.",
            "",
            "- SwarmVault can read these pages during compile and query.",
            "- SwarmVault can stage insight-page updates through guided sessions, but it never applies them without review.",
            ""
          ]
      ).join("\n"),
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
        source_hashes: {},
        source_semantic_hashes: {}
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
      source_hashes: {},
      source_semantic_hashes: {}
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
      source_hashes: {},
      source_semantic_hashes: {}
    })
  );
  if (options.obsidian) {
    await ensureObsidianWorkspace(rootDir);
  }

  if (isResearchProfile) {
    await writeFileIfChanged(
      path.join(paths.wikiDir, "insights", "research-playbook.md"),
      matter.stringify(
        [
          `# ${requestedProfile === "personal-research" ? "Personal Research Playbook" : "Research Playbook"}`,
          "",
          "- Add one source at a time with `swarmvault ingest <input> --guide` or `swarmvault source add <input> --guide`.",
          "- Resume a guided session with `swarmvault source session <source-id-or-session-id>` whenever you want to answer the session prompts directly.",
          "- Review `wiki/outputs/source-briefs/`, `wiki/outputs/source-reviews/`, `wiki/outputs/source-guides/`, and `wiki/outputs/source-sessions/` before accepting staged updates.",
          ...(profile.guidedSessionMode === "canonical_review"
            ? ["- Use `swarmvault review show --diff` to inspect staged canonical page edits before accepting them."]
            : ["- Keep exploratory synthesis in `wiki/insights/` until you are ready to promote it into canonical pages."]),
          ...(profile.dataviewBlocks
            ? [
                "- Dataview-friendly fields are enabled in the dashboards, but every generated page should still read cleanly as plain markdown."
              ]
            : []),
          ...(profile.presets.length ? [`- Active profile presets: ${profile.presets.map((preset) => `\`${preset}\``).join(", ")}.`] : []),
          "- Keep unresolved questions visible in `wiki/dashboards/open-questions.md`.",
          "- Use `swarmvault review list` and `swarmvault review show --diff` to decide what becomes canonical.",
          ""
        ].join("\n"),
        {
          page_id: "insights:research-playbook",
          kind: "insight",
          title: requestedProfile === "personal-research" ? "Personal Research Playbook" : "Research Playbook",
          tags: ["insight", "research", "playbook"],
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
          source_hashes: {},
          source_semantic_hashes: {}
        }
      )
    );
  }
}

async function runConfiguredBenchmark(rootDir: string, config: VaultConfig): Promise<{ ok: boolean; error?: string }> {
  if (config.benchmark?.enabled === false) {
    return { ok: true };
  }

  try {
    await benchmarkVault(rootDir);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
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
  const previousSourceHashes = previousState?.sourceSemanticHashes ?? previousState?.sourceHashes ?? {};
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
    const hashChanged = previousSourceHashes[manifest.sourceId] !== manifest.semanticHash;
    const noAnalysis = !previousAnalyses[manifest.sourceId];
    const projectId = sourceProjects[manifest.sourceId] ?? null;
    const projectChanged = (previousSourceProjects[manifest.sourceId] ?? null) !== projectId;
    const effectiveHashChanged = previousProjectSchemaHash(previousState, projectId) !== effectiveHashForProject(schemas, projectId);
    if (hashChanged || noAnalysis || projectChanged || effectiveHashChanged) {
      if (options.codeOnly && manifest.sourceKind !== "code") {
        clean.push(manifest);
      } else {
        dirty.push(manifest);
      }
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
    const benchmark = await runConfiguredBenchmark(rootDir, config);
    if (graph && benchmark.ok) {
      await refreshIndexesAndSearch(rootDir, graph.pages);
    }
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
        `schema=${schemas.effective.global.hash.slice(0, 12)}`,
        `benchmark=${benchmark.ok ? "ok" : `error:${benchmark.error}`}`
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

  const analysisProgress = createCompileProgressReporter("analyze", manifests.length);
  const [dirtyAnalyses, cleanAnalyses] = await Promise.all([
    Promise.all(
      dirty.map(async (manifest) => {
        const analysis = await analyzeSource(
          manifest,
          await readExtractedText(rootDir, manifest),
          provider,
          paths,
          getEffectiveSchema(schemas, sourceProjects[manifest.sourceId] ?? null)
        );
        analysisProgress.tick(manifest.title);
        return analysis;
      })
    ),
    Promise.all(
      clean.map(async (manifest) => {
        const cached = await readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${manifest.sourceId}.json`));
        if (cached) {
          analysisProgress.tick(manifest.title);
          return cached;
        }
        const analysis = await analyzeSource(
          manifest,
          await readExtractedText(rootDir, manifest),
          provider,
          paths,
          getEffectiveSchema(schemas, sourceProjects[manifest.sourceId] ?? null)
        );
        analysisProgress.tick(manifest.title);
        return analysis;
      })
    )
  ]);
  analysisProgress.finish(`dirty=${dirty.length}, clean=${clean.length}`);

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
  const benchmark = options.approve ? { ok: true } : await runConfiguredBenchmark(rootDir, config);
  if (!options.approve && benchmark.ok) {
    await refreshIndexesAndSearch(rootDir, sync.allPages);
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
      `schema=${schemas.effective.global.hash.slice(0, 12)}`,
      `benchmark=${benchmark.ok ? "ok" : `error:${benchmark.error}`}`
    ]
  });

  // Token budgeting: when maxTokens is set, remove low-priority pages that exceed the budget
  let tokenStats: CompileResult["tokenStats"];
  if (options.maxTokens && options.maxTokens > 0) {
    const { estimatePageTokens, trimToTokenBudget } = await import("./token-estimation.js");
    const nodeDegreeLookup = new Map<string, number>();
    const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
    if (graph) {
      for (const node of graph.nodes) {
        if (node.pageId && node.degree) {
          const existing = nodeDegreeLookup.get(node.pageId) ?? 0;
          nodeDegreeLookup.set(node.pageId, Math.max(existing, node.degree));
        }
      }
    }

    const estimates = await Promise.all(
      sync.allPages.map(async (page) => {
        const fullPath = path.join(paths.wikiDir, page.path);
        let content = "";
        try {
          content = await fs.readFile(fullPath, "utf8");
        } catch {
          // Page may have been removed
        }
        return estimatePageTokens(page.id, page.path, page.kind, content, nodeDegreeLookup.get(page.id), page.confidence);
      })
    );

    const budgetResult = trimToTokenBudget(estimates, options.maxTokens);

    // Remove dropped pages from disk
    for (const dropped of budgetResult.dropped) {
      const fullPath = path.join(paths.wikiDir, dropped.path);
      try {
        await fs.unlink(fullPath);
      } catch {
        // Ignore if already removed
      }
    }

    tokenStats = {
      estimatedTokens: budgetResult.totalTokens,
      maxTokens: options.maxTokens,
      pagesKept: budgetResult.kept.length,
      pagesDropped: budgetResult.dropped.length
    };
  }

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
    candidatePageCount: sync.candidatePageCount,
    tokenStats
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
  const { paths, config } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir, {});
  }

  const hybrid = config.search?.hybrid !== false;
  const ftsResults = searchPages(paths.searchDbPath, query, hybrid ? limit * 3 : limit);

  if (!hybrid || !(await fileExists(paths.graphPath))) {
    return ftsResults.slice(0, limit);
  }

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    return ftsResults.slice(0, limit);
  }

  const semanticHits = await semanticPageSearch(rootDir, graph, query, limit * 3).catch(() => []);
  if (!semanticHits.length) {
    return ftsResults.slice(0, limit);
  }

  const merged = mergeSearchResults(ftsResults, semanticHits, limit);

  if (config.search?.rerank && merged.length > 1) {
    return rerankSearchResults(rootDir, query, merged, limit);
  }

  return merged;
}

async function rerankSearchResults(rootDir: string, query: string, results: SearchResult[], limit: number): Promise<SearchResult[]> {
  const provider = await getProviderForTask(rootDir, "queryProvider");
  const candidates = results
    .slice(0, Math.min(results.length, 20))
    .map((r, i) => `[${i}] ${r.title} — ${r.snippet || r.path}`)
    .join("\n");
  const prompt = `Given the search query: "${query}"\n\nRank these results by relevance (most relevant first).\n\n${candidates}`;
  try {
    const indices = await provider.generateStructured(
      { prompt, system: "You are a search result ranker." },
      z.array(z.number().int().nonnegative())
    );
    const reranked: SearchResult[] = [];
    const seen = new Set<number>();
    for (const idx of indices) {
      if (idx >= 0 && idx < results.length && !seen.has(idx)) {
        seen.add(idx);
        reranked.push(results[idx]);
      }
    }
    for (let i = 0; i < results.length && reranked.length < limit; i++) {
      if (!seen.has(i)) {
        reranked.push(results[i]);
      }
    }
    return reranked.slice(0, limit);
  } catch {
    return results.slice(0, limit);
  }
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

async function runResolvedGraphQuery(
  rootDir: string,
  graph: GraphArtifact,
  question: string,
  options: {
    traversal?: "bfs" | "dfs";
    budget?: number;
  } = {}
): Promise<GraphQueryResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const searchResults = searchPages(paths.searchDbPath, question, { limit: Math.max(5, options.budget ?? 10) });
  const semanticMatches = await semanticGraphMatches(rootDir, graph, question, Math.max(8, options.budget ?? 12)).catch(() => []);
  return queryGraph(graph, question, searchResults, {
    ...options,
    semanticMatches
  });
}

export async function queryGraphVault(
  rootDir: string,
  question: string,
  options: {
    traversal?: "bfs" | "dfs";
    budget?: number;
  } = {}
): Promise<GraphQueryResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return runResolvedGraphQuery(rootDir, graph, question, options);
}

export async function benchmarkVault(rootDir: string, options: BenchmarkOptions = {}): Promise<BenchmarkArtifact> {
  const { config, paths } = await loadVaultConfig(rootDir);
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

  const configuredQuestions = (config.benchmark?.questions ?? []).map((question) => normalizeWhitespace(question)).filter(Boolean);
  const maxQuestions = Math.max(1, options.maxQuestions ?? config.benchmark?.maxQuestions ?? 3);
  const questions = (options.questions ?? []).map((question) => normalizeWhitespace(question)).filter(Boolean);
  const sampleQuestions = (
    questions.length ? questions : configuredQuestions.length ? configuredQuestions : defaultBenchmarkQuestionsForGraph(graph, maxQuestions)
  ).slice(0, maxQuestions);
  const perQuestion = await Promise.all(
    sampleQuestions.map(async (question) => {
      const result = await runResolvedGraphQuery(rootDir, graph, question, { budget: 12 });
      const metrics = benchmarkQueryTokens(graph, result, pageContentsById);
      return {
        question,
        queryTokens: metrics.queryTokens,
        reduction: metrics.reduction,
        visitedNodeIds: result.visitedNodeIds,
        visitedEdgeIds: result.visitedEdgeIds,
        pageIds: result.pageIds
      };
    })
  );

  const artifact = buildBenchmarkArtifact({
    graph,
    corpusWords,
    questions: sampleQuestions,
    perQuestion
  });

  await writeJsonFile(paths.benchmarkPath, artifact);
  await refreshIndexesAndSearch(rootDir, graph.pages);
  const refreshedGraph = (await readJsonFile<GraphArtifact>(paths.graphPath)) ?? graph;
  const refreshedHash = graphHash(refreshedGraph);
  if (artifact.graphHash === refreshedHash) {
    return artifact;
  }
  const refreshedArtifact = {
    ...artifact,
    graphHash: refreshedHash
  } satisfies BenchmarkArtifact;
  await writeJsonFile(paths.benchmarkPath, refreshedArtifact);
  return refreshedArtifact;
}

export async function pathGraphVault(rootDir: string, from: string, to: string): Promise<GraphPathResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return shortestGraphPath(graph, from, to);
}

export async function explainGraphVault(rootDir: string, target: string): Promise<GraphExplainResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return explainGraphTarget(graph, target);
}

export async function listGraphHyperedges(rootDir: string, target?: string, limit = 25): Promise<GraphHyperedge[]> {
  const graph = await ensureCompiledGraph(rootDir);
  return listHyperedges(graph, target, limit);
}

export async function readGraphReport(rootDir: string): Promise<GraphReportArtifact | null> {
  const { paths } = await loadVaultConfig(rootDir);
  return readJsonFile<GraphReportArtifact>(path.join(paths.wikiDir, "graph", "report.json"));
}

export async function listGodNodes(rootDir: string, limit = 10): Promise<GraphNode[]> {
  const graph = await ensureCompiledGraph(rootDir);
  return topGodNodes(graph, limit);
}

export async function blastRadiusVault(rootDir: string, target: string, options?: { maxDepth?: number }): Promise<BlastRadiusResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return blastRadius(graph, target, options);
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
  if (!relativePath) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const absolutePath = path.resolve(paths.wikiDir, relativePath);
  if (!isPathWithin(paths.wikiDir, absolutePath)) {
    return null;
  }
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats?.isFile()) {
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

function extractClaimSectionLines(content: string): string[] | null {
  const lines = content.split("\n");
  let inClaims = false;
  let found = false;
  const claimLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "## Claims") {
      inClaims = true;
      found = true;
      continue;
    }
    if (inClaims) {
      if (/^#{1,2}\s/.test(trimmed)) {
        inClaims = false;
        continue;
      }
      claimLines.push(line);
    }
  }
  return found ? claimLines : null;
}

function isClaimPlaceholderBullet(line: string): boolean {
  // Compiler fallbacks emit marker bullets like "- No claims extracted." when
  // a source has nothing to extract. These are intentional "no claims" markers
  // rather than genuine uncited claims and should not trigger the linter.
  const trimmed = line.trim();
  return /^-\s+No\s+claims\s+extracted\.?$/i.test(trimmed);
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

      const freshnessHashes = Object.keys(page.sourceSemanticHashes).length ? page.sourceSemanticHashes : page.sourceHashes;
      for (const [sourceId, knownHash] of Object.entries(freshnessHashes)) {
        const manifest = manifestMap.get(sourceId);
        const manifestHash = manifest?.semanticHash ?? manifest?.contentHash;
        if (manifestHash && manifestHash !== knownHash) {
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
        const claimLines = extractClaimSectionLines(content);
        if (claimLines !== null) {
          const uncited = claimLines.filter(
            (line) => line.startsWith("- ") && !line.includes("[source:") && !isClaimPlaceholderBullet(line)
          );
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
      lines: [
        `findings=${findings.length}`,
        `deep=${Boolean(options.deep)}`,
        `web=${Boolean(options.web)}`,
        `conflicts=${Boolean(options.conflicts)}`
      ]
    });
    return findings;
  }

  // Build deterministic contradiction findings from graph edges
  const contradictionFindings: LintFinding[] = options.conflicts
    ? graph.edges
        .filter((edge) => edge.relation === "contradicts")
        .map((edge) => {
          const sourceIdA = edge.provenance[0] ?? edge.source.replace(/^source:/, "");
          const sourceIdB = edge.provenance[1] ?? edge.target.replace(/^source:/, "");
          return {
            severity: "warning" as const,
            code: "contradiction",
            message: `Contradicting claims detected between source "${sourceIdA}" and source "${sourceIdB}".`,
            relatedSourceIds: [sourceIdA, sourceIdB]
          };
        })
    : [];

  // If conflicts-only mode (no deep or structural lint requested), return only contradiction findings
  if (options.conflicts && !options.deep) {
    await recordSession(rootDir, {
      operation: "lint",
      title: `Linted ${graph.pages.length} page(s)`,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: true,
      relatedPageIds: graph.pages.map((page) => page.id),
      relatedSourceIds: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      lintFindingCount: contradictionFindings.length,
      lines: [`findings=${contradictionFindings.length}`, `deep=false`, `web=false`, `conflicts=true`]
    });
    return contradictionFindings;
  }

  const findings = await structuralLintFindings(rootDir, paths, graph, schemas, manifests, sourceProjects);

  // Include deterministic contradiction findings when conflicts flag is set
  if (options.conflicts) {
    findings.push(...contradictionFindings);
  }

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
    lines: [
      `findings=${findings.length}`,
      `deep=${Boolean(options.deep)}`,
      `web=${Boolean(options.web)}`,
      `conflicts=${Boolean(options.conflicts)}`
    ]
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
