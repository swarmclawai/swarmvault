import type { BenchmarkArtifact, BenchmarkQuestionResult, GraphArtifact, GraphQueryResult } from "./types.js";
import { normalizeWhitespace } from "./utils.js";

const CHARS_PER_TOKEN = 4;

export const DEFAULT_BENCHMARK_QUESTIONS = [
  "How does this vault connect the main concepts?",
  "Which pages bridge the biggest communities?",
  "What are the core abstractions in this vault?",
  "Where are the biggest knowledge gaps?",
  "What evidence should I read first?"
];

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
    pageIds: queryResult.pageIds
  };
}

export function buildBenchmarkArtifact(input: {
  graph: GraphArtifact;
  corpusWords: number;
  questions: string[];
  perQuestion: BenchmarkQuestionResult[];
}): BenchmarkArtifact {
  const corpusTokens = Math.max(1, Math.round(input.corpusWords * (100 / 75)));
  const perQuestion = input.perQuestion
    .filter((entry) => entry.queryTokens > 0)
    .map((entry) => ({
      ...entry,
      reduction: Number(Math.max(0, 1 - entry.queryTokens / Math.max(1, corpusTokens)).toFixed(3))
    }));
  const avgQueryTokens = perQuestion.length
    ? Math.max(1, Math.round(perQuestion.reduce((total, entry) => total + entry.queryTokens, 0) / perQuestion.length))
    : 0;
  const reductionRatio = avgQueryTokens ? Number(Math.max(0, 1 - avgQueryTokens / Math.max(1, corpusTokens)).toFixed(3)) : 0;

  return {
    generatedAt: new Date().toISOString(),
    corpusWords: input.corpusWords,
    corpusTokens,
    nodes: input.graph.nodes.length,
    edges: input.graph.edges.length,
    avgQueryTokens,
    reductionRatio,
    sampleQuestions: input.questions,
    perQuestion
  };
}
