import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "./config.js";
import type { AiExportFile, AiExportOptions, AiExportResult, GraphArtifact, GraphPage } from "./types.js";
import { ensureDir, fileExists, normalizeWhitespace, readJsonFile, sha256, toPosix, truncate, writeJsonFile } from "./utils.js";

const DEFAULT_MAX_FULL_CHARS = 5_000_000;
const MAX_INDEX_EXCERPT_CHARS = 220;

type LoadedPage = {
  graphPage: GraphPage;
  absolutePath: string;
  content: string;
  body: string;
  data: Record<string, unknown>;
};

function relativeOutputPath(outputDir: string, filePath: string): string {
  return toPosix(path.relative(outputDir, filePath));
}

async function writeTrackedText(
  files: AiExportFile[],
  outputDir: string,
  kind: AiExportFile["kind"],
  filePath: string,
  content: string
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  files.push({
    kind,
    path: relativeOutputPath(outputDir, filePath),
    bytes: Buffer.byteLength(content),
    sha256: sha256(content)
  });
}

async function writeTrackedJson(
  files: AiExportFile[],
  outputDir: string,
  kind: AiExportFile["kind"],
  filePath: string,
  value: unknown
): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeTrackedText(files, outputDir, kind, filePath, content);
}

function graphPathForNode(nodeId: string): string {
  return `swarmvault:node:${encodeURIComponent(nodeId)}`;
}

function graphPathForPage(pageId: string): string {
  return `swarmvault:page:${encodeURIComponent(pageId)}`;
}

function renderPageLine(page: LoadedPage): string {
  const excerpt = truncate(normalizeWhitespace(page.body.replace(/^---[\s\S]*?---/, "")), MAX_INDEX_EXCERPT_CHARS);
  const bits = [
    `- ${page.graphPage.title} (${page.graphPage.kind}, ${page.graphPage.freshness})`,
    `  - path: wiki/${page.graphPage.path}`,
    `  - page_id: ${page.graphPage.id}`,
    page.graphPage.sourceIds.length ? `  - sources: ${page.graphPage.sourceIds.slice(0, 6).join(", ")}` : undefined,
    excerpt ? `  - excerpt: ${excerpt}` : undefined
  ].filter((line): line is string => Boolean(line));
  return bits.join("\n");
}

