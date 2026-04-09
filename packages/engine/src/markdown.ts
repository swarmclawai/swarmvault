import matter from "gray-matter";
import { modulePageTitle } from "./code-analysis.js";
import { filterGraphBySourceClass, sourceClassBreakdown } from "./embeddings.js";
import { describeSimilarityReasons } from "./graph-enrichment.js";
import { shortestGraphPath } from "./graph-tools.js";
import type {
  BenchmarkArtifact,
  Freshness,
  GraphArtifact,
  GraphEdge,
  GraphHyperedge,
  GraphNode,
  GraphPage,
  GraphReportArtifact,
  OutputAsset,
  OutputFormat,
  OutputOrigin,
  PageKind,
  PageManager,
  PageStatus,
  SourceAnalysis,
  SourceClass,
  SourceManifest
} from "./types.js";
import { normalizeWhitespace, slugify, uniqueBy } from "./utils.js";

export interface ManagedPageMetadata {
  status: PageStatus;
  createdAt: string;
  updatedAt: string;
  compiledFrom: string[];
  managedBy: PageManager;
}

export interface ManagedGraphPageMetadata extends ManagedPageMetadata {
  confidence: number;
}

export interface GeneratedPageDecorations {
  projectIds?: string[];
  extraTags?: string[];
  sourceClass?: SourceClass;
}

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function safeFrontmatter<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceHashesForManifest(manifest: SourceManifest): {
  sourceHashes: Record<string, string>;
  sourceSemanticHashes: Record<string, string>;
} {
  return {
    sourceHashes: { [manifest.sourceId]: manifest.contentHash },
    sourceSemanticHashes: { [manifest.sourceId]: manifest.semanticHash }
  };
}

function sourceHashFrontmatter(sourceHashes: Record<string, string>, sourceSemanticHashes: Record<string, string>) {
  return {
    source_hashes: sourceHashes,
    source_semantic_hashes: sourceSemanticHashes
  };
}

function decoratedTags(baseTags: string[], decorations?: GeneratedPageDecorations): string[] {
  return uniqueStrings([
    ...baseTags,
    ...(decorations?.projectIds ?? []).map((projectId) => `project/${projectId}`),
    ...(decorations?.extraTags ?? [])
  ]);
}

function pagePathFor(kind: Exclude<PageKind, "index">, slug: string): string {
  switch (kind) {
    case "source":
      return `sources/${slug}.md`;
    case "module":
      return `code/${slug}.md`;
    case "concept":
      return `concepts/${slug}.md`;
    case "entity":
      return `entities/${slug}.md`;
    case "output":
      return `outputs/${slug}.md`;
    case "graph_report":
      return "graph/report.md";
    case "community_summary":
      return `graph/communities/${slug}.md`;
    default:
      return `${slug}.md`;
  }
}

export function candidatePagePathFor(kind: "concept" | "entity", slug: string): string {
  return kind === "entity" ? `candidates/entities/${slug}.md` : `candidates/concepts/${slug}.md`;
}

function pageLink(page: Pick<GraphPage, "path" | "title">): string {
  return `[[${page.path.replace(/\.md$/, "")}|${page.title}]]`;
}

function graphNodeLink(node: GraphNode, pagesById: Map<string, GraphPage>): string {
  const page = node.pageId ? pagesById.get(node.pageId) : undefined;
  return page ? pageLink(page) : `\`${node.label}\``;
}

function assetMarkdownPath(assetPath: string): string {
  return `./${assetPath.replace(/^outputs\//, "")}`;
}

function primaryOutputAsset(assets: OutputAsset[]): OutputAsset | undefined {
  return assets.find((asset) => asset.role === "poster") ?? assets.find((asset) => asset.role === "primary");
}

function outputAssetSection(assets: OutputAsset[]): string[] {
  if (!assets.length) {
    return [];
  }

  return [
    "## Assets",
    "",
    ...assets.map((asset) => `- \`${asset.role}\` - [${asset.path}](${assetMarkdownPath(asset.path)}) (${asset.mimeType})`),
    ""
  ];
}

function relatedOutputsSection(relatedOutputs: GraphPage[]): string[] {
  if (!relatedOutputs.length) {
    return [];
  }

  return ["## Related Outputs", "", ...relatedOutputs.map((page) => `- ${pageLink(page)}`), ""];
}

export function buildSourcePage(
  manifest: SourceManifest,
  analysis: SourceAnalysis,
  schemaHash: string,
  metadata: ManagedGraphPageMetadata,
  relatedOutputs: GraphPage[] = [],
  modulePage?: GraphPage,
  decorations?: GeneratedPageDecorations
): { page: GraphPage; content: string } {
  const relativePath = pagePathFor("source", manifest.sourceId);
  const pageId = `source:${manifest.sourceId}`;
  const { sourceHashes, sourceSemanticHashes } = sourceHashesForManifest(manifest);
  const moduleNodeIds = analysis.code ? [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)] : [];
  const nodeIds = [
    `source:${manifest.sourceId}`,
    ...analysis.concepts.map((item) => item.id),
    ...analysis.entities.map((item) => item.id),
    ...moduleNodeIds
  ];
  const backlinks = [
    ...analysis.concepts.map((item) => `concept:${slugify(item.name)}`),
    ...analysis.entities.map((item) => `entity:${slugify(item.name)}`),
    ...(modulePage ? [modulePage.id] : []),
    ...relatedOutputs.map((page) => page.id)
  ];

  const frontmatter = {
    page_id: pageId,
    kind: "source",
    title: analysis.title,
    ...(manifest.sourceType ? { source_type: manifest.sourceType } : {}),
    ...(manifest.sourceClass ? { source_class: manifest.sourceClass } : {}),
    tags: decoratedTags(analysis.code ? ["source", "code"] : ["source"], decorations),
    source_ids: [manifest.sourceId],
    project_ids: decorations?.projectIds ?? [],
    node_ids: nodeIds,
    freshness: "fresh" satisfies Freshness,
    status: metadata.status,
    confidence: metadata.confidence,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
    compiled_from: metadata.compiledFrom,
    managed_by: metadata.managedBy,
    backlinks,
    schema_hash: schemaHash,
    ...sourceHashFrontmatter(sourceHashes, sourceSemanticHashes)
  };

  const body = [
    `# ${analysis.title}`,
    "",
    `Source ID: \`${manifest.sourceId}\``,
    `Source Kind: \`${manifest.sourceKind}\``,
    manifest.url ? `Source URL: ${manifest.url}` : `Source Path: \`${manifest.originalPath ?? manifest.storedPath}\``,
    ...(manifest.sourceType ? [`Source Type: \`${manifest.sourceType}\``, ""] : [""]),
    ...(manifest.sourceClass ? [`Source Class: \`${manifest.sourceClass}\``, ""] : []),
    ...(manifest.sourceGroupTitle ? [`Source Group: ${manifest.sourceGroupTitle}`] : []),
    ...(manifest.partTitle ? [`Part: ${manifest.partIndex ?? "?"}/${manifest.partCount ?? "?"} - ${manifest.partTitle}`] : []),
    ...(manifest.details && Object.keys(manifest.details).length
      ? [
          "",
          "## Source Details",
          "",
          ...Object.entries(manifest.details).map(([key, value]) => `- ${key.replace(/_/g, " ")}: ${value}`),
          ""
        ]
      : []),
    "",
    "## Summary",
    "",
    analysis.summary,
    "",
    ...(analysis.code
      ? [
          "## Code Module",
          "",
          `- Language: \`${analysis.code.language}\``,
          modulePage ? `- Module Page: [[${modulePage.path.replace(/\.md$/, "")}|${modulePage.title}]]` : "- Module Page: Not generated.",
          `- Exports: ${analysis.code.exports.length ? analysis.code.exports.join(", ") : "None detected."}`,
          `- Symbols: ${analysis.code.symbols.length ? analysis.code.symbols.map((symbol) => symbol.name).join(", ") : "None detected."}`,
          analysis.code.diagnostics.length ? `- Diagnostics: ${analysis.code.diagnostics.length}` : "- Diagnostics: None.",
          ""
        ]
      : []),
    "## Concepts",
    "",
    ...(analysis.concepts.length
      ? analysis.concepts.map(
          (item) => `- [[${pagePathFor("concept", slugify(item.name)).replace(/\.md$/, "")}|${item.name}]]: ${item.description}`
        )
      : ["- None detected."]),
    "",
    "## Entities",
    "",
    ...(analysis.entities.length
      ? analysis.entities.map(
          (item) => `- [[${pagePathFor("entity", slugify(item.name)).replace(/\.md$/, "")}|${item.name}]]: ${item.description}`
        )
      : ["- None detected."]),
    "",
    "## Claims",
    "",
    ...(analysis.claims.length ? analysis.claims.map((claim) => `- ${claim.text} [source:${claim.citation}]`) : ["- No claims extracted."]),
    "",
    "## Questions",
    "",
    ...(analysis.questions.length ? analysis.questions.map((question) => `- ${question}`) : ["- No follow-up questions yet."]),
    "",
    ...relatedOutputsSection(relatedOutputs),
    ""
  ].join("\n");

  return {
    page: {
      id: pageId,
      path: relativePath,
      title: analysis.title,
      kind: "source",
      sourceType: manifest.sourceType,
      sourceClass: manifest.sourceClass,
      sourceIds: [manifest.sourceId],
      projectIds: decorations?.projectIds ?? [],
      nodeIds,
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks,
      schemaHash,
      sourceHashes,
      sourceSemanticHashes,
      relatedPageIds: [...(modulePage ? [modulePage.id] : []), ...relatedOutputs.map((page) => page.id)],
      relatedNodeIds: moduleNodeIds,
      relatedSourceIds: [],
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      compiledFrom: metadata.compiledFrom,
      managedBy: metadata.managedBy
    },
    content: matter.stringify(body, safeFrontmatter(frontmatter))
  };
}

