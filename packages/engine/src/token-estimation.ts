/**
 * LLM token estimation for context-window budgeting.
 *
 * Distinct from tokenize.ts (NLP tokenizer for search indexing).
 * This module estimates how many LLM tokens a piece of text will consume
 * and provides a priority-based trimming strategy for wiki output.
 */

/**
 * Estimate the number of LLM tokens for a text string.
 * Uses a blended heuristic: ~4 chars/token for prose, ~3 chars/token for code.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  let codeChars = 0;
  let proseChars = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // Heuristic: lines starting with code-like patterns count as code
    if (
      trimmed.startsWith("```") ||
      trimmed.startsWith("- `") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export ") ||
      trimmed.startsWith("const ") ||
      trimmed.startsWith("function ") ||
      trimmed.startsWith("class ") ||
      trimmed.startsWith("def ") ||
      trimmed.startsWith("fn ") ||
      /^\s*[{}[\]();]/.test(trimmed) ||
      /^\w+\s*[=:]\s*/.test(trimmed)
    ) {
      codeChars += line.length;
    } else {
      proseChars += line.length;
    }
  }
  // Code: ~3 chars/token, Prose: ~4 chars/token
  return Math.ceil(codeChars / 3 + proseChars / 4);
}

const KIND_WEIGHTS: Record<string, number> = {
  index: 10,
  graph_report: 8,
  module: 7,
  concept: 6,
  source: 5,
  community_summary: 5,
  entity: 4,
  output: 3,
  insight: 2
};

export interface PageTokenEstimate {
  pageId: string;
  path: string;
  kind: string;
  tokens: number;
  priority: number;
}

/**
 * Estimate tokens and priority for a wiki page.
 * Priority is based on page kind, node degree, and confidence.
 */
export function estimatePageTokens(
  pageId: string,
  path: string,
  kind: string,
  content: string,
  nodeDegree?: number,
  confidence?: number
): PageTokenEstimate {
  const tokens = estimateTokens(content);
  const kindWeight = KIND_WEIGHTS[kind] ?? 1;
  const priority = kindWeight * (1 + (nodeDegree ?? 0) * 0.1) * (confidence ?? 0.5);
  return { pageId, path, kind, tokens, priority };
}

export interface TokenBudgetResult {
  kept: PageTokenEstimate[];
  dropped: PageTokenEstimate[];
  totalTokens: number;
  budgetTokens: number;
  keptTokens: number;
}

/**
 * Given a set of page estimates and a token budget, return which pages to keep.
 * Lower-priority pages are dropped first. The boundary page is truncated if needed.
 */
export function trimToTokenBudget(pages: PageTokenEstimate[], maxTokens: number): TokenBudgetResult {
  const totalTokens = pages.reduce((sum, p) => sum + p.tokens, 0);
  if (totalTokens <= maxTokens) {
    return { kept: pages, dropped: [], totalTokens, budgetTokens: maxTokens, keptTokens: totalTokens };
  }

  // Sort by priority descending (highest priority kept first)
  const sorted = [...pages].sort((a, b) => b.priority - a.priority);
  const kept: PageTokenEstimate[] = [];
  const dropped: PageTokenEstimate[] = [];
  let accumulated = 0;

  for (const page of sorted) {
    if (accumulated + page.tokens <= maxTokens) {
      kept.push(page);
      accumulated += page.tokens;
    } else {
      dropped.push(page);
    }
  }

  return {
    kept,
    dropped,
    totalTokens,
    budgetTokens: maxTokens,
    keptTokens: accumulated
  };
}
