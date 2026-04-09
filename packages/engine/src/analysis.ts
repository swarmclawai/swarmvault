import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";
import { z } from "zod";
import { analyzeCodeSource } from "./code-analysis.js";
import { readExtractionArtifact } from "./ingest.js";
import type { VaultSchema } from "./schema.js";
import type { Polarity, ProviderAdapter, ResolvedPaths, SourceAnalysis, SourceExtractionArtifact, SourceManifest } from "./types.js";
import { firstSentences, normalizeWhitespace, readJsonFile, sha256, slugify, truncate, uniqueBy, writeJsonFile } from "./utils.js";

const ANALYSIS_FORMAT_VERSION = 7;

const sourceAnalysisSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  concepts: z
    .array(z.object({ name: z.string().min(1), description: z.string().default("") }))
    .max(12)
    .default([]),
  entities: z
    .array(z.object({ name: z.string().min(1), description: z.string().default("") }))
    .max(12)
    .default([]),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.6),
        status: z.enum(["extracted", "inferred", "conflicted", "stale"]).default("extracted"),
        polarity: z.enum(["positive", "negative", "neutral"]).default("neutral"),
        citation: z.string().min(1)
      })
    )
    .max(8)
    .default([]),
  questions: z.array(z.string()).max(6).default([]),
  tags: z.array(z.string()).max(5).default([])
});

const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "being",
  "between",
  "both",
  "could",
  "does",
  "each",
  "from",
  "have",
  "into",
  "just",
  "more",
  "much",
  "only",
  "other",
  "over",
  "same",
  "some",
  "such",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your"
]);

const HEURISTIC_SECTION_SOURCE_KINDS = new Map<SourceManifest["sourceKind"], string>([
  ["transcript", "Transcript"],
  ["chat_export", "Messages"],
  ["email", "Message"],
  ["calendar", "Description"]
]);

type MarkdownNode = {
  type: string;
  depth?: number;
  value?: string;
  alt?: string;
  children?: MarkdownNode[];
};

function extractTopTerms(text: string, count: number): string[] {
  const frequency = new Map<string, number>();
  for (const token of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (STOPWORDS.has(token)) {
      continue;
    }
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, count)
    .map(([token]) => token);
}

function extractEntities(text: string, count: number): string[] {
  const matches = text.match(/\b[A-Z][A-Za-z0-9-]+(?:\s+[A-Z][A-Za-z0-9-]+){0,2}\b/g) ?? [];
  return uniqueBy(
    matches.map((value) => normalizeWhitespace(value)),
    (value) => value.toLowerCase()
  ).slice(0, count);
}

function detectPolarity(text: string): Polarity {
  if (/\b(no|not|never|cannot|can't|won't|without)\b/i.test(text)) {
    return "negative";
  }
  if (/\b(is|are|will|does|supports|enables|improves|includes)\b/i.test(text)) {
    return "positive";
  }
  return "neutral";
}

function parseMarkdownNodes(text: string): MarkdownNode[] {
  try {
    const root = fromMarkdown(text) as { children?: MarkdownNode[] };
    return Array.isArray(root.children) ? root.children : [];
  } catch {
    return [];
  }
}

function markdownNodeText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "code") {
    return normalizeWhitespace(node.value ?? "");
  }
  if (node.type === "image") {
    return normalizeWhitespace(node.alt ?? "");
  }
  if (node.type === "break" || node.type === "thematicBreak") {
    return " ";
  }
  return normalizeWhitespace((node.children ?? []).map((child) => markdownNodeText(child)).join(" "));
}

function markdownNodesText(nodes: MarkdownNode[]): string {
  return normalizeWhitespace(nodes.map((node) => markdownNodeText(node)).join("\n"));
}

function stripLeadingTitleNodes(nodes: MarkdownNode[], title: string): MarkdownNode[] {
  const normalizedTitle = normalizeWhitespace(title);
  if (!normalizedTitle || !nodes.length) {
    return nodes;
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    const nodeText = markdownNodeText(node);
    if (node.type === "heading" && node.depth === 1 && nodeText === normalizedTitle) {
      return nodes.slice(index + 1);
    }
    if (node.type === "paragraph" && nodeText === normalizedTitle) {
      return nodes.slice(index + 1);
    }
    return nodes;
  }
  return nodes;
}

function markdownSectionNodes(nodes: MarkdownNode[], heading: string): MarkdownNode[] {
  const normalizedHeading = normalizeWhitespace(heading);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.type !== "heading" || node.depth !== 2) {
      continue;
    }
    if (markdownNodeText(node) !== normalizedHeading) {
      continue;
    }
    const sectionNodes: MarkdownNode[] = [];
    for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
      const candidate = nodes[cursor];
      if (candidate?.type === "heading" && typeof candidate.depth === "number" && candidate.depth <= 2) {
        break;
      }
      if (candidate) {
        sectionNodes.push(candidate);
      }
    }
    return sectionNodes;
  }
  return [];
}