export function buildModulePage(input: {
  manifest: SourceManifest;
  analysis: SourceAnalysis;
  schemaHash: string;
  metadata: ManagedGraphPageMetadata;
  sourcePage: GraphPage;
  localModules: Array<{ specifier: string; sourceId: string; page: Pick<GraphPage, "id" | "path" | "title">; reExport: boolean }>;
  relatedOutputs?: GraphPage[];
  projectIds?: string[];
  extraTags?: string[];
}): { page: GraphPage; content: string } {
  const code = input.analysis.code;
  if (!code) {
    throw new Error(`Cannot build a module page without code analysis for ${input.manifest.sourceId}.`);
  }

  const { manifest, analysis, schemaHash, metadata, sourcePage } = input;
  const relativePath = pagePathFor("module", manifest.sourceId);
  const pageId = code.moduleId;
  const title = modulePageTitle(manifest);
  const nodeIds = [code.moduleId, ...code.symbols.map((symbol) => symbol.id)];
  const localModuleBacklinks = input.localModules.map((moduleRef) => moduleRef.page.id);
  const relatedOutputs = input.relatedOutputs ?? [];
  const backlinks = uniqueStrings([sourcePage.id, ...localModuleBacklinks, ...relatedOutputs.map((page) => page.id)]);
  const { sourceHashes, sourceSemanticHashes } = sourceHashesForManifest(manifest);

  const importsSection = code.imports.length
    ? code.imports.map((item) => {
        const localModule = item.resolvedSourceId
          ? input.localModules.find((moduleRef) => moduleRef.sourceId === item.resolvedSourceId && moduleRef.reExport === item.reExport)
          : undefined;
        const importedBits = [
          item.defaultImport ? `default \`${item.defaultImport}\`` : "",
          item.namespaceImport ? `namespace \`${item.namespaceImport}\`` : "",
          item.importedSymbols.length ? `named ${item.importedSymbols.map((symbol) => `\`${symbol}\``).join(", ")}` : ""
        ].filter(Boolean);
        const importTarget = localModule
          ? `[[${localModule.page.path.replace(/\.md$/, "")}|${localModule.page.title}]]`
          : `\`${item.specifier}\``;
        const mode = item.reExport ? "re-exports from" : "imports";
        const suffix = importedBits.length ? ` (${importedBits.join("; ")})` : "";
        return `- ${mode} ${importTarget}${suffix}`;
      })
    : ["- No imports detected."];
  const unresolvedLocalImports = code.imports
    .filter((item) => !item.isExternal && !item.resolvedSourceId)
    .map((item) => `- \`${item.specifier}\`${item.resolvedRepoPath ? ` (expected near \`${item.resolvedRepoPath}\`)` : ""}`);

  const exportsSection = code.exports.length ? code.exports.map((item) => `- \`${item}\``) : ["- No exports detected."];
  const symbolsSection = code.symbols.length
    ? code.symbols.map(
        (symbol) =>
          `- \`${symbol.name}\` (${symbol.kind}${symbol.exported ? ", exported" : ""}): ${symbol.signature || "No signature recorded."}`
      )
    : ["- No top-level symbols detected."];
  const inheritanceSection = code.symbols.flatMap((symbol) => [
    ...symbol.extends.map((item) => `- \`${symbol.name}\` extends \`${item}\``),
    ...symbol.implements.map((item) => `- \`${symbol.name}\` implements \`${item}\``)
  ]);
  const callsSection = code.symbols.flatMap((symbol) => symbol.calls.map((target) => `- \`${symbol.name}\` calls \`${target}\``));
  const diagnosticsSection = code.diagnostics.length
    ? code.diagnostics.map(
        (diagnostic) =>
          `- ${diagnostic.category} diagnostic ${diagnostic.code} at ${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`
      )
    : ["- No parser diagnostics."];

  const frontmatter = {
    page_id: pageId,
    kind: "module",
    title,
    ...(manifest.sourceClass ? { source_class: manifest.sourceClass } : {}),
    tags: decoratedTags(["module", "code", code.language], { projectIds: input.projectIds, extraTags: input.extraTags }),
    source_ids: [manifest.sourceId],
    project_ids: input.projectIds ?? [],
    node_ids: nodeIds,
    freshness: "fresh" satisfies Freshness,
    status: metadata.status,
    confidence: metadata.confidence,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
    compiled_from: metadata.compiledFrom,
    managed_by: metadata.managedBy,
    backlinks,
    schema_hash: schemaHash,
    ...sourceHashFrontmatter(sourceHashes, sourceSemanticHashes),
    related_page_ids: uniqueStrings([sourcePage.id, ...localModuleBacklinks, ...relatedOutputs.map((page) => page.id)]),
    related_node_ids: [],
    related_source_ids: uniqueStrings([
      manifest.sourceId,
      ...input.localModules.map((moduleRef) => moduleRef.sourceId),
      ...relatedOutputs.flatMap((page) => page.sourceIds)
    ]),
    language: code.language
  };

  const body = [
    `# ${title}`,
    "",
    `Source ID: \`${manifest.sourceId}\``,
    `Source Path: \`${manifest.originalPath ?? manifest.storedPath}\``,
    ...(manifest.repoRelativePath ? [`Repo Path: \`${manifest.repoRelativePath}\``] : []),
    ...(manifest.sourceClass ? [`Source Class: \`${manifest.sourceClass}\``] : []),
    `Language: \`${code.language}\``,
    ...(code.moduleName ? [`Module Name: \`${code.moduleName}\``] : []),
    ...(code.namespace ? [`Namespace/Package: \`${code.namespace}\``] : []),
    `Source Page: [[${sourcePage.path.replace(/\.md$/, "")}|${sourcePage.title}]]`,
    "",
    "## Summary",
    "",
    analysis.summary,
    "",
    "## Imports",
    "",
    ...importsSection,
    "",
    "## Exports",
    "",
    ...exportsSection,
    "",
    "## Symbols",
    "",
    ...symbolsSection,
    "",
    "## External Dependencies",
    "",
    ...(code.dependencies.length ? code.dependencies.map((dependency) => `- \`${dependency}\``) : ["- No external dependencies detected."]),
    "",
    "## Unresolved Local References",
    "",
    ...(unresolvedLocalImports.length ? unresolvedLocalImports : ["- No unresolved local references detected."]),
    "",
    "## Inheritance",
    "",
    ...(inheritanceSection.length ? inheritanceSection : ["- No inheritance relationships detected."]),
    "",
    "## Calls",
    "",
    ...(callsSection.length ? callsSection : ["- No direct same-module call edges detected."]),
    "",
    "## Diagnostics",
    "",
    ...diagnosticsSection,
    "",
    ...relatedOutputsSection(relatedOutputs),
    ""
  ].join("\n");

  return {
    page: {
      id: pageId,
      path: relativePath,
      title,
      kind: "module",
      sourceClass: manifest.sourceClass,
      sourceIds: [manifest.sourceId],
      projectIds: input.projectIds ?? [],
      nodeIds,
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks,
      schemaHash,
      sourceHashes,
      sourceSemanticHashes,
      relatedPageIds: uniqueStrings([sourcePage.id, ...localModuleBacklinks, ...relatedOutputs.map((page) => page.id)]),
      relatedNodeIds: [],
      relatedSourceIds: uniqueStrings([
        manifest.sourceId,
        ...input.localModules.map((moduleRef) => moduleRef.sourceId),
        ...relatedOutputs.flatMap((page) => page.sourceIds)
      ]),
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      compiledFrom: metadata.compiledFrom,
      managedBy: metadata.managedBy
    },
    content: matter.stringify(body, frontmatter)
  };
}

