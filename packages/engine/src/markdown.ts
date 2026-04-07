import matter from "gray-matter";
import type { Freshness, GraphPage, OutputOrigin, PageKind, PageManager, PageStatus, SourceAnalysis, SourceManifest } from "./types.js";
import { slugify } from "./utils.js";

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

function pagePathFor(kind: Exclude<PageKind, "index">, slug: string): string {
  switch (kind) {
    case "source":
      return `sources/${slug}.md`;
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
  relatedOutputs: GraphPage[] = []
): { page: GraphPage; content: string } {
  const relativePath = pagePathFor("source", manifest.sourceId);
  const pageId = `source:${manifest.sourceId}`;
  const nodeIds = [`source:${manifest.sourceId}`, ...analysis.concepts.map((item) => item.id), ...analysis.entities.map((item) => item.id)];
  const backlinks = [
    ...analysis.concepts.map((item) => `concept:${slugify(item.name)}`),
    ...analysis.entities.map((item) => `entity:${slugify(item.name)}`),
    ...relatedOutputs.map((page) => page.id)
  ];

  const frontmatter = {
    page_id: pageId,
    kind: "source",
    title: analysis.title,
    tags: ["source"],
    source_ids: [manifest.sourceId],
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
      nodeIds,
      freshness: "fresh",
      status: metadata.status,
      confidence: metadata.confidence,
      backlinks,
      schemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
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

export function buildAggregatePage(
  kind: "concept" | "entity",
  name: string,
  descriptions: string[],
  sourceAnalyses: SourceAnalysis[],
  sourceHashes: Record<string, string>,
  schemaHash: string,
  metadata: ManagedGraphPageMetadata,
  relatedOutputs: GraphPage[] = []
): { page: GraphPage; content: string } {
  const slug = slugify(name);
  const relativePath = pagePathFor(kind, slug);
  const pageId = `${kind}:${slug}`;
  const sourceIds = sourceAnalyses.map((item) => item.sourceId);
  const otherPages = [...sourceAnalyses.map((item) => `source:${item.sourceId}`), ...relatedOutputs.map((page) => page.id)];
  const summary = descriptions.find(Boolean) ?? `${kind} aggregated from ${sourceIds.length} source(s).`;
  const frontmatter = {
    page_id: pageId,
    kind,
    title: name,
    tags: [kind],
    source_ids: sourceIds,
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

export function buildIndexPage(pages: GraphPage[], schemaHash: string, metadata: ManagedPageMetadata): string {
  const sources = pages.filter((page) => page.kind === "source");
  const concepts = pages.filter((page) => page.kind === "concept");
  const entities = pages.filter((page) => page.kind === "entity");
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
    "## Entities",
    "",
    ...(entities.length ? entities.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No entities yet."]),
    "",
    "## Outputs",
    "",
    ...(outputs.length ? outputs.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No saved outputs yet."]),
    "",
    "## Insights",
    "",
    ...(insights.length ? insights.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`) : ["- No insights yet."]),
    ""
  ].join("\n");
}

export function buildSectionIndex(
  kind: "sources" | "concepts" | "entities" | "outputs",
  pages: GraphPage[],
  schemaHash: string,
  metadata: ManagedPageMetadata
): string {
  const title = kind.charAt(0).toUpperCase() + kind.slice(1);
  return matter.stringify(
    [`# ${title}`, "", ...pages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`), ""].join("\n"),
    {
      page_id: `${kind}:index`,
      kind: "index",
      title,
      tags: ["index", kind],
      source_ids: [],
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

export function buildOutputPage(input: {
  title?: string;
  question: string;
  answer: string;
  citations: string[];
  schemaHash: string;
  relatedPageIds?: string[];
  relatedNodeIds?: string[];
  relatedSourceIds?: string[];
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
    tags: ["output"],
    source_ids: input.citations,
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
    question: input.question
  };

  return {
    page: {
      id: pageId,
      path: pathValue,
      title: input.title ?? input.question,
      kind: "output",
      sourceIds: input.citations,
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
      question: input.question
    },
    content: matter.stringify(
      [
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
      ].join("\n"),
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
  slug?: string;
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
    tags: ["output", "explore"],
    source_ids: relatedSourceIds,
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
    question: input.question
  };

  return {
    page: {
      id: pageId,
      path: pathValue,
      title,
      kind: "output",
      sourceIds: relatedSourceIds,
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
      question: input.question
    },
    content: matter.stringify(
      [
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
      ].join("\n"),
      frontmatter
    )
  };
}
