import matter from "gray-matter";
import type { Freshness, GraphPage, PageKind, SourceAnalysis, SourceManifest } from "./types.js";
import { slugify } from "./utils.js";

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

export function buildSourcePage(
  manifest: SourceManifest,
  analysis: SourceAnalysis,
  schemaHash: string,
  confidence = 1.0
): { page: GraphPage; content: string } {
  const relativePath = pagePathFor("source", manifest.sourceId);
  const pageId = `source:${manifest.sourceId}`;
  const nodeIds = [`source:${manifest.sourceId}`, ...analysis.concepts.map((item) => item.id), ...analysis.entities.map((item) => item.id)];
  const backlinks = [
    ...analysis.concepts.map((item) => `concept:${slugify(item.name)}`),
    ...analysis.entities.map((item) => `entity:${slugify(item.name)}`)
  ];

  const frontmatter = {
    page_id: pageId,
    kind: "source",
    title: analysis.title,
    tags: ["source"],
    source_ids: [manifest.sourceId],
    node_ids: nodeIds,
    freshness: "fresh" satisfies Freshness,
    confidence,
    updated_at: analysis.producedAt,
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
      confidence,
      backlinks,
      schemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash }
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
  confidence = 0.72
): { page: GraphPage; content: string } {
  const slug = slugify(name);
  const relativePath = pagePathFor(kind, slug);
  const pageId = `${kind}:${slug}`;
  const sourceIds = sourceAnalyses.map((item) => item.sourceId);
  const otherPages = sourceAnalyses.map((item) => `source:${item.sourceId}`);
  const summary = descriptions.find(Boolean) ?? `${kind} aggregated from ${sourceIds.length} source(s).`;
  const frontmatter = {
    page_id: pageId,
    kind,
    title: name,
    tags: [kind],
    source_ids: sourceIds,
    node_ids: [pageId],
    freshness: "fresh" satisfies Freshness,
    confidence,
    updated_at: new Date().toISOString(),
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
      confidence,
      backlinks: otherPages,
      schemaHash,
      sourceHashes
    },
    content: matter.stringify(body, frontmatter)
  };
}

export function buildIndexPage(pages: GraphPage[], schemaHash: string): string {
  const sources = pages.filter((page) => page.kind === "source");
  const concepts = pages.filter((page) => page.kind === "concept");
  const entities = pages.filter((page) => page.kind === "entity");

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
    "confidence: 1",
    `updated_at: ${new Date().toISOString()}`,
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
    ""
  ].join("\n");
}

export function buildSectionIndex(kind: "sources" | "concepts" | "entities", pages: GraphPage[], schemaHash: string): string {
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
      confidence: 1,
      updated_at: new Date().toISOString(),
      backlinks: [],
      schema_hash: schemaHash,
      source_hashes: {}
    }
  );
}

export function buildOutputPage(
  question: string,
  answer: string,
  citations: string[],
  schemaHash: string
): { page: GraphPage; content: string } {
  const slug = slugify(question);
  const pageId = `output:${slug}`;
  const pathValue = pagePathFor("output", slug);
  const frontmatter = {
    page_id: pageId,
    kind: "output",
    title: question,
    tags: ["output"],
    source_ids: citations,
    node_ids: [],
    freshness: "fresh" satisfies Freshness,
    confidence: 0.74,
    updated_at: new Date().toISOString(),
    backlinks: citations.map((sourceId) => `source:${sourceId}`),
    schema_hash: schemaHash,
    source_hashes: {}
  };

  return {
    page: {
      id: pageId,
      path: pathValue,
      title: question,
      kind: "output",
      sourceIds: citations,
      nodeIds: [],
      freshness: "fresh",
      confidence: 0.74,
      backlinks: citations.map((sourceId) => `source:${sourceId}`),
      schemaHash,
      sourceHashes: {}
    },
    content: matter.stringify(
      [`# ${question}`, "", answer, "", "## Citations", "", ...citations.map((citation) => `- [source:${citation}]`), ""].join("\n"),
      frontmatter
    )
  };
}
