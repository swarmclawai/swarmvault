import matter from "gray-matter";
import { modulePageTitle } from "./code-analysis.js";
import type {
  Freshness,
  GraphPage,
  OutputFormat,
  OutputOrigin,
  PageKind,
  PageManager,
  PageStatus,
  SourceAnalysis,
  SourceManifest
} from "./types.js";
import { slugify, uniqueBy } from "./utils.js";

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
}

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
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
    source_hashes: {
      [manifest.sourceId]: manifest.contentHash
    }
  };

  const body = [
    `# ${analysis.title}`,
    "",
    `Source ID: \`${manifest.sourceId}\``,
    manifest.url ? `Source URL: ${manifest.url}` : `Source Path: \`${manifest.originalPath ?? manifest.storedPath}\``,
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
      sourceIds: [manifest.sourceId],
      projectIds: decorations?.projectIds ?? [],
      nodeIds,
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks,
      schemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
      relatedPageIds: [...(modulePage ? [modulePage.id] : []), ...relatedOutputs.map((page) => page.id)],
      relatedNodeIds: moduleNodeIds,
      relatedSourceIds: [],
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      compiledFrom: metadata.compiledFrom,
      managedBy: metadata.managedBy
    },
    content: matter.stringify(body, frontmatter)
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

  const importsSection = code.imports.length
    ? code.imports.map((item) => {
        const localModule = input.localModules.find(
          (moduleRef) => moduleRef.specifier === item.specifier && moduleRef.reExport === item.reExport
        );
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
        (diagnostic) => `- ${diagnostic.category} TS${diagnostic.code} at ${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`
      )
    : ["- No parser diagnostics."];

  const frontmatter = {
    page_id: pageId,
    kind: "module",
    title,
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
    source_hashes: {
      [manifest.sourceId]: manifest.contentHash
    },
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
    `Language: \`${code.language}\``,
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
      sourceIds: [manifest.sourceId],
      projectIds: input.projectIds ?? [],
      nodeIds,
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks,
      schemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
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
    source_hashes: sourceHashes
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
      sourceIds,
      projectIds: decorations?.projectIds ?? [],
      nodeIds: [pageId],
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks: otherPages,
      schemaHash,
      sourceHashes,
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
  kind: "sources" | "code" | "concepts" | "entities" | "outputs" | "candidates",
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
      source_hashes: {}
    }
  );
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
      source_hashes: {}
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
      source_hashes: {}
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
    related_page_ids: relatedPageIds,
    related_node_ids: relatedNodeIds,
    related_source_ids: relatedSourceIds,
    origin: input.origin,
    question: input.question,
    output_format: input.outputFormat,
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
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      createdAt: input.metadata.createdAt,
      updatedAt: input.metadata.updatedAt,
      compiledFrom: input.metadata.compiledFrom,
      managedBy: input.metadata.managedBy,
      origin: input.origin,
      question: input.question,
      outputFormat: input.outputFormat
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
        : input.outputFormat === "report"
          ? [
              input.answer,
              "",
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
    related_page_ids: relatedPageIds,
    related_node_ids: relatedNodeIds,
    related_source_ids: relatedSourceIds,
    origin: "explore" satisfies OutputOrigin,
    question: input.question,
    output_format: input.outputFormat,
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
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      createdAt: input.metadata.createdAt,
      updatedAt: input.metadata.updatedAt,
      compiledFrom: input.metadata.compiledFrom,
      managedBy: input.metadata.managedBy,
      origin: "explore",
      question: input.question,
      outputFormat: input.outputFormat
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
        : [
            `# ${title}`,
            "",
            "## Root Question",
            "",
            input.question,
            "",
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