function textForHeuristicAnalysis(manifest: SourceManifest, text: string): string {
  const nodes = parseMarkdownNodes(text);
  if (!nodes.length) {
    return normalizeWhitespace(text);
  }
  const sectionHeading = HEURISTIC_SECTION_SOURCE_KINDS.get(manifest.sourceKind);
  const scopedNodes = sectionHeading ? markdownSectionNodes(nodes, sectionHeading) : nodes;
  const relevantNodes = scopedNodes.length ? scopedNodes : nodes;
  const contentNodes = stripLeadingTitleNodes(relevantNodes, manifest.title);
  const normalized = markdownNodesText(contentNodes.length ? contentNodes : relevantNodes);
  return normalized || normalizeWhitespace(text);
}

function normalizeAnalysisTitle(manifest: SourceManifest, candidate: string): string {
  if (manifest.sourceKind !== "code") {
    return manifest.title;
  }
  const normalized = normalizeWhitespace(candidate.replace(/^#+\s+/, ""));
  if (!normalized) {
    return manifest.title;
  }
  if (normalized.length > 140 || normalized.includes(" ## ")) {
    return manifest.title;
  }
  return normalized;
}

function normalizeSourceAnalysis(manifest: SourceManifest, analysis: SourceAnalysis): SourceAnalysis {
  const title = normalizeAnalysisTitle(manifest, analysis.title);
  return title === analysis.title ? analysis : { ...analysis, title };
}

function heuristicAnalysis(manifest: SourceManifest, text: string, schemaHash: string): SourceAnalysis {
  const analysisText = textForHeuristicAnalysis(manifest, text);
  const normalized = normalizeWhitespace(analysisText);
  const concepts = extractTopTerms(normalized, 6).map((term) => ({
    id: `concept:${slugify(term)}`,
    name: term,
    description: `Frequently referenced concept in ${manifest.title}.`
  }));
  const entities = extractEntities(analysisText, 6).map((term) => ({
    id: `entity:${slugify(term)}`,
    name: term,
    description: `Named entity mentioned in ${manifest.title}.`
  }));
  const claimSentences = normalized
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 4);

  return {
    analysisVersion: ANALYSIS_FORMAT_VERSION,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash,
    title: manifest.title,
    summary: firstSentences(normalized, 3) || truncate(normalized, 280) || `Imported ${manifest.sourceKind} source.`,
    concepts,
    entities,
    claims: claimSentences.map((sentence, index) => ({
      id: `claim:${manifest.sourceId}:${index + 1}`,
      text: sentence,
      confidence: 0.55,
      status: "extracted",
      polarity: detectPolarity(sentence),
      citation: manifest.sourceId
    })),
    questions: concepts.slice(0, 3).map((term) => `How does ${term.name} relate to ${manifest.title}?`),
    tags: [],
    rationales: [],
    producedAt: new Date().toISOString()
  };
}

async function providerAnalysis(
  manifest: SourceManifest,
  text: string,
  provider: ProviderAdapter,
  schema: VaultSchema
): Promise<SourceAnalysis> {
  const parsed = await provider.generateStructured(
    {
      system: [
        "You are compiling a durable markdown wiki and graph. Prefer grounded synthesis over creativity.",
        "",
        "Follow the vault schema when choosing titles, categories, relationships, and summaries.",
        "",
        "Return up to 5 broad domain tags that categorize this source. Tags should be lowercase kebab-case (e.g., cryptography, distributed-systems, machine-learning). These are broader categories, not specific concepts or entity names.",
        "",
        `Vault schema path: ${schema.path}`,
        "",
        "Vault schema instructions:",
        truncate(schema.content, 6000)
      ].join("\n"),
      prompt: `Analyze the following source and return structured JSON.\n\nSource title: ${manifest.title}\nSource kind: ${manifest.sourceKind}\nSource id: ${manifest.sourceId}\n\nText:\n${truncate(text, 18000)}`
    },
    sourceAnalysisSchema
  );

  return {
    analysisVersion: ANALYSIS_FORMAT_VERSION,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash: schema.hash,
    title: parsed.title,
    summary: parsed.summary,
    concepts: parsed.concepts.map((term) => ({
      id: `concept:${slugify(term.name)}`,
      name: term.name,
      description: term.description
    })),
    entities: parsed.entities.map((term) => ({
      id: `entity:${slugify(term.name)}`,
      name: term.name,
      description: term.description
    })),
    claims: parsed.claims.map((claim, index) => ({
      id: `claim:${manifest.sourceId}:${index + 1}`,
      text: claim.text,
      confidence: claim.confidence,
      status: claim.status,
      polarity: claim.polarity,
      citation: claim.citation
    })),
    questions: parsed.questions,
    tags: parsed.tags,
    rationales: [],
    producedAt: new Date().toISOString()
  };
}

function analysisFromVisionExtraction(
  manifest: SourceManifest,
  extraction: SourceExtractionArtifact,
  schemaHash: string
): SourceAnalysis | null {
  if (!extraction.vision) {
    return null;
  }

  return {
    analysisVersion: ANALYSIS_FORMAT_VERSION,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash,
    title: extraction.vision.title?.trim() || manifest.title,
    summary: extraction.vision.summary,
    concepts: extraction.vision.concepts.map((term) => ({
      id: `concept:${slugify(term.name)}`,
      name: term.name,
      description: term.description
    })),
    entities: extraction.vision.entities.map((term) => ({
      id: `entity:${slugify(term.name)}`,
      name: term.name,
      description: term.description
    })),
    claims: extraction.vision.claims.map((claim, index) => ({
      id: `claim:${manifest.sourceId}:${index + 1}`,
      text: claim.text,
      confidence: claim.confidence,
      status: "extracted",
      polarity: claim.polarity,
      citation: manifest.sourceId
    })),
    questions: extraction.vision.questions,
    tags: [],
    rationales: [],
    producedAt: new Date().toISOString()
  };
}

function extractionWarningSummary(manifest: SourceManifest, extraction?: SourceExtractionArtifact): string {
  const warning = extraction?.warnings?.find(Boolean);
  if (warning) {
    return `Imported ${manifest.sourceKind} source. ${warning}`;
  }
  return `Imported ${manifest.sourceKind} source. Text extraction is not yet available for this source.`;
}

export async function analyzeSource(
  manifest: SourceManifest,
  extractedText: string | undefined,
  provider: ProviderAdapter,
  paths: ResolvedPaths,
  schema: VaultSchema
): Promise<SourceAnalysis> {
  const cachePath = path.join(paths.analysesDir, `${manifest.sourceId}.json`);
  const cached = await readJsonFile<SourceAnalysis>(cachePath);
  if (
    cached &&
    cached.analysisVersion === ANALYSIS_FORMAT_VERSION &&
    (cached.semanticHash ?? cached.sourceHash) === manifest.semanticHash &&
    cached.extractionHash === manifest.extractionHash &&
    cached.schemaHash === schema.hash
  ) {
    const normalizedCached = normalizeSourceAnalysis(manifest, cached);
    if (normalizedCached !== cached) {
      await writeJsonFile(cachePath, normalizedCached);
    }
    return normalizedCached;
  }

  const extraction = await readExtractionArtifact(paths.rootDir, manifest);
  const content = normalizeWhitespace(extractedText ?? "");
  let analysis: SourceAnalysis;

  if (manifest.sourceKind === "code" && content) {
    analysis = await analyzeCodeSource(manifest, extractedText ?? "", schema.hash);
  } else if (manifest.sourceKind === "image") {
    const visionAnalysis = extraction ? analysisFromVisionExtraction(manifest, extraction, schema.hash) : null;
    if (visionAnalysis) {
      analysis = visionAnalysis;
    } else if (!content) {
      analysis = {
        analysisVersion: ANALYSIS_FORMAT_VERSION,
        sourceId: manifest.sourceId,
        sourceHash: manifest.contentHash,
        semanticHash: manifest.semanticHash,
        extractionHash: manifest.extractionHash,
        schemaHash: schema.hash,
        title: manifest.title,
        summary: extractionWarningSummary(manifest, extraction),
        concepts: [],
        entities: [],
        claims: [],
        questions: [],
        tags: [],
        rationales: [],
        producedAt: new Date().toISOString()
      };
    } else if (provider.type === "heuristic") {
      analysis = heuristicAnalysis(manifest, content, schema.hash);
    } else {
      try {
        analysis = await providerAnalysis(manifest, content, provider, schema);
      } catch {
        analysis = heuristicAnalysis(manifest, content, schema.hash);
      }
    }
  } else if (!content) {
    analysis = {
      analysisVersion: ANALYSIS_FORMAT_VERSION,
      sourceId: manifest.sourceId,
      sourceHash: manifest.contentHash,
      semanticHash: manifest.semanticHash,
      extractionHash: manifest.extractionHash,
      schemaHash: schema.hash,
      title: manifest.title,
      summary: extractionWarningSummary(manifest, extraction),
      concepts: [],
      entities: [],
      claims: [],
      questions: [],
      tags: [],
      rationales: [],
      producedAt: new Date().toISOString()
    };
  } else if (provider.type === "heuristic") {
    analysis = heuristicAnalysis(manifest, content, schema.hash);
  } else {
    try {
      analysis = await providerAnalysis(manifest, content, provider, schema);
    } catch {
      analysis = heuristicAnalysis(manifest, content, schema.hash);
    }
  }

  const normalized = normalizeSourceAnalysis(manifest, analysis);
  await writeJsonFile(cachePath, normalized);
  return normalized;
}

export function analysisSignature(analysis: SourceAnalysis): string {
  return sha256(JSON.stringify(analysis));
}