export function buildAggregatePage(
  kind: "concept" | "entity",
  name: string,
  descriptions: string[],
  sourceAnalyses: SourceAnalysis[],
  sourceHashes: Record<string, string>,
  sourceSemanticHashes: Record<string, string>,
  schemaHash: string,
  metadata: ManagedGraphPageMetadata,
  relativePath: string,
  relatedOutputs: GraphPage[] = [],
  decorations?: GeneratedPageDecorations
): { page: GraphPage; content: string } {
  const slug = slugify(name);
  const pageId = `${kind}:${slug}`;
  const sourceIds = sourceAnalyses.map((item) => item.sourceId);
  const otherPages = [...sourceAnalyses.map((item) => `source:${item.sourceId}`), ...relatedOutputs.map((page) => page.id)];
  const summary = descriptions.find(Boolean) ?? `${kind} aggregated from ${sourceIds.length} source(s).`;
  const frontmatter = {
    page_id: pageId,
    kind,
    title: name,
    ...(decorations?.sourceClass ? { source_class: decorations.sourceClass } : {}),
    tags: decoratedTags(metadata.status === "candidate" ? [kind, "candidate"] : [kind], decorations),
    source_ids: sourceIds,
    project_ids: decorations?.projectIds ?? [],
    node_ids: [pageId],
    freshness: "fresh" satisfies Freshness,
    status: metadata.status,
    confidence: metadata.confidence,
    created_at: metadata.createdAt,
    updated_at: metadata.updatedAt,
    compiled_from: metadata.compiledFrom,
    managed_by: metadata.managedBy,
    backlinks: otherPages,
    schema_hash: schemaHash,
    ...sourceHashFrontmatter(sourceHashes, sourceSemanticHashes)
  };

  const body = [
    `# ${name}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Seen In",
    "",
    ...sourceAnalyses.map((item) => `- [[${pagePathFor("source", item.sourceId).replace(/\.md$/, "")}|${item.title}]]`),
    "",
    "## Source Claims",
    "",
    ...sourceAnalyses.flatMap((item) =>
      item.claims
        .filter((claim) => claim.text.toLowerCase().includes(name.toLowerCase()))
        .map((claim) => `- ${claim.text} [source:${claim.citation}]`)
    ),
    "",
    ...relatedOutputsSection(relatedOutputs),
    ""
  ].join("\n");

  return {
    page: {
      id: pageId,
      path: relativePath,
      title: name,
      kind,
      sourceClass: decorations?.sourceClass,
      sourceIds,
      projectIds: decorations?.projectIds ?? [],
      nodeIds: [pageId],
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks: otherPages,
      schemaHash,
      sourceHashes,
      sourceSemanticHashes,
      relatedPageIds: relatedOutputs.map((page) => page.id),
      relatedNodeIds: [],
      relatedSourceIds: [],
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      compiledFrom: metadata.compiledFrom,
      managedBy: metadata.managedBy
    },
    content: matter.stringify(body, frontmatter)
  };
}

export function buildIndexPage(
  pages: GraphPage[],
  schemaHash: string,
  metadata: ManagedPageMetadata,
  projectPages: Pick<GraphPage, "path" | "title">[] = []
): string {
  const sources = pages.filter((page) => page.kind === "source");
  const modules = pages.filter((page) => page.kind === "module");
  const concepts = pages.filter((page) => page.kind === "concept" && page.status !== "candidate");
  const entities = pages.filter((page) => page.kind === "entity" && page.status !== "candidate");
  const candidates = pages.filter((page) => page.status === "candidate");
  const outputs = pages.filter((page) => page.kind === "output");
  const insights = pages.filter((page) => page.kind === "insight");
  const graphPages = pages.filter((page) => page.kind === "graph_report" || page.kind === "community_summary");

  return [
    "---",
    "page_id: index",
    "kind: index",
    "title: SwarmVault Index",
    "tags:",
    "  - index",
    "source_ids: []",
    "project_ids: []",
    "node_ids: []",
    "freshness: fresh",
    `status: ${metadata.status}`,
    "confidence: 1",
    `created_at: ${metadata.createdAt}`,
    `updated_at: ${metadata.updatedAt}`,
    `compiled_from: [${metadata.compiledFrom.join(", ")}]`,
    `managed_by: ${metadata.managedBy}`,
    "backlinks: []",
    `schema_hash: ${schemaHash}`,
    "source_hashes: {}",
    "source_semantic_hashes: {}",
    "---",
    "",
    "# SwarmVault Index",
    "",
    "## Sources",
    "",
    ...(sources.length ? sources.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No sources yet."]),
    "",
    "## Concepts",
    "",
    ...(concepts.length ? concepts.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No concepts yet."]),
    "",
    "## Code Modules",
    "",
    ...(modules.length ? modules.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No code modules yet."]),
    "",
    "## Entities",
    "",
    ...(entities.length ? entities.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No entities yet."]),
    "",
    "## Outputs",
    "",
    ...(outputs.length ? outputs.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No saved outputs yet."]),
    "",
    "## Graph",
    "",
    ...(graphPages.length
      ? graphPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No graph reports yet."]),
    "",
    "## Projects",
    "",
    ...(projectPages.length
      ? projectPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No projects configured."]),
    "",
    "## Candidates",
    "",
    ...(candidates.length
      ? candidates.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
      : ["- No candidates staged."]),
    "",
    "## Insights",
    "",
    ...(insights.length ? insights.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No insights yet."]),
    ""
  ].join("\n");
}

export function buildSectionIndex(
  kind: "sources" | "code" | "concepts" | "entities" | "outputs" | "candidates" | "graph",
  pages: GraphPage[],
  schemaHash: string,
  metadata: ManagedPageMetadata,
  projectIds: string[] = []
): string {
  const title = kind.charAt(0).toUpperCase() + kind.slice(1);
  return matter.stringify(
    [`# ${title}`, "", ...pages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`), ""].join("\n"),
    {
      page_id: `${kind}:index`,
      kind: "index",
      title,
      tags: decoratedTags(["index", kind], { projectIds }),
      source_ids: [],
      project_ids: projectIds,
      node_ids: [],
      freshness: "fresh" satisfies Freshness,
      status: metadata.status,
      confidence: 1,
      created_at: metadata.createdAt,
      updated_at: metadata.updatedAt,
      compiled_from: metadata.compiledFrom,
      managed_by: metadata.managedBy,
      backlinks: [],
      schema_hash: schemaHash,
      source_hashes: {},
      source_semantic_hashes: {}
    }
  );
}

