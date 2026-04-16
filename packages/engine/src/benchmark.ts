import { ALL_SOURCE_CLASSES } from "./source-classification.js";
import type {
  BenchmarkArtifact,
  BenchmarkByClassEntry,
  BenchmarkQuestionResult,
  GraphArtifact,
  GraphPage,
  GraphQueryResult,
  SourceClass
} from "./types.js";
import { normalizeWhitespace, sha256, uniqueBy } from "./utils.js";

const CHARS_PER_TOKEN = 4;

export const DEFAULT_BENCHMARK_QUESTIONS = [
  "How does this vault connect the main concepts?",
  "Which pages bridge the biggest communities?",
  "What are the core abstractions in this vault?",
  "Where are the biggest knowledge gaps?",
  "What evidence should I read first?"
];

const RESEARCH_BENCHMARK_QUESTION = "Which research sources should I read first, and why?";

function nodeMap(graph: GraphArtifact) {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function pageMap(graph: GraphArtifact) {
  return new Map(graph.pages.map((page) => [page.id, page]));
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function estimateCorpusWords(texts: string[]): number {
  return texts.reduce((total, text) => total + normalizeWhitespace(text).split(/\s+/).filter(Boolean).length, 0);
}

export function benchmarkQueryTokens(
  graph: GraphArtifact,
  queryResult: GraphQueryResult,
  pageContentsById: Map<string, string>
): BenchmarkQuestionResult {
  const nodesById = nodeMap(graph);
  const pagesById = pageMap(graph);
  const edgeIds = new Set(queryResult.visitedEdgeIds);
  const lines: string[] = [];

  for (const pageId of queryResult.pageIds) {
    const page = pagesById.get(pageId);
    if (!page) {
      continue;
    }
    const content = normalizeWhitespace(pageContentsById.get(pageId) ?? "").slice(0, 280);
    lines.push(`PAGE ${page.title} path=${page.path} kind=${page.kind}`);
    if (content) {
      lines.push(`PAGE_BODY ${content}`);
    }
  }

  for (const nodeId of queryResult.visitedNodeIds) {
    const node = nodesById.get(nodeId);
    if (!node) {
      continue;
    }
    lines.push(`NODE ${node.label} type=${node.type} community=${node.communityId ?? "unassigned"} page=${node.pageId ?? "none"}`);
  }

  for (const edge of graph.edges) {
    if (!edgeIds.has(edge.id)) {
      continue;
    }
    const source = nodesById.get(edge.source)?.label ?? edge.source;
    const target = nodesById.get(edge.target)?.label ?? edge.target;
    lines.push(`EDGE ${source} --${edge.relation}/${edge.evidenceClass}/${edge.confidence.toFixed(2)}--> ${target}`);
  }

  const queryTokens = estimateTokens(lines.join("\n"));
  return {
    question: queryResult.question,
    queryTokens,
    reduction: 0,
    visitedNodeIds: queryResult.visitedNodeIds,
    visitedEdgeIds: queryResult.visitedEdgeIds,
    pageIds: queryResult.pageIds
  };
}

export function graphHash(graph: GraphArtifact): string {
  const hashedPages = graph.pages.filter((page) => page.kind !== "graph_report" && page.kind !== "community_summary");
  const normalized = JSON.stringify(
    {
      nodes: [...graph.nodes]
        .map((node) => ({
          id: node.id,
          type: node.type,
          label: node.label,
          pageId: node.pageId ?? null,
          sourceClass: node.sourceClass ?? null,
          communityId: node.communityId ?? null,
          degree: node.degree ?? null,
          bridgeScore: node.bridgeScore ?? null,
          isGodNode: node.isGodNode ?? false,
          sourceIds: [...node.sourceIds].sort(),
          projectIds: [...node.projectIds].sort()
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...graph.edges]
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          status: edge.status,
          evidenceClass: edge.evidenceClass,
          similarityBasis: edge.similarityBasis ?? null,
          confidence: edge.confidence,
          provenance: [...edge.provenance].sort()
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      pages: [...hashedPages]
        .map((page) => ({
          id: page.id,
          path: page.path,
          kind: page.kind,
          status: page.status,
          sourceType: page.sourceType ?? null,
          sourceClass: page.sourceClass ?? null,
          sourceIds: [...page.sourceIds].sort(),
          projectIds: [...page.projectIds].sort(),
          nodeIds: [...page.nodeIds].sort()
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      communities: [...(graph.communities ?? [])]
        .map((community) => ({
          id: community.id,
          label: community.label,
          nodeIds: [...community.nodeIds].sort()
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    },
    null,
    0
  );
  return sha256(normalized);
}

function hasResearchSources(pages: GraphPage[]): boolean {
  return pages.some((page) => page.kind === "source" && Boolean(page.sourceType) && page.sourceType !== "url");
}

export function defaultBenchmarkQuestionsForGraph(graph: GraphArtifact, maxQuestions = 3): string[] {
  const normalizedLimit = Math.max(1, Math.min(maxQuestions, DEFAULT_BENCHMARK_QUESTIONS.length));
  const questions = [...DEFAULT_BENCHMARK_QUESTIONS];
  if (hasResearchSources(graph.pages)) {
    questions.unshift(RESEARCH_BENCHMARK_QUESTION);
  }
  return uniqueBy(questions, (item) => item).slice(0, normalizedLimit);
}

/**
 * Build the per-source-class slice of a benchmark artifact. The resulting
 * record always has one entry per {@link ALL_SOURCE_CLASSES} member so
 * callers never have to branch on `undefined`; classes absent from the vault
 * collapse to zeroed entries. `perQuestion` values are already class-scoped
 * by the caller, and corpus tokens are recomputed from `corpusWords` using
 * the same 75-words-per-100-tokens ratio that
 * {@link buildBenchmarkArtifact} applies to the aggregate.
 */
export function buildBenchmarkByClass(input: {
  graph: GraphArtifact;
  perClassCorpusWords: Record<SourceClass, number>;
  perClassPerQuestion: Record<SourceClass, BenchmarkQuestionResult[]>;
}): Record<SourceClass, BenchmarkByClassEntry> {
  const entries = {} as Record<SourceClass, BenchmarkByClassEntry>;
  for (const sourceClass of ALL_SOURCE_CLASSES) {
    const corpusWords = Math.max(0, Math.round(input.perClassCorpusWords[sourceClass] ?? 0));
    const corpusTokens = corpusWords > 0 ? Math.max(1, Math.round(corpusWords * (100 / 75))) : 0;
    const sourceCount = input.graph.sources.filter((source) => source.sourceClass === sourceClass).length;
    const pageCount = input.graph.pages.filter((page) => page.sourceClass === sourceClass).length;
    const nodeCount = input.graph.nodes.filter((node) => node.sourceClass === sourceClass).length;
    const godNodeCount = input.graph.nodes.filter((node) => node.sourceClass === sourceClass && Boolean(node.isGodNode)).length;
    const perQuestionRaw = input.perClassPerQuestion[sourceClass] ?? [];
    const perQuestion = perQuestionRaw
      .filter((entry) => entry.queryTokens > 0)
      .map((entry) => ({
        ...entry,
        reduction: corpusTokens > 0 ? Number((1 - entry.queryTokens / Math.max(1, corpusTokens)).toFixed(3)) : 0
      }));
    const finalContextTokens = perQuestion.length
      ? Math.max(1, Math.round(perQuestion.reduce((total, entry) => total + entry.queryTokens, 0) / perQuestion.length))
      : 0;
    const reductionRatio =
      finalContextTokens && corpusTokens > 0 ? Number((1 - finalContextTokens / Math.max(1, corpusTokens)).toFixed(3)) : 0;
    entries[sourceClass] = {
      sourceClass,
      sourceCount,
      pageCount,
      nodeCount,
      godNodeCount,
      corpusWords,
      corpusTokens,
      finalContextTokens,
      reductionRatio,
      perQuestion
    };
  }
  return entries;
}

export function buildBenchmarkArtifact(input: {
  graph: GraphArtifact;
  corpusWords: number;
  questions: string[];
  perQuestion: BenchmarkQuestionResult[];
  byClass?: Record<SourceClass, BenchmarkByClassEntry>;
}): BenchmarkArtifact {
  const corpusTokens = Math.max(1, Math.round(input.corpusWords * (100 / 75)));
  const perQuestion = input.perQuestion
    .filter((entry) => entry.queryTokens > 0)
    .map((entry) => ({
      ...entry,
      // Honest reduction: negative values mean graph context is larger than the
      // full corpus, which is the truth on very small vaults. Clamping to zero
      // hid that signal.
      reduction: Number((1 - entry.queryTokens / Math.max(1, corpusTokens)).toFixed(3))
    }));
  const avgQueryTokens = perQuestion.length
    ? Math.max(1, Math.round(perQuestion.reduce((total, entry) => total + entry.queryTokens, 0) / perQuestion.length))
    : 0;
  const reductionRatio = avgQueryTokens ? Number((1 - avgQueryTokens / Math.max(1, corpusTokens)).toFixed(3)) : 0;
  const uniqueVisitedNodes = new Set(perQuestion.flatMap((entry) => entry.visitedNodeIds)).size;
  const summary = {
    questionCount: input.questions.length,
    uniqueVisitedNodes,
    finalContextTokens: avgQueryTokens,
    naiveCorpusTokens: corpusTokens,
    avgReduction: reductionRatio,
    reductionRatio
  } satisfies BenchmarkArtifact["summary"];

  const emptyPerClassWords = {
    first_party: 0,
    third_party: 0,
    resource: 0,
    generated: 0
  } satisfies Record<SourceClass, number>;
  const emptyPerClassQuestions = {
    first_party: [] as BenchmarkQuestionResult[],
    third_party: [] as BenchmarkQuestionResult[],
    resource: [] as BenchmarkQuestionResult[],
    generated: [] as BenchmarkQuestionResult[]
  } satisfies Record<SourceClass, BenchmarkQuestionResult[]>;
  const byClass =
    input.byClass ??
    buildBenchmarkByClass({
      graph: input.graph,
      perClassCorpusWords: emptyPerClassWords,
      perClassPerQuestion: emptyPerClassQuestions
    });

  return {
    generatedAt: new Date().toISOString(),
    graphHash: graphHash(input.graph),
    corpusWords: input.corpusWords,
    corpusTokens,
    nodes: input.graph.nodes.length,
    edges: input.graph.edges.length,
    avgQueryTokens,
    reductionRatio,
    sampleQuestions: input.questions,
    perQuestion,
    summary,
    byClass
  };
}
