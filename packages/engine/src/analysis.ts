import path from "node:path";
import { z } from "zod";
import { analyzeCodeSource } from "./code-analysis.js";
import type { VaultSchema } from "./schema.js";
import type { Polarity, ProviderAdapter, ResolvedPaths, SourceAnalysis, SourceManifest } from "./types.js";
import { firstSentences, normalizeWhitespace, readJsonFile, sha256, slugify, truncate, uniqueBy, writeJsonFile } from "./utils.js";

const ANALYSIS_FORMAT_VERSION = 4;

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
  questions: z.array(z.string()).max(6).default([])
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

function deriveTitle(manifest: SourceManifest, text: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || manifest.title;
}

function heuristicAnalysis(manifest: SourceManifest, text: string, schemaHash: string): SourceAnalysis {
  const normalized = normalizeWhitespace(text);
  const concepts = extractTopTerms(normalized, 6).map((term) => ({
    id: `concept:${slugify(term)}`,
    name: term,
    description: `Frequently referenced concept in ${manifest.title}.`
  }));
  const entities = extractEntities(text, 6).map((term) => ({
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
    schemaHash,
    title: deriveTitle(manifest, text),
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
    rationales: [],
    producedAt: new Date().toISOString()
  };
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
    cached.sourceHash === manifest.contentHash &&
    cached.schemaHash === schema.hash
  ) {
    return cached;
  }

  const content = normalizeWhitespace(extractedText ?? "");
  let analysis: SourceAnalysis;

  if (manifest.sourceKind === "code" && content) {
    analysis = await analyzeCodeSource(manifest, extractedText ?? "", schema.hash);
  } else if (!content) {
    analysis = {
      analysisVersion: ANALYSIS_FORMAT_VERSION,
      sourceId: manifest.sourceId,
      sourceHash: manifest.contentHash,
      schemaHash: schema.hash,
      title: manifest.title,
      summary: `Imported ${manifest.sourceKind} source. Text extraction is not yet available for this source.`,
      concepts: [],
      entities: [],
      claims: [],
      questions: [],
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

  await writeJsonFile(cachePath, analysis);
  return analysis;
}

export function analysisSignature(analysis: SourceAnalysis): string {
  return sha256(JSON.stringify(analysis));
}