function communityPagePath(communityId: string): string {
  return pagePathFor("community_summary", communityId.replace(/^community:/, ""));
}

type GraphPageRecord = {
  page: GraphPage;
  content: string;
};

function nodeSummary(node: GraphNode): string {
  const degree = typeof node.degree === "number" ? `degree=${node.degree}` : "";
  const bridge = typeof node.bridgeScore === "number" ? `bridge=${node.bridgeScore}` : "";
  return [node.type, degree, bridge].filter(Boolean).join(", ");
}

function sourceTypeForNode(node: GraphNode | undefined, pagesById: Map<string, GraphPage>): string | undefined {
  if (!node?.pageId) {
    return undefined;
  }
  return pagesById.get(node.pageId)?.sourceType;
}

function supportingPathDetails(
  graph: GraphArtifact,
  edge: GraphEdge
): {
  pathNodeIds: string[];
  pathEdgeIds: string[];
  pathRelations: string[];
  pathEvidenceClasses: Array<GraphEdge["evidenceClass"]>;
  pathSummary: string;
} {
  const path = shortestGraphPath(graph, edge.source, edge.target);
  const edgesById = new Map(graph.edges.map((item) => [item.id, item]));
  const pathEdges = path.edgeIds.map((edgeId) => edgesById.get(edgeId)).filter((item): item is GraphEdge => Boolean(item));
  return {
    pathNodeIds: path.nodeIds,
    pathEdgeIds: path.edgeIds,
    pathRelations: pathEdges.map((item) => item.relation),
    pathEvidenceClasses: pathEdges.map((item) => item.evidenceClass),
    pathSummary: path.summary
  };
}

function surpriseScore(
  edge: GraphEdge,
  graph: GraphArtifact,
  pagesById: Map<string, GraphPage>,
  hyperedgesByNodeId: Map<string, GraphHyperedge[]>
): { score: number; why: string; explanation: string } {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);
  const reasons: string[] = [];
  let score = edge.confidence * 0.45;

  if (source?.communityId && target?.communityId && source.communityId !== target.communityId) {
    score += 0.18;
    reasons.push(`it crosses communities ${source.communityId} and ${target.communityId}`);
  }
  if (source?.pageId && target?.pageId && source.pageId !== target.pageId) {
    score += 0.12;
    reasons.push("it spans different canonical pages");
  }
  if (source?.type && target?.type && source.type !== target.type) {
    score += 0.08;
    reasons.push(`it bridges ${source.type} and ${target.type} nodes`);
  }
  const sourceType = sourceTypeForNode(source, pagesById);
  const targetType = sourceTypeForNode(target, pagesById);
  if (sourceType && targetType && sourceType !== targetType) {
    score += 0.07;
    reasons.push(`it crosses source types (${sourceType} and ${targetType})`);
  }
  if ((source?.bridgeScore ?? 0) > 0 || (target?.bridgeScore ?? 0) > 0) {
    score += 0.08;
    reasons.push("a bridge node is involved");
  }
  if (edge.relation === "semantically_similar_to") {
    score += 0.12;
    reasons.push(describeSimilarityReasons(edge.similarityReasons));
  }
  if (edge.evidenceClass === "ambiguous") {
    score += 0.08;
    reasons.push("the supporting evidence is ambiguous");
  }
  const overlappingHyperedges = (hyperedgesByNodeId.get(edge.source) ?? []).filter((hyperedge) => hyperedge.nodeIds.includes(edge.target));
  if (overlappingHyperedges.length) {
    score += 0.06;
    reasons.push(`it also appears in ${overlappingHyperedges.length} group pattern${overlappingHyperedges.length === 1 ? "" : "s"}`);
  }

  const why = normalizeWhitespace(reasons.join("; ")) || "it links graph regions that are otherwise weakly connected";
  const explanation = normalizeWhitespace(`${source?.label ?? edge.source} connects to ${target?.label ?? edge.target} because ${why}.`);
  return { score: Math.min(0.99, score), why, explanation };
}

function topSurprisingConnections(graph: GraphArtifact, pagesById: Map<string, GraphPage>): GraphReportArtifact["surprisingConnections"] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const hyperedgesByNodeId = new Map<string, GraphHyperedge[]>();
  for (const hyperedge of graph.hyperedges ?? []) {
    for (const nodeId of hyperedge.nodeIds) {
      if (!hyperedgesByNodeId.has(nodeId)) {
        hyperedgesByNodeId.set(nodeId, []);
      }
      hyperedgesByNodeId.get(nodeId)?.push(hyperedge);
    }
  }

  return uniqueBy(
    graph.edges
      .filter((edge) => {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        return Boolean(
          (source?.communityId && target?.communityId && source.communityId !== target.communityId) ||
            edge.relation === "semantically_similar_to" ||
            edge.evidenceClass === "ambiguous" ||
            (source?.type && target?.type && source.type !== target.type)
        );
      })
      .map((edge) => {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        const path = supportingPathDetails(graph, edge);
        const scored = surpriseScore(edge, graph, pagesById, hyperedgesByNodeId);
        return {
          id: edge.id,
          sourceNodeId: edge.source,
          sourceLabel: source?.label ?? edge.source,
          targetNodeId: edge.target,
          targetLabel: target?.label ?? edge.target,
          relation: edge.relation,
          evidenceClass: edge.evidenceClass,
          confidence: edge.confidence,
          pathNodeIds: path.pathNodeIds,
          pathEdgeIds: path.pathEdgeIds,
          pathRelations: path.pathRelations,
          pathEvidenceClasses: path.pathEvidenceClasses,
          pathSummary: path.pathSummary,
          why: scored.why,
          explanation: scored.explanation,
          surpriseScore: scored.score
        };
      })
      .sort(
        (left, right) => right.surpriseScore - left.surpriseScore || right.confidence - left.confidence || left.id.localeCompare(right.id)
      )
      .slice(0, 8),
    (connection) => connection.id
  ).map(({ surpriseScore: _surpriseScore, ...connection }) => connection);
}

function topGroupPatterns(graph: GraphArtifact): GraphHyperedge[] {
  return [...(graph.hyperedges ?? [])]
    .sort(
      (left, right) =>
        right.confidence - left.confidence || right.nodeIds.length - left.nodeIds.length || left.label.localeCompare(right.label)
    )
    .slice(0, 8);
}

function fragmentedCommunityPresentation(
  graph: GraphArtifact,
  communityPages: Pick<GraphPage, "id" | "path" | "title">[]
): {
  thinCommunities: GraphReportArtifact["thinCommunities"];
  fragmentedCommunityRollup?: NonNullable<GraphReportArtifact["fragmentedCommunityRollup"]>;
} {
  const thinCommunities = (graph.communities ?? [])
    .filter((community) => community.nodeIds.length <= 2)
    .sort((left, right) => right.nodeIds.length - left.nodeIds.length || left.label.localeCompare(right.label));
  const visibleCommunities = thinCommunities.slice(0, 6).map((community) => {
    const page = communityPages.find((candidate) => candidate.id === `graph:${community.id}`);
    return {
      id: community.id,
      label: community.label,
      nodeCount: community.nodeIds.length,
      pageId: page?.id,
      path: page?.path,
      title: page?.title
    };
  });
  const rolledUp = thinCommunities.slice(visibleCommunities.length);
  if (!rolledUp.length) {
    return {
      thinCommunities: visibleCommunities
    };
  }
  return {
    thinCommunities: visibleCommunities,
    fragmentedCommunityRollup: {
      totalCommunities: graph.communities?.length ?? 0,
      rolledUpCount: rolledUp.length,
      rolledUpNodes: rolledUp.reduce((sum, community) => sum + community.nodeIds.length, 0),
      exampleLabels: rolledUp.slice(0, 4).map((community) => community.label)
    }
  };
}