function renderLlmsIndex(input: { generatedAt: string; vaultName: string; graph: GraphArtifact; pages: LoadedPage[] }): string {
  const topPages = [...input.pages]
    .sort(
      (left, right) =>
        right.graphPage.confidence - left.graphPage.confidence ||
        right.graphPage.relatedPageIds.length - left.graphPage.relatedPageIds.length ||
        left.graphPage.path.localeCompare(right.graphPage.path)
    )
    .slice(0, 80);

  const communities = (input.graph.communities ?? [])
    .slice(0, 20)
    .map((community) => `- ${community.label} (${community.nodeIds.length} nodes)`)
    .join("\n");

  return [
    "# SwarmVault AI Index",
    "",
    `Generated: ${input.generatedAt}`,
    `Vault: ${input.vaultName}`,
    "",
    "## Use This Export",
    "",
    "- Start with `ai-readme.md` for navigation guidance.",
    "- Use `llms-full.txt` when an agent needs a bounded plain-text dump of the compiled wiki.",
    "- Use `graph.jsonld` when an agent or crawler needs a structured page/node/relation graph.",
    "- Use `pages/` for per-page `.txt` and `.json` siblings when `--page-siblings` is enabled.",
    "",
    "## Counts",
    "",
    `- Sources: ${input.graph.sources.length}`,
    `- Pages: ${input.graph.pages.length}`,
    `- Nodes: ${input.graph.nodes.length}`,
    `- Edges: ${input.graph.edges.length}`,
    `- Hyperedges: ${input.graph.hyperedges.length}`,
    "",
    "## Commands",
    "",
    '- `swarmvault query "question"` asks the compiled wiki.',
    '- `swarmvault chat "question"` keeps a persisted multi-turn session.',
    '- `swarmvault context build "goal" --target <path>` creates a token-bounded handoff.',
    "- `swarmvault graph serve` opens the workbench and graph viewer.",
    "- `swarmvault doctor` checks graph, retrieval, review, watch, and task state.",
    "",
    communities ? "## Communities" : undefined,
    communities || undefined,
    "",
    "## High-Signal Pages",
    "",
    topPages.map(renderPageLine).join("\n\n")
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trimEnd()
    .concat("\n");
}

function renderAiReadme(input: { generatedAt: string; vaultName: string; truncatedFullText: boolean; pageSiblings: boolean }): string {
  return [
    "# AI Handoff Pack",
    "",
    `Generated: ${input.generatedAt}`,
    `Vault: ${input.vaultName}`,
    "",
    "This folder is a portable, static export of the compiled SwarmVault wiki for agents, crawlers, and documentation systems.",
    "",
    "## Files",
    "",
    "- `llms.txt` - concise index with stats, command hints, communities, and high-signal pages.",
    `- \`llms-full.txt\` - plain-text wiki dump${input.truncatedFullText ? " truncated at the requested character cap" : ""}.`,
    "- `graph.jsonld` - structured graph with pages, nodes, sources, and relation edges.",
    "- `manifest.json` - file list, hashes, counts, and export settings.",
    input.pageSiblings ? "- `pages/` - per-page `.txt` and `.json` siblings for direct retrieval." : undefined,
    "",
    "## Suggested Agent Flow",
    "",
    "1. Read `llms.txt` to understand the vault shape.",
    "2. Search `llms-full.txt` or `pages/` for the specific topic.",
    "3. Use `graph.jsonld` to follow page, node, and relation IDs when provenance matters.",
    "4. Ask the live vault with `swarmvault query` or continue a session with `swarmvault chat` when shell access is available."
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .trimEnd()
    .concat("\n");
}

function renderFullText(input: { generatedAt: string; vaultName: string; pages: LoadedPage[]; maxChars: number }): {
  content: string;
  truncated: boolean;
} {
  const chunks = [
    "# SwarmVault Full Wiki Export",
    "",
    `Generated: ${input.generatedAt}`,
    `Vault: ${input.vaultName}`,
    "",
    "The sections below are compiled wiki pages separated by stable path markers.",
    ""
  ];
  let usedChars = chunks.join("\n").length;
  let truncated = false;

  for (const page of input.pages) {
    const section = [
      "",
      `--- PAGE: wiki/${page.graphPage.path} ---`,
      `Title: ${page.graphPage.title}`,
      `Page ID: ${page.graphPage.id}`,
      `Kind: ${page.graphPage.kind}`,
      page.graphPage.sourceIds.length ? `Source IDs: ${page.graphPage.sourceIds.join(", ")}` : undefined,
      "",
      page.content.trim(),
      ""
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
    if (usedChars + section.length > input.maxChars) {
      const remaining = Math.max(0, input.maxChars - usedChars);
      if (remaining > 0) {
        chunks.push(section.slice(0, remaining));
      }
      truncated = true;
      break;
    }
    chunks.push(section);
    usedChars += section.length;
  }

  if (truncated) {
    chunks.push("", "[truncated: increase --max-full-chars to include more pages]");
  }

  return { content: chunks.join("\n").trimEnd().concat("\n"), truncated };
}

function buildJsonLd(input: { generatedAt: string; vaultName: string; graph: GraphArtifact }) {
  const graphItems: Array<Record<string, unknown>> = [
    {
      "@id": "swarmvault:vault",
      "@type": "Dataset",
      name: input.vaultName,
      dateModified: input.graph.generatedAt,
      datePublished: input.generatedAt,
      additionalType: "SwarmVaultKnowledgeGraph"
    },
    ...input.graph.sources.map((source) => ({
      "@id": `swarmvault:source:${encodeURIComponent(source.sourceId)}`,
      "@type": "CreativeWork",
      name: source.title,
      encodingFormat: source.mimeType,
      dateCreated: source.createdAt,
      dateModified: source.updatedAt,
      url: source.url,
      fileFormat: source.sourceKind,
      identifier: source.sourceId
    })),
    ...input.graph.pages.map((page) => ({
      "@id": graphPathForPage(page.id),
      "@type": "CreativeWork",
      name: page.title,
      identifier: page.id,
      url: `wiki/${page.path}`,
      genre: page.kind,
      dateCreated: page.createdAt,
      dateModified: page.updatedAt,
      about: page.nodeIds.map((nodeId) => ({ "@id": graphPathForNode(nodeId) })),
      citation: page.sourceIds.map((sourceId) => ({ "@id": `swarmvault:source:${encodeURIComponent(sourceId)}` })),
      isPartOf: { "@id": "swarmvault:vault" }
    })),
    ...input.graph.nodes.map((node) => ({
      "@id": graphPathForNode(node.id),
      "@type": "Thing",
      name: node.label,
      identifier: node.id,
      additionalType: node.type,
      isPartOf: node.pageId ? { "@id": graphPathForPage(node.pageId) } : { "@id": "swarmvault:vault" },
      sameAs: node.sourceIds.map((sourceId) => `swarmvault:source:${encodeURIComponent(sourceId)}`)
    })),
    ...input.graph.edges.map((edge) => ({
      "@id": `swarmvault:edge:${encodeURIComponent(edge.id)}`,
      "@type": "swarmvault:Relation",
      name: edge.relation,
      identifier: edge.id,
      "swarmvault:source": { "@id": graphPathForNode(edge.source) },
      "swarmvault:target": { "@id": graphPathForNode(edge.target) },
      "swarmvault:evidenceClass": edge.evidenceClass,
      "swarmvault:confidence": edge.confidence,
      "swarmvault:provenance": edge.provenance
    }))
  ];

  return {
    "@context": {
      "@vocab": "https://schema.org/",
      swarmvault: "https://www.swarmvault.ai/ns#"
    },
    "@graph": graphItems
  };
}

async function loadPages(rootDir: string, wikiDir: string, graph: GraphArtifact): Promise<LoadedPage[]> {
  const pages: LoadedPage[] = [];
  const sortedPages = [...graph.pages].sort((left, right) => left.path.localeCompare(right.path));
  for (const graphPage of sortedPages) {
    const absolutePath = path.join(wikiDir, graphPage.path);
    if (!(await fileExists(absolutePath))) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    pages.push({
      graphPage,
      absolutePath: path.resolve(rootDir, absolutePath),
      content,
      body: parsed.content,
      data: parsed.data as Record<string, unknown>
    });
  }
  return pages;
}

export async function exportAiPack(rootDir: string, options: AiExportOptions = {}): Promise<AiExportResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` first.");
  }

  const generatedAt = new Date().toISOString();
  const vaultName = path.basename(paths.rootDir);
  const outputDir = path.resolve(rootDir, options.outDir ?? path.join("wiki", "exports", "ai"));
  const maxFullChars = Math.max(1_000, options.maxFullChars ?? DEFAULT_MAX_FULL_CHARS);
  const pageSiblings = options.pageSiblings ?? true;
  await ensureDir(outputDir);

  const pages = await loadPages(rootDir, paths.wikiDir, graph);
  const files: AiExportFile[] = [];
  const fullText = renderFullText({ generatedAt, vaultName, pages, maxChars: maxFullChars });

  await writeTrackedText(
    files,
    outputDir,
    "index",
    path.join(outputDir, "llms.txt"),
    renderLlmsIndex({ generatedAt, vaultName, graph, pages })
  );
  await writeTrackedText(files, outputDir, "full-text", path.join(outputDir, "llms-full.txt"), fullText.content);
  await writeTrackedJson(
    files,
    outputDir,
    "graph-jsonld",
    path.join(outputDir, "graph.jsonld"),
    buildJsonLd({ generatedAt, vaultName, graph })
  );
  await writeTrackedText(
    files,
    outputDir,
    "readme",
    path.join(outputDir, "ai-readme.md"),
    renderAiReadme({ generatedAt, vaultName, truncatedFullText: fullText.truncated, pageSiblings })
  );

  if (pageSiblings) {
    for (const page of pages) {
      const siblingBase = path.join(outputDir, "pages", page.graphPage.path.replace(/\.md$/u, ""));
      await writeTrackedText(files, outputDir, "page-text", `${siblingBase}.txt`, page.body.trim().concat("\n"));
      await writeTrackedJson(files, outputDir, "page-json", `${siblingBase}.json`, {
        title: page.graphPage.title,
        path: page.graphPage.path,
        pageId: page.graphPage.id,
        kind: page.graphPage.kind,
        freshness: page.graphPage.freshness,
        confidence: page.graphPage.confidence,
        sourceIds: page.graphPage.sourceIds,
        nodeIds: page.graphPage.nodeIds,
        relatedPageIds: page.graphPage.relatedPageIds,
        relatedNodeIds: page.graphPage.relatedNodeIds,
        frontmatter: page.data,
        body: page.body.trim(),
        contentSha256: sha256(page.content)
      });
    }
  }

  const result: AiExportResult = {
    outputDir,
    generatedAt,
    pageCount: graph.pages.length,
    sourceCount: graph.sources.length,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    truncatedFullText: fullText.truncated,
    files
  };

  const manifestPath = path.join(outputDir, "manifest.json");
  await writeJsonFile(manifestPath, {
    ...result,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path))
  });
  const manifestContent = await fs.readFile(manifestPath, "utf8");
  files.push({
    kind: "manifest",
    path: relativeOutputPath(outputDir, manifestPath),
    bytes: Buffer.byteLength(manifestContent),
    sha256: sha256(manifestContent)
  });

  return {
    ...result,
    files: [...files].sort((left, right) => left.path.localeCompare(right.path))
  };
}
