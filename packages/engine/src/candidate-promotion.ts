import type { CandidatePromotionConfig, CompileState, GraphArtifact, GraphPage, PromotionDecision, PromotionGateResult } from "./types.js";

export const DEFAULT_PROMOTION_CONFIG: CandidatePromotionConfig = {
  enabled: false,
  minSources: 3,
  minConfidence: 0.8,
  minAgreement: 0.7,
  minDegree: 2,
  minAgeHours: 24,
  maxPerRun: 25,
  dryRun: false
};

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set<string>([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection++;
  }
  return intersection / union.size;
}

function hoursSince(iso: string, now: number): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, (now - then) / (1000 * 60 * 60));
}

function maxDegreeFor(graph: GraphArtifact, nodeIds: readonly string[]): number {
  let best = 0;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const nodeId of nodeIds) {
    const node = byId.get(nodeId);
    if (node && (node.degree ?? 0) > best) best = node.degree ?? 0;
  }
  return best;
}

function describeGate(result: PromotionGateResult): string {
  const verb = result.passed ? ">=" : "<";
  return `${result.gate} ${result.value.toFixed(2)} ${verb} ${result.threshold.toFixed(2)}`;
}

export function evaluateCandidateForPromotion(
  page: GraphPage,
  graph: GraphArtifact,
  history: CompileState["candidateHistory"] | undefined,
  config: CandidatePromotionConfig,
  now: number = Date.now()
): PromotionDecision {
  const historical = history?.[page.id];
  const historicalSources = historical?.sourceIds ?? [];
  const agreement = historicalSources.length ? jaccard(historicalSources, page.sourceIds) : 0;
  const degree = maxDegreeFor(graph, page.nodeIds);
  const ageHours = hoursSince(page.createdAt, now);

  const gates: PromotionGateResult[] = [
    { gate: "sources", value: page.sourceIds.length, threshold: config.minSources, passed: page.sourceIds.length >= config.minSources },
    { gate: "confidence", value: page.confidence, threshold: config.minConfidence, passed: page.confidence >= config.minConfidence },
    { gate: "agreement", value: agreement, threshold: config.minAgreement, passed: agreement >= config.minAgreement },
    { gate: "degree", value: degree, threshold: config.minDegree, passed: degree >= config.minDegree },
    { gate: "age", value: ageHours, threshold: config.minAgeHours, passed: ageHours >= config.minAgeHours }
  ];

  const passedCount = gates.filter((gate) => gate.passed).length;
  const promote = gates.every((gate) => gate.passed);
  const score = passedCount / gates.length;

  return {
    pageId: page.id,
    title: page.title,
    kind: page.kind as "concept" | "entity",
    promote,
    score,
    gates,
    reasons: gates.map(describeGate)
  };
}

export function sortDecisionsForPromotion(decisions: PromotionDecision[]): PromotionDecision[] {
  return [...decisions].sort((left, right) => {
    if (left.promote !== right.promote) return left.promote ? -1 : 1;
    if (right.score !== left.score) return right.score - left.score;
    return left.pageId.localeCompare(right.pageId);
  });
}

export function renderPromotionSessionMarkdown(
  decisions: PromotionDecision[],
  promotedPageIds: string[],
  options: { dryRun: boolean; startedAt: string; finishedAt: string }
): string {
  const lines: string[] = [];
  lines.push(`# Auto-Promotion Run`);
  lines.push("");
  lines.push(`- started: ${options.startedAt}`);
  lines.push(`- finished: ${options.finishedAt}`);
  lines.push(`- mode: ${options.dryRun ? "dry-run" : "applied"}`);
  lines.push(`- promoted: ${promotedPageIds.length}`);
  lines.push(`- evaluated: ${decisions.length}`);
  lines.push("");
  lines.push(`| page | decision | score | reasons |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const decision of sortDecisionsForPromotion(decisions)) {
    const decided = decision.promote ? (promotedPageIds.includes(decision.pageId) ? "promoted" : "promote (dry-run)") : "skipped";
    lines.push(`| ${decision.pageId} | ${decided} | ${decision.score.toFixed(2)} | ${decision.reasons.join("; ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}