function suggestedGraphQuestions(graph: GraphArtifact): string[] {
  const thinCommunities = (graph.communities ?? []).filter((community) => community.nodeIds.length <= 2);
  const bridgeNodes = graph.nodes
    .filter((node) => (node.bridgeScore ?? 0) > 0)
    .sort((left, right) => (right.bridgeScore ?? 0) - (left.bridgeScore ?? 0))
    .slice(0, 3);
  return uniqueStrings([
    ...thinCommunities.map((community) => `What sources would strengthen community ${community.label}?`),
    ...bridgeNodes.map((node) => `Why does ${node.label} connect multiple communities in the vault?`)
  ]).slice(0, 6);
}

export function buildGraphReportArtifact(input: {
  graph: GraphArtifact;
  communityPages: Pick<GraphPage, "id" | "path" | "title">[];
  benchmark?: BenchmarkArtifact | null;
  benchmarkStale?: boolean;
  recentResearchSources?: Array<
    Pick<GraphPage, "id" | "path" | "title" | "updatedAt"> & { sourceType: NonNullable<GraphPage["sourceType"]> }
  >;
  graphHash: string;
  contradictions?: Array<{
    sourceIdA: string;
    sourceIdB: string;
    claimA: { text: string; confidence: number };
    claimB: { text: string; confidence: number };
    similarity: number;
  }>;
}): GraphReportArtifact {
  const firstPartyGraph = filterGraphBySourceClass(input.graph, "first_party");
  const reportGraph = firstPartyGraph.nodes.length ? firstPartyGraph : input.graph;
  const pagesById = new Map(reportGraph.pages.map((page) => [page.id, page]));
  const godNodes = reportGraph.nodes
    .filter((node) => node.isGodNode)
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0))
    .slice(0, 8);
  const bridgeNodes = reportGraph.nodes
    .filter((node) => (node.bridgeScore ?? 0) > 0)
    .sort((left, right) => (right.bridgeScore ?? 0) - (left.bridgeScore ?? 0))
    .slice(0, 8);
  const communityPresentation = fragmentedCommunityPresentation(reportGraph, input.communityPages);
  const surprisingConnections = topSurprisingConnections(reportGraph, pagesById);
  const groupPatterns = topGroupPatterns(reportGraph);
  const breakdown = sourceClassBreakdown(input.graph);
  const warnings: string[] = [];
  const nonFirstPartyNodes = input.graph.nodes.length - breakdown.first_party.nodes;
  if (input.graph.nodes.length >= 1200) {
    warnings.push(`Large graph detected (${input.graph.nodes.length} nodes). First-party defaults are applied to report highlights.`);
  }
  if (nonFirstPartyNodes > 0 && nonFirstPartyNodes / Math.max(1, input.graph.nodes.length) >= 0.25) {
    warnings.push(
      `Non-first-party material accounts for ${((nonFirstPartyNodes / Math.max(1, input.graph.nodes.length)) * 100).toFixed(1)}% of graph nodes.`
    );
  }
  if (communityPresentation.fragmentedCommunityRollup) {
    warnings.push(
      `First-party report view is fragmented: ${communityPresentation.fragmentedCommunityRollup.rolledUpCount} tiny communities were rolled up for readability.`
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    graphHash: input.graphHash,
    overview: {
      nodes: input.graph.nodes.length,
      edges: input.graph.edges.length,
      pages: input.graph.pages.length,
      communities: input.graph.communities?.length ?? 0
    },
    firstPartyOverview: {
      nodes: reportGraph.nodes.length,
      edges: reportGraph.edges.length,
      pages: reportGraph.pages.length,
      communities: reportGraph.communities?.length ?? 0
    },
    sourceClassBreakdown: breakdown,
    warnings,
    benchmark: input.benchmark
      ? {
          generatedAt: input.benchmark.generatedAt,
          stale: input.benchmarkStale ?? false,
          summary: input.benchmark.summary,
          questionCount: input.benchmark.sampleQuestions.length
        }
      : undefined,
    godNodes: godNodes.map((node) => ({
      nodeId: node.id,
      label: node.label,
      pageId: node.pageId,
      degree: node.degree,
      bridgeScore: node.bridgeScore
    })),
    bridgeNodes: bridgeNodes.map((node) => ({
      nodeId: node.id,
      label: node.label,
      pageId: node.pageId,
      degree: node.degree,
      bridgeScore: node.bridgeScore
    })),
    thinCommunities: communityPresentation.thinCommunities,
    fragmentedCommunityRollup: communityPresentation.fragmentedCommunityRollup,
    surprisingConnections,
    groupPatterns,
    suggestedQuestions: suggestedGraphQuestions(reportGraph),
    communityPages: input.communityPages.map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title
    })),
    recentResearchSources: (input.recentResearchSources ?? []).map((page) => ({
      pageId: page.id,
      path: page.path,
      title: page.title,
      sourceType: page.sourceType,
      updatedAt: page.updatedAt
    })),
    contradictions: (input.contradictions ?? []).map((c) => ({
      sourceIdA: c.sourceIdA,
      sourceIdB: c.sourceIdB,
      claimA: c.claimA.text,
      claimB: c.claimB.text,
      confidenceDelta: Math.abs(c.claimA.confidence - c.claimB.confidence)
    }))
  };
}

export function buildGraphReportPage(input: {
  graph: GraphArtifact;
  schemaHash: string;
  metadata: ManagedGraphPageMetadata;
  report: GraphReportArtifact;
}): GraphPageRecord {
  const pageId = "graph:report";
  const pathValue = pagePathFor("graph_report", "report");
  const pagesById = new Map(input.graph.pages.map((page) => [page.id, page]));
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const relatedNodeIds = uniqueStrings([
    ...input.report.godNodes.map((node) => node.nodeId),
    ...input.report.bridgeNodes.map((node) => node.nodeId),
    ...input.report.surprisingConnections.flatMap((connection) => [
      connection.sourceNodeId,
      connection.targetNodeId,
      ...connection.pathNodeIds
    ]),
    ...input.report.groupPatterns.flatMap((hyperedge) => hyperedge.nodeIds)
  ]);
  const relatedPageIds = uniqueStrings([
    ...input.report.godNodes.map((node) => node.pageId ?? ""),
    ...input.report.bridgeNodes.map((node) => node.pageId ?? ""),
    ...input.report.communityPages.map((page) => page.id),
    ...input.report.recentResearchSources.map((page) => page.pageId),
    ...input.report.groupPatterns.flatMap((hyperedge) => hyperedge.sourcePageIds)
  ]);
  const relatedSourceIds = uniqueStrings([
    ...relatedNodeIds.flatMap((nodeId) => nodesById.get(nodeId)?.sourceIds ?? []),
    ...input.report.recentResearchSources.flatMap((page) => pagesById.get(page.pageId)?.sourceIds ?? [])
  ]);

  const frontmatter = {
    page_id: pageId,
    kind: "graph_report",
    title: "Graph Report",
    tags: ["graph", "report"],
    source_ids: relatedSourceIds,
    project_ids: [],
    node_ids: relatedNodeIds,
    freshness: "fresh" satisfies Freshness,
    status: input.metadata.status,
    confidence: input.metadata.confidence,
    created_at: input.metadata.createdAt,
    updated_at: input.metadata.updatedAt,
    compiled_from: input.metadata.compiledFrom,
    managed_by: input.metadata.managedBy,
    backlinks: [],
    schema_hash: input.schemaHash,
    source_hashes: {},
    source_semantic_hashes: {},
    related_page_ids: relatedPageIds,
    related_node_ids: relatedNodeIds,
    related_source_ids: relatedSourceIds
  };

  const body = [
    "# Graph Report",
    "",
    "## Overview",
    "",
    `- Nodes: ${input.report.overview.nodes}`,
    `- Edges: ${input.report.overview.edges}`,
    `- Pages: ${input.report.overview.pages}`,
    `- Communities: ${input.report.overview.communities}`,
    `- Default Focus: First-party nodes/pages (${input.report.firstPartyOverview.nodes} nodes, ${input.report.firstPartyOverview.edges} edges, ${input.report.firstPartyOverview.pages} pages).`,
    "",
    "## Repo Quality Warnings",
    "",
    ...(input.report.warnings.length ? input.report.warnings.map((warning) => `- ${warning}`) : ["- No large-repo warnings."]),
    "",
    "## Source Class Breakdown",
    "",
    `- First-party: ${input.report.sourceClassBreakdown.first_party.sources} sources, ${input.report.sourceClassBreakdown.first_party.pages} pages, ${input.report.sourceClassBreakdown.first_party.nodes} nodes`,
    `- Third-party: ${input.report.sourceClassBreakdown.third_party.sources} sources, ${input.report.sourceClassBreakdown.third_party.pages} pages, ${input.report.sourceClassBreakdown.third_party.nodes} nodes`,
    `- Resources: ${input.report.sourceClassBreakdown.resource.sources} sources, ${input.report.sourceClassBreakdown.resource.pages} pages, ${input.report.sourceClassBreakdown.resource.nodes} nodes`,
    `- Generated: ${input.report.sourceClassBreakdown.generated.sources} sources, ${input.report.sourceClassBreakdown.generated.pages} pages, ${input.report.sourceClassBreakdown.generated.nodes} nodes`,
    "",
    "## Benchmark Summary",
    "",
    ...(input.report.benchmark
      ? [
          `- Generated At: ${input.report.benchmark.generatedAt}`,
          `- Status: ${input.report.benchmark.stale ? "Stale (graph changed since benchmark ran)" : "Fresh"}`,
          `- Naive Corpus Tokens: ${input.report.benchmark.summary.naiveCorpusTokens}`,
          `- Final Context Tokens: ${input.report.benchmark.summary.finalContextTokens}`,
          `- Unique Nodes Considered: ${input.report.benchmark.summary.uniqueVisitedNodes}`,
          `- Reduction Ratio: ${(input.report.benchmark.summary.reductionRatio * 100).toFixed(1)}%`,
          `- Questions: ${input.report.benchmark.questionCount}`,
          ""
        ]
      : ["- No benchmark results yet.", ""]),
    "## Top God Nodes",
    "",
    ...(input.report.godNodes.length
      ? input.report.godNodes.map((node) => {
          const graphNode = nodesById.get(node.nodeId);
          return graphNode ? `- ${graphNodeLink(graphNode, pagesById)} (${nodeSummary(graphNode)})` : `- \`${node.nodeId}\``;
        })
      : ["- No high-connectivity nodes detected."]),
    "",
    "## Top Bridge Nodes",
    "",
    ...(input.report.bridgeNodes.length
      ? input.report.bridgeNodes.map((node) => {
          const graphNode = nodesById.get(node.nodeId);
          return graphNode ? `- ${graphNodeLink(graphNode, pagesById)} (${nodeSummary(graphNode)})` : `- \`${node.nodeId}\``;
        })
      : ["- No cross-community bridge nodes detected."]),
    "",
    "## Communities",
    "",
    ...(input.report.communityPages.length
      ? input.report.communityPages.map((page) => `- ${pageLink(page)}`)
      : ["- No community summaries generated yet."]),
    "",
    "## Thin Or Underlinked Areas",
    "",
    ...(input.report.thinCommunities.length
      ? input.report.thinCommunities.map((community) =>
          community.path
            ? `- [[${community.path.replace(/\.md$/, "")}|${community.title ?? community.label}]] (${community.nodeCount} node(s))`
            : `- ${community.label} (${community.nodeCount} node(s))`
        )
      : ["- No thin communities detected."]),
    ...(input.report.fragmentedCommunityRollup
      ? [
          `- Rolled up ${input.report.fragmentedCommunityRollup.rolledUpCount} additional tiny communities covering ${input.report.fragmentedCommunityRollup.rolledUpNodes} node(s).`,
          `- Example rolled-up labels: ${input.report.fragmentedCommunityRollup.exampleLabels.join(", ")}`
        ]
      : []),
    "",
    "## Surprising Connections",
    "",
    ...(input.report.surprisingConnections.length
      ? input.report.surprisingConnections.map((connection) => {
          const source = nodesById.get(connection.sourceNodeId);
          const target = nodesById.get(connection.targetNodeId);
          const sourceLabel = source ? graphNodeLink(source, pagesById) : `\`${connection.sourceNodeId}\``;
          const targetLabel = target ? graphNodeLink(target, pagesById) : `\`${connection.targetNodeId}\``;
          return `- ${sourceLabel} ${connection.relation} ${targetLabel} (${connection.evidenceClass}, ${connection.confidence.toFixed(2)}). Why: ${connection.why}. ${connection.explanation} Path: ${connection.pathSummary}.`;
        })
      : ["- No cross-community links detected."]),
    "",
    "## Contradictions",
    "",
    ...(input.report.contradictions.length
      ? input.report.contradictions.map(
          (c) =>
            `- **${c.claimA}** vs **${c.claimB}** (sources: \`${c.sourceIdA}\`, \`${c.sourceIdB}\`, confidence delta: ${c.confidenceDelta.toFixed(2)})`
        )
      : ["- No contradictions detected."]),
    "",
    "## Group Patterns",
    "",
    ...(input.report.groupPatterns.length
      ? input.report.groupPatterns.map((hyperedge) => {
          const linkedNodes = hyperedge.nodeIds
            .map((nodeId) => nodesById.get(nodeId))
            .filter((node): node is GraphNode => Boolean(node))
            .map((node) => graphNodeLink(node, pagesById))
            .join(", ");
          return `- ${hyperedge.label} (${hyperedge.relation}, ${hyperedge.evidenceClass}, ${hyperedge.confidence.toFixed(2)}). ${hyperedge.why} Members: ${linkedNodes}.`;
        })
      : ["- No multi-node group patterns detected."]),
    "",
    "## New Research Sources",
    "",
    ...(input.report.recentResearchSources.length
      ? input.report.recentResearchSources.map(
          (page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]] (\`${page.sourceType}\`, updated ${page.updatedAt})`
        )
      : ["- No newly captured research sources since the previous compile."]),
    "",
    "## Suggested Questions",
    "",
    ...input.report.suggestedQuestions.map((question) => `- ${question}`),
    ""
  ].join("\n");

  return {
    page: {
      id: pageId,
      path: pathValue,
      title: "Graph Report",
      kind: "graph_report",
      sourceIds: relatedSourceIds,
      projectIds: [],
      nodeIds: relatedNodeIds,
      freshness: "fresh",
      status: input.metadata.status,
      confidence: input.metadata.confidence,
      backlinks: [],
      schemaHash: input.schemaHash,
      sourceHashes: {},
      sourceSemanticHashes: {},
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      createdAt: input.metadata.createdAt,
      updatedAt: input.metadata.updatedAt,
      compiledFrom: input.metadata.compiledFrom,
      managedBy: input.metadata.managedBy
    },
    content: matter.stringify(body, frontmatter)
  };
}

export function buildCommunitySummaryPage(input: {
  graph: GraphArtifact;
  community: NonNullable<GraphArtifact["communities"]>[number];
  schemaHash: string;
  metadata: ManagedGraphPageMetadata;
}): GraphPageRecord {
  const pageId = `graph:${input.community.id}`;
  const pathValue = communityPagePath(input.community.id);
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const pagesById = new Map(input.graph.pages.map((page) => [page.id, page]));
  const communityNodes = input.community.nodeIds.map((nodeId) => nodesById.get(nodeId)).filter((node): node is GraphNode => Boolean(node));
  const communityPageIds = uniqueStrings(communityNodes.map((node) => node.pageId ?? ""));
  const communityPages = communityPageIds.map((id) => pagesById.get(id)).filter((page): page is GraphPage => Boolean(page));
  const externalEdges = input.graph.edges
    .filter((edge) => {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      return source?.communityId === input.community.id && target?.communityId && target.communityId !== input.community.id;
    })
    .slice(0, 8);
  const relatedSourceIds = uniqueStrings(communityNodes.flatMap((node) => node.sourceIds));

  const frontmatter = {
    page_id: pageId,
    kind: "community_summary",
    title: `Community: ${input.community.label}`,
    tags: ["graph", "community"],
    source_ids: relatedSourceIds,
    project_ids: [],
    node_ids: input.community.nodeIds,
    freshness: "fresh" satisfies Freshness,
    status: input.metadata.status,
    confidence: input.metadata.confidence,
    created_at: input.metadata.createdAt,
    updated_at: input.metadata.updatedAt,
    compiled_from: input.metadata.compiledFrom,
    managed_by: input.metadata.managedBy,
    backlinks: ["graph:report"],
    schema_hash: input.schemaHash,
    source_hashes: {},
    source_semantic_hashes: {},
    related_page_ids: uniqueStrings(["graph:report", ...communityPageIds]),
    related_node_ids: input.community.nodeIds,
    related_source_ids: relatedSourceIds
  };

  const body = [
    `# Community: ${input.community.label}`,
    "",
    "## Nodes",
    "",
    ...communityNodes.map((node) => `- ${graphNodeLink(node, pagesById)} (${nodeSummary(node)})`),
    "",
    "## Pages",
    "",
    ...(communityPages.length ? communityPages.map((page) => `- ${pageLink(page)}`) : ["- No canonical pages linked."]),
    "",
    "## External Links",
    "",
    ...(externalEdges.length
      ? externalEdges.map((edge) => {
          const source = nodesById.get(edge.source);
          const target = nodesById.get(edge.target);
          return `- ${source ? graphNodeLink(source, pagesById) : `\`${edge.source}\``} ${edge.relation} ${target ? graphNodeLink(target, pagesById) : `\`${edge.target}\``} (${edge.evidenceClass})`;
        })
      : ["- No external links detected."]),
    ""
  ].join("\n");

  return {
    page: {
      id: pageId,
      path: pathValue,
      title: `Community: ${input.community.label}`,
      kind: "community_summary",
      sourceIds: relatedSourceIds,
      projectIds: [],
      nodeIds: input.community.nodeIds,
      freshness: "fresh",
      status: input.metadata.status,
      confidence: input.metadata.confidence,
      backlinks: ["graph:report"],
      schemaHash: input.schemaHash,
      sourceHashes: {},
      sourceSemanticHashes: {},
      relatedPageIds: uniqueStrings(["graph:report", ...communityPageIds]),
      relatedNodeIds: input.community.nodeIds,
      relatedSourceIds,
      createdAt: input.metadata.createdAt,
      updatedAt: input.metadata.updatedAt,
      compiledFrom: input.metadata.compiledFrom,
      managedBy: input.metadata.managedBy
    },
    content: matter.stringify(body, frontmatter)
  };
}

export function buildProjectsIndex(projectPages: GraphPage[], schemaHash: string, metadata: ManagedPageMetadata): string {
  return matter.stringify(
    [
      "# Projects",
      "",
      ...(projectPages.length
        ? projectPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No projects configured."]),
      ""
    ].join("\n"),
    {
      page_id: "projects:index",
      kind: "index",
      title: "Projects",
      tags: ["index", "projects"],
      source_ids: [],
      project_ids: [],
      node_ids: [],
      freshness: "fresh" satisfies Freshness,
      status: metadata.status,
      confidence: 1,
      created_at: metadata.createdAt,
      updated_at: metadata.updatedAt,
      compiled_from: metadata.compiledFrom,
      managed_by: metadata.managedBy,
      backlinks: [],
      schema_hash: schemaHash,
      source_hashes: {},
      source_semantic_hashes: {}
    }
  );
}

export function buildProjectIndex(input: {
  projectId: string;
  schemaHash: string;
  metadata: ManagedPageMetadata;
  sections: Record<"sources" | "code" | "concepts" | "entities" | "outputs" | "candidates", GraphPage[]>;
}): string {
  const title = `Project: ${input.projectId}`;
  return matter.stringify(
    [
      `# ${title}`,
      "",
      "## Sources",
      "",
      ...(input.sections.sources.length
        ? input.sections.sources.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No sources yet."]),
      "",
      "## Code",
      "",
      ...(input.sections.code.length
        ? input.sections.code.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No code pages yet."]),
      "",
      "## Concepts",
      "",
      ...(input.sections.concepts.length
        ? input.sections.concepts.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No concept pages yet."]),
      "",
      "## Entities",
      "",
      ...(input.sections.entities.length
        ? input.sections.entities.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No entity pages yet."]),
      "",
      "## Outputs",
      "",
      ...(input.sections.outputs.length
        ? input.sections.outputs.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No output pages yet."]),
      "",
      "## Candidates",
      "",
      ...(input.sections.candidates.length
        ? input.sections.candidates.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
        : ["- No candidate pages yet."]),
      ""
    ].join("\n"),
    {
      page_id: `project:${input.projectId}:index`,
      kind: "index",
      title,
      tags: decoratedTags(["index", "projects"], { projectIds: [input.projectId] }),
      source_ids: [],
      project_ids: [input.projectId],
      node_ids: [],
      freshness: "fresh" satisfies Freshness,
      status: input.metadata.status,
      confidence: 1,
      created_at: input.metadata.createdAt,
      updated_at: input.metadata.updatedAt,
      compiled_from: input.metadata.compiledFrom,
      managed_by: input.metadata.managedBy,
      backlinks: [],
      schema_hash: input.schemaHash,
      source_hashes: {},
      source_semantic_hashes: {}
    }
  );
}

export function buildOutputPage(input: {
  title?: string;
  question: string;
  answer: string;
  citations: string[];
  schemaHash: string;
  outputFormat: OutputFormat;
  outputAssets?: OutputAsset[];
  relatedPageIds?: string[];
  relatedNodeIds?: string[];
  relatedSourceIds?: string[];
  projectIds?: string[];
  extraTags?: string[];
  origin: OutputOrigin;
  slug?: string;
  metadata: ManagedGraphPageMetadata;
}): { page: GraphPage; content: string } {
  const slug = input.slug ?? slugify(input.question);
  const pageId = `output:${slug}`;
  const pathValue = pagePathFor("output", slug);
  const relatedPageIds = input.relatedPageIds ?? [];
  const relatedNodeIds = input.relatedNodeIds ?? [];
  const relatedSourceIds = input.relatedSourceIds ?? input.citations;
  const outputAssets = input.outputAssets ?? [];
  const backlinks = [...new Set([...relatedPageIds, ...relatedSourceIds.map((sourceId) => `source:${sourceId}`)])];
  const frontmatter = {
    page_id: pageId,
    kind: "output",
    title: input.title ?? input.question,
    tags: decoratedTags(["output"], { projectIds: input.projectIds, extraTags: input.extraTags }),
    source_ids: input.citations,
    project_ids: input.projectIds ?? [],
    node_ids: relatedNodeIds,
    freshness: "fresh" satisfies Freshness,
    status: input.metadata.status,
    confidence: input.metadata.confidence,
    created_at: input.metadata.createdAt,
    updated_at: input.metadata.updatedAt,
    compiled_from: input.metadata.compiledFrom,
    managed_by: input.metadata.managedBy,
    backlinks,
    schema_hash: input.schemaHash,
    source_hashes: {},
    source_semantic_hashes: {},
    related_page_ids: relatedPageIds,
    related_node_ids: relatedNodeIds,
    related_source_ids: relatedSourceIds,
    origin: input.origin,
    question: input.question,
    output_format: input.outputFormat,
    output_assets: outputAssets,
    ...(input.outputFormat === "slides" ? { marp: true } : {})
  };

  return {
    page: {
      id: pageId,
      path: pathValue,
      title: input.title ?? input.question,
      kind: "output",
      sourceIds: input.citations,
      projectIds: input.projectIds ?? [],
      nodeIds: relatedNodeIds,
      freshness: "fresh",
      status: input.metadata.status,
      confidence: input.metadata.confidence,
      backlinks,
      schemaHash: input.schemaHash,
      sourceHashes: {},
      sourceSemanticHashes: {},
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      createdAt: input.metadata.createdAt,
      updatedAt: input.metadata.updatedAt,
      compiledFrom: input.metadata.compiledFrom,
      managedBy: input.metadata.managedBy,
      origin: input.origin,
      question: input.question,
      outputFormat: input.outputFormat,
      outputAssets
    },
    content: matter.stringify(
      (input.outputFormat === "slides"
        ? [
            input.answer,
            "",
            "---",
            "",
            "# Related Pages",
            "",
            ...(relatedPageIds.length ? relatedPageIds.map((pageId) => `- \`${pageId}\``) : ["- None recorded."]),
            "",
            "---",
            "",
            "# Citations",
            "",
            ...input.citations.map((citation) => `- [source:${citation}]`),
            ""
          ]
        : input.outputFormat === "chart" || input.outputFormat === "image"
          ? [
              `# ${input.title ?? input.question}`,
              "",
              ...(primaryOutputAsset(outputAssets)
                ? [`![${input.title ?? input.question}](${assetMarkdownPath(primaryOutputAsset(outputAssets)?.path ?? "")})`, ""]
                : []),
              input.answer,
              "",
              ...outputAssetSection(outputAssets),
              "## Related Pages",
              "",
              ...(relatedPageIds.length ? relatedPageIds.map((pageId) => `- \`${pageId}\``) : ["- None recorded."]),
              "",
              "## Citations",
              "",
              ...input.citations.map((citation) => `- [source:${citation}]`),
              ""
            ]
          : input.outputFormat === "report"
            ? [
                input.answer,
                "",
                ...outputAssetSection(outputAssets),
                "## Related Pages",
                "",
                ...(relatedPageIds.length ? relatedPageIds.map((pageId) => `- \`${pageId}\``) : ["- None recorded."]),
                "",
                "## Citations",
                "",
                ...input.citations.map((citation) => `- [source:${citation}]`),
                ""
              ]
            : [
                `# ${input.title ?? input.question}`,
                "",
                input.answer,
                "",
                ...outputAssetSection(outputAssets),
                "## Related Pages",
                "",
                ...(relatedPageIds.length ? relatedPageIds.map((pageId) => `- \`${pageId}\``) : ["- None recorded."]),
                "",
                "## Citations",
                "",
                ...input.citations.map((citation) => `- [source:${citation}]`),
                ""
              ]
      ).join("\n"),
      frontmatter
    )
  };
}

export function buildExploreHubPage(input: {
  question: string;
  stepPages: GraphPage[];
  followUpQuestions: string[];
  citations: string[];
  schemaHash: string;
  outputFormat: OutputFormat;
  outputAssets?: OutputAsset[];
  slug?: string;
  projectIds?: string[];
  extraTags?: string[];
  metadata: ManagedGraphPageMetadata;
}): { page: GraphPage; content: string } {
  const slug = input.slug ?? `explore-${slugify(input.question)}`;
  const pageId = `output:${slug}`;
  const pathValue = pagePathFor("output", slug);
  const relatedPageIds = input.stepPages.map((page) => page.id);
  const relatedSourceIds = [...new Set(input.citations)];
  const relatedNodeIds = [...new Set(input.stepPages.flatMap((page) => page.nodeIds))];
  const outputAssets = input.outputAssets ?? [];
  const backlinks = [...new Set([...relatedPageIds, ...relatedSourceIds.map((sourceId) => `source:${sourceId}`)])];
  const title = `Explore: ${input.question}`;

  const frontmatter = {
    page_id: pageId,
    kind: "output",
    title,
    tags: decoratedTags(["output", "explore"], { projectIds: input.projectIds, extraTags: input.extraTags }),
    source_ids: relatedSourceIds,
    project_ids: input.projectIds ?? [],
    node_ids: relatedNodeIds,
    freshness: "fresh" satisfies Freshness,
    status: input.metadata.status,
    confidence: input.metadata.confidence,
    created_at: input.metadata.createdAt,
    updated_at: input.metadata.updatedAt,
    compiled_from: input.metadata.compiledFrom,
    managed_by: input.metadata.managedBy,
    backlinks,
    schema_hash: input.schemaHash,
    source_hashes: {},
    source_semantic_hashes: {},
    related_page_ids: relatedPageIds,
    related_node_ids: relatedNodeIds,
    related_source_ids: relatedSourceIds,
    origin: "explore" satisfies OutputOrigin,
    question: input.question,
    output_format: input.outputFormat,
    output_assets: outputAssets,
    ...(input.outputFormat === "slides" ? { marp: true } : {})
  };

  return {
    page: {
      id: pageId,
      path: pathValue,
      title,
      kind: "output",
      sourceIds: relatedSourceIds,
      projectIds: input.projectIds ?? [],
      nodeIds: relatedNodeIds,
      freshness: "fresh",
      status: input.metadata.status,
      confidence: input.metadata.confidence,
      backlinks,
      schemaHash: input.schemaHash,
      sourceHashes: {},
      sourceSemanticHashes: {},
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      createdAt: input.metadata.createdAt,
      updatedAt: input.metadata.updatedAt,
      compiledFrom: input.metadata.compiledFrom,
      managedBy: input.metadata.managedBy,
      origin: "explore",
      question: input.question,
      outputFormat: input.outputFormat,
      outputAssets
    },
    content: matter.stringify(
      (input.outputFormat === "slides"
        ? [
            `# ${title}`,
            "",
            `- Root question: ${input.question}`,
            `- Steps: ${input.stepPages.length}`,
            "---",
            "",
            "# Step Pages",
            "",
            ...(input.stepPages.length ? input.stepPages.map((page) => `- ${pageLink(page)}`) : ["- No steps recorded."]),
            "---",
            "",
            "# Follow-Up Questions",
            "",
            ...(input.followUpQuestions.length
              ? input.followUpQuestions.map((question) => `- ${question}`)
              : ["- No follow-up questions generated."]),
            "---",
            "",
            "# Citations",
            "",
            ...relatedSourceIds.map((citation) => `- [source:${citation}]`),
            ""
          ]
        : input.outputFormat === "chart" || input.outputFormat === "image"
          ? [
              `# ${title}`,
              "",
              ...(primaryOutputAsset(outputAssets)
                ? [`![${title}](${assetMarkdownPath(primaryOutputAsset(outputAssets)?.path ?? "")})`, ""]
                : []),
              "## Root Question",
              "",
              input.question,
              "",
              ...outputAssetSection(outputAssets),
              "## Steps",
              "",
              ...(input.stepPages.length ? input.stepPages.map((page) => `- ${pageLink(page)}`) : ["- No steps recorded."]),
              "",
              "## Follow-Up Questions",
              "",
              ...(input.followUpQuestions.length
                ? input.followUpQuestions.map((question) => `- ${question}`)
                : ["- No follow-up questions generated."]),
              "",
              "## Citations",
              "",
              ...relatedSourceIds.map((citation) => `- [source:${citation}]`),
              ""
            ]
          : [
              `# ${title}`,
              "",
              "## Root Question",
              "",
              input.question,
              "",
              ...outputAssetSection(outputAssets),
              "## Steps",
              "",
              ...(input.stepPages.length ? input.stepPages.map((page) => `- ${pageLink(page)}`) : ["- No steps recorded."]),
              "",
              "## Follow-Up Questions",
              "",
              ...(input.followUpQuestions.length
                ? input.followUpQuestions.map((question) => `- ${question}`)
                : ["- No follow-up questions generated."]),
              "",
              "## Citations",
              "",
              ...relatedSourceIds.map((citation) => `- [source:${citation}]`),
              ""
            ]
      ).join("\n"),
      frontmatter
    )
  };
}
