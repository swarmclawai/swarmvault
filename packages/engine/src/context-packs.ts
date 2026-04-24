import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "./config.js";
import { recordSession } from "./logs.js";
import { estimateTokens } from "./token-estimation.js";
import type {
  BuildContextPackOptions,
  BuildContextPackResult,
  ContextPack,
  ContextPackFormat,
  ContextPackItem,
  ContextPackItemKind,
  ContextPackOmittedItem,
  ContextPackSummary,
  GraphArtifact,
  GraphEdge,
  GraphHyperedge,
  GraphNode,
  GraphPage
} from "./types.js";
import {
  ensureDir,
  fileExists,
  isPathWithin,
  normalizeWhitespace,
  readJsonFile,
  slugify,
  toPosix,
  truncate,
  uniqueBy,
  writeJsonFile
} from "./utils.js";
import { compileVault, explainGraphVault, queryGraphVault, readPage, searchVault } from "./vault.js";

const DEFAULT_CONTEXT_BUDGET_TOKENS = 8000;
const MIN_CONTEXT_BUDGET_TOKENS = 200;
const MAX_PAGE_EXCERPT_CHARS = 2200;
const MAX_NODE_EXCERPT_CHARS = 900;

type ContextPackCandidate = Omit<ContextPackItem, "estimatedTokens">;

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function contextPackDirs(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"]): { stateDir: string; wikiDir: string } {
  return {
    stateDir: path.join(paths.stateDir, "context-packs"),
    wikiDir: path.join(paths.wikiDir, "context")
  };
}

function contextPackSummary(pack: ContextPack): ContextPackSummary {
  return {
    id: pack.id,
    title: pack.title,
    goal: pack.goal,
    target: pack.target,
    createdAt: pack.createdAt,
    budgetTokens: pack.budgetTokens,
    estimatedTokens: pack.estimatedTokens,
    artifactPath: pack.artifactPath,
    markdownPath: pack.markdownPath,
    itemCount: pack.items.length,
    omittedCount: pack.omittedItems.length
  };
}

async function ensureCompiledGraph(rootDir: string): Promise<GraphArtifact> {
  const { paths } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.graphPath)) || !(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir, {});
  }
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` first.");
  }
  return graph;
}

function candidateId(kind: ContextPackItemKind, id: string): string {
  return `${kind}:${id}`;
}

function pageExcerpt(content: string): string {
  return truncate(normalizeWhitespace(content), MAX_PAGE_EXCERPT_CHARS);
}

function nodeExcerpt(node: GraphNode): string {
  const parts = [
    `Node type: ${node.type}.`,
    node.freshness ? `Freshness: ${node.freshness}.` : undefined,
    node.confidence === undefined ? undefined : `Confidence: ${node.confidence}.`,
    node.degree === undefined ? undefined : `Degree: ${node.degree}.`,
    node.bridgeScore === undefined ? undefined : `Bridge score: ${node.bridgeScore}.`,
    node.surpriseReason
  ].filter((part): part is string => Boolean(part));
  return truncate(parts.join(" "), MAX_NODE_EXCERPT_CHARS);
}

function edgeTitle(edge: GraphEdge, nodesById: Map<string, GraphNode>): string {
  const source = nodesById.get(edge.source)?.label ?? edge.source;
  const target = nodesById.get(edge.target)?.label ?? edge.target;
  return `${source} ${edge.relation} ${target}`;
}

function edgeExcerpt(edge: GraphEdge): string {
  const provenance = edge.provenance.length ? ` Provenance: ${edge.provenance.join(", ")}.` : "";
  return `Relation: ${edge.relation}. Evidence: ${edge.evidenceClass}. Confidence: ${edge.confidence}.${provenance}`;
}

function hyperedgeExcerpt(hyperedge: GraphHyperedge): string {
  const sources = hyperedge.sourcePageIds.length ? ` Source pages: ${hyperedge.sourcePageIds.join(", ")}.` : "";
  return `Group pattern: ${hyperedge.relation}. Evidence: ${hyperedge.evidenceClass}. Confidence: ${hyperedge.confidence}. ${hyperedge.why}${sources}`;
}

async function buildPageCandidate(rootDir: string, page: GraphPage, reason: string, score: number): Promise<ContextPackCandidate | null> {
  const stored = await readPage(rootDir, page.path);
  if (!stored) {
    return null;
  }
  return {
    id: candidateId("page", page.id),
    kind: "page",
    title: page.title,
    reason,
    score,
    excerpt: pageExcerpt(stored.content),
    path: page.path,
    pageId: page.id,
    sourceIds: page.sourceIds,
    pageIds: [page.id],
    nodeIds: page.nodeIds,
    edgeIds: [],
    freshness: page.freshness,
    confidence: page.confidence
  };
}

function buildNodeCandidate(node: GraphNode, reason: string, score: number): ContextPackCandidate {
  return {
    id: candidateId("node", node.id),
    kind: "node",
    title: node.label,
    reason,
    score,
    excerpt: nodeExcerpt(node),
    pageId: node.pageId,
    nodeId: node.id,
    sourceIds: node.sourceIds,
    pageIds: node.pageId ? [node.pageId] : [],
    nodeIds: [node.id],
    edgeIds: [],
    freshness: node.freshness,
    confidence: node.confidence
  };
}

function buildEdgeCandidate(edge: GraphEdge, nodesById: Map<string, GraphNode>, reason: string, score: number): ContextPackCandidate {
  return {
    id: candidateId("edge", edge.id),
    kind: "edge",
    title: edgeTitle(edge, nodesById),
    reason,
    score,
    excerpt: edgeExcerpt(edge),
    edgeId: edge.id,
    sourceIds: edge.provenance,
    pageIds: [],
    nodeIds: [edge.source, edge.target],
    edgeIds: [edge.id],
    evidenceClass: edge.evidenceClass,
    confidence: edge.confidence
  };
}

function buildHyperedgeCandidate(hyperedge: GraphHyperedge, reason: string, score: number): ContextPackCandidate {
  return {
    id: candidateId("hyperedge", hyperedge.id),
    kind: "hyperedge",
    title: hyperedge.label,
    reason,
    score,
    excerpt: hyperedgeExcerpt(hyperedge),
    hyperedgeId: hyperedge.id,
    sourceIds: [],
    pageIds: hyperedge.sourcePageIds,
    nodeIds: hyperedge.nodeIds,
    edgeIds: [],
    evidenceClass: hyperedge.evidenceClass,
    confidence: hyperedge.confidence
  };
}

function contextItemHeader(item: ContextPackItem): string {
  const lines = [`### ${item.kind}: ${item.title}`, "", `- Reason: ${item.reason}`];
  if (item.path) lines.push(`- Path: wiki/${item.path}`);
  if (item.pageId) lines.push(`- Page ID: ${item.pageId}`);
  if (item.nodeId) lines.push(`- Node ID: ${item.nodeId}`);
  if (item.edgeId) lines.push(`- Edge ID: ${item.edgeId}`);
  if (item.hyperedgeId) lines.push(`- Hyperedge ID: ${item.hyperedgeId}`);
  if (item.freshness) lines.push(`- Freshness: ${item.freshness}`);
  if (item.evidenceClass) lines.push(`- Evidence: ${item.evidenceClass}`);
  if (item.confidence !== undefined) lines.push(`- Confidence: ${item.confidence}`);
  lines.push(`- Sources: ${item.sourceIds.join(", ") || "none"}`);
  return lines.join("\n");
}

function renderContextItem(item: ContextPackItem): string {
  return [contextItemHeader(item), "", item.excerpt ? item.excerpt : "No excerpt available.", ""].join("\n");
}

function withEstimatedTokens(candidate: ContextPackCandidate): ContextPackItem {
  const item = {
    ...candidate,
    sourceIds: uniqueStrings(candidate.sourceIds),
    pageIds: uniqueStrings(candidate.pageIds),
    nodeIds: uniqueStrings(candidate.nodeIds),
    edgeIds: uniqueStrings(candidate.edgeIds)
  } satisfies ContextPackCandidate;
  return {
    ...item,
    estimatedTokens: estimateTokens(renderContextItem({ ...item, estimatedTokens: 0 }))
  };
}

function shrinkItemToBudget(item: ContextPackItem, remainingTokens: number): ContextPackItem | null {
  if (!item.excerpt || remainingTokens < 80) {
    return null;
  }
  const charBudget = Math.max(160, remainingTokens * 3);
  const shrunk = {
    ...item,
    excerpt: truncate(item.excerpt, charBudget)
  };
  const estimatedTokens = estimateTokens(renderContextItem({ ...shrunk, estimatedTokens: 0 }));
  if (estimatedTokens > remainingTokens) {
    return null;
  }
  return { ...shrunk, estimatedTokens };
}

function fitItemsToBudget(
  candidates: ContextPackCandidate[],
  budgetTokens: number
): { items: ContextPackItem[]; omittedItems: ContextPackOmittedItem[] } {
  const estimated = candidates
    .map(withEstimatedTokens)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  const items: ContextPackItem[] = [];
  const omittedItems: ContextPackOmittedItem[] = [];
  let usedTokens = estimateTokens("# Context Pack\n\n## Included Context\n\n");

  for (const item of estimated) {
    const remaining = budgetTokens - usedTokens;
    if (item.estimatedTokens <= remaining) {
      items.push(item);
      usedTokens += item.estimatedTokens;
      continue;
    }

    const shrunk = items.length === 0 ? shrinkItemToBudget(item, remaining) : null;
    if (shrunk) {
      items.push(shrunk);
      usedTokens += shrunk.estimatedTokens;
      continue;
    }

    omittedItems.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      reason: "token_budget_exceeded",
      estimatedTokens: item.estimatedTokens
    });
  }

  return { items, omittedItems };
}

function collectRelatedIds(
  items: ContextPackItem[],
  graphQuery: ContextPack["graphQuery"]
): Pick<ContextPack, "citations" | "relatedPageIds" | "relatedNodeIds" | "relatedSourceIds"> {
  const relatedPageIds = uniqueStrings([...graphQuery.pageIds, ...items.flatMap((item) => item.pageIds)]);
  const relatedNodeIds = uniqueStrings([...graphQuery.visitedNodeIds, ...items.flatMap((item) => item.nodeIds)]);
  const relatedSourceIds = uniqueStrings(items.flatMap((item) => item.sourceIds));
  return {
    citations: relatedSourceIds,
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds
  };
}

function titleForGoal(goal: string): string {
  return `Context Pack: ${truncate(normalizeWhitespace(goal), 72)}`;
}

async function uniqueContextPackPaths(
  rootDir: string,
  createdAt: string,
  goal: string
): Promise<{ id: string; artifactPath: string; markdownPath: string }> {
  const { paths } = await loadVaultConfig(rootDir);
  const dirs = contextPackDirs(paths);
  await ensureDir(dirs.stateDir);
  await ensureDir(dirs.wikiDir);

  const timestamp = createdAt.replace(/[:.]/g, "-");
  const base = `${timestamp}-${slugify(goal)}`;
  let id = base;
  let artifactPath = path.join(dirs.stateDir, `${id}.json`);
  let markdownPath = path.join(dirs.wikiDir, `${id}.md`);
  let counter = 2;
  while ((await fileExists(artifactPath)) || (await fileExists(markdownPath))) {
    id = `${base}-${counter}`;
    artifactPath = path.join(dirs.stateDir, `${id}.json`);
    markdownPath = path.join(dirs.wikiDir, `${id}.md`);
    counter++;
  }
  return { id, artifactPath, markdownPath };
}

export function renderContextPackMarkdown(pack: ContextPack): string {
  const lines = [
    `# ${pack.title}`,
    "",
    `Goal: ${pack.goal}`,
    pack.target ? `Target: ${pack.target}` : undefined,
    `Created: ${pack.createdAt}`,
    `Budget: ${pack.budgetTokens} tokens`,
    `Estimated: ${pack.estimatedTokens} tokens`,
    "",
    "## Agent Instructions",
    "",
    "Use this pack as bounded SwarmVault context. Prefer cited source IDs and page IDs over unsupported inference. If the task needs omitted context, ask for a larger budget or a narrower target.",
    "",
    "## Graph Orientation",
    "",
    "```text",
    pack.graphQuery.summary,
    "```",
    "",
    "## Included Context",
    "",
    pack.items.length ? pack.items.map(renderContextItem).join("\n") : "No context items fit the requested token budget.",
    "",
    "## Omitted Context",
    "",
    pack.omittedItems.length
      ? pack.omittedItems.map((item) => `- ${item.kind}: ${item.title} (${item.reason}, ~${item.estimatedTokens} tokens)`).join("\n")
      : "- none",
    "",
    "## Citations",
    "",
    pack.citations.length ? pack.citations.map((citation) => `- ${citation}`).join("\n") : "- none",
    ""
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function renderContextPackLlms(pack: ContextPack): string {
  return [
    `# ${pack.title}`,
    "",
    `Goal: ${pack.goal}`,
    pack.target ? `Target: ${pack.target}` : undefined,
    "",
    "Use these cited vault facts as the working context. Do not treat omitted items as absent from the vault.",
    "",
    "## Files and Pages",
    "",
    pack.items
      .filter((item) => item.kind === "page")
      .map((item) => `- ${item.path ?? item.pageId}: ${item.title} | sources=${item.sourceIds.join(",") || "none"}`)
      .join("\n") || "- none",
    "",
    "## Evidence",
    "",
    pack.items.map((item) => renderContextItem(item)).join("\n"),
    "",
    "## Omitted",
    "",
    pack.omittedItems.length ? pack.omittedItems.map((item) => `- ${item.id}: ${item.reason}`).join("\n") : "- none",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderForFormat(pack: ContextPack, format: ContextPackFormat): string {
  if (format === "json") {
    return JSON.stringify(pack, null, 2);
  }
  if (format === "llms") {
    return renderContextPackLlms(pack);
  }
  return renderContextPackMarkdown(pack);
}

function markdownPageForPack(pack: ContextPack): string {
  const relativeArtifactPath = toPosix(path.relative(path.dirname(pack.markdownPath), pack.artifactPath));
  return matter.stringify(renderContextPackMarkdown(pack), {
    page_id: `context:${pack.id}`,
    kind: "output",
    title: pack.title,
    tags: ["context-pack", "agent-memory"],
    source_ids: pack.relatedSourceIds,
    node_ids: pack.relatedNodeIds,
    freshness: "fresh",
    status: "active",
    confidence: 1,
    created_at: pack.createdAt,
    updated_at: pack.createdAt,
    managed_by: "system",
    context_pack_id: pack.id,
    goal: pack.goal,
    target: pack.target,
    budget_tokens: pack.budgetTokens,
    estimated_tokens: pack.estimatedTokens,
    artifact_path: relativeArtifactPath
  });
}

export async function buildContextPack(rootDir: string, options: BuildContextPackOptions): Promise<BuildContextPackResult> {
  const goal = normalizeWhitespace(options.goal);
  if (!goal) {
    throw new Error("Context pack goal is required.");
  }
  const createdAt = new Date().toISOString();
  const format = options.format ?? "markdown";
  const budgetTokens = Math.max(MIN_CONTEXT_BUDGET_TOKENS, options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS);
  const graph = await ensureCompiledGraph(rootDir);
  const queryText = options.target ? `${goal} ${options.target}` : goal;
  const graphQuery = await queryGraphVault(rootDir, queryText, {
    budget: Math.max(8, Math.min(50, Math.ceil(budgetTokens / 350)))
  });
  const searchResults = await searchVault(rootDir, queryText, 10);
  const pagesById = new Map(graph.pages.map((page) => [page.id, page]));
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const hyperedgesById = new Map((graph.hyperedges ?? []).map((hyperedge) => [hyperedge.id, hyperedge]));
  const candidates = new Map<string, ContextPackCandidate>();

  const addCandidate = (candidate: ContextPackCandidate | null) => {
    if (!candidate) return;
    const existing = candidates.get(candidate.id);
    if (!existing || candidate.score > existing.score) {
      candidates.set(candidate.id, candidate);
    }
  };

  if (options.target) {
    const explanation = await explainGraphVault(rootDir, options.target).catch(() => null);
    if (explanation?.node) {
      addCandidate(buildNodeCandidate(explanation.node, "target explanation", 120));
      if (explanation.page) {
        addCandidate(await buildPageCandidate(rootDir, explanation.page, "target page", 118));
      }
      for (const neighbor of explanation.neighbors.slice(0, 6)) {
        const node = nodesById.get(neighbor.nodeId);
        if (node) {
          addCandidate(buildNodeCandidate(node, `target neighbor via ${neighbor.relation}`, 86));
        }
      }
      for (const hyperedge of explanation.hyperedges.slice(0, 4)) {
        addCandidate(buildHyperedgeCandidate(hyperedge, "target group pattern", 84));
      }
    }
  }

  for (const [index, pageId] of graphQuery.pageIds.entries()) {
    const page = pagesById.get(pageId);
    addCandidate(page ? await buildPageCandidate(rootDir, page, "graph traversal page", 100 - index) : null);
  }
  for (const [index, result] of searchResults.entries()) {
    const page = pagesById.get(result.pageId);
    addCandidate(page ? await buildPageCandidate(rootDir, page, `local search hit: ${result.snippet || result.title}`, 92 - index) : null);
  }
  for (const [index, nodeId] of graphQuery.visitedNodeIds.entries()) {
    const node = nodesById.get(nodeId);
    if (node) {
      addCandidate(buildNodeCandidate(node, "graph traversal node", 76 - Math.min(index, 30)));
    }
  }
  for (const [index, edgeId] of graphQuery.visitedEdgeIds.entries()) {
    const edge = edgesById.get(edgeId);
    if (edge) {
      addCandidate(buildEdgeCandidate(edge, nodesById, "graph traversal edge", 70 - Math.min(index, 25)));
    }
  }
  for (const [index, hyperedgeId] of graphQuery.hyperedgeIds.entries()) {
    const hyperedge = hyperedgesById.get(hyperedgeId);
    if (hyperedge) {
      addCandidate(buildHyperedgeCandidate(hyperedge, "graph group pattern", 68 - Math.min(index, 20)));
    }
  }

  const { items, omittedItems } = fitItemsToBudget([...candidates.values()], budgetTokens);
  const paths = await uniqueContextPackPaths(rootDir, createdAt, goal);
  const related = collectRelatedIds(items, graphQuery);
  const pack: ContextPack = {
    id: paths.id,
    title: titleForGoal(goal),
    goal,
    target: options.target,
    createdAt,
    format,
    budgetTokens,
    estimatedTokens: estimateTokens(items.map(renderContextItem).join("\n")),
    artifactPath: paths.artifactPath,
    markdownPath: paths.markdownPath,
    ...related,
    graphQuery,
    items,
    omittedItems
  };

  await writeJsonFile(paths.artifactPath, pack);
  await fs.writeFile(paths.markdownPath, markdownPageForPack(pack), "utf8");
  await recordSession(rootDir, {
    operation: "context",
    title: goal,
    startedAt: createdAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedSourceIds: pack.relatedSourceIds,
    relatedPageIds: pack.relatedPageIds,
    relatedNodeIds: pack.relatedNodeIds,
    changedPages: [toPosix(path.relative(rootDir, paths.markdownPath)), toPosix(path.relative(rootDir, paths.artifactPath))],
    citations: pack.citations,
    lines: [
      `Context pack: ${pack.id}`,
      `Budget: ${pack.budgetTokens} tokens`,
      `Included: ${pack.items.length}`,
      `Omitted: ${pack.omittedItems.length}`
    ]
  });

  return {
    pack,
    artifactPath: paths.artifactPath,
    markdownPath: paths.markdownPath,
    rendered: renderForFormat(pack, format)
  };
}

export async function listContextPacks(rootDir: string): Promise<ContextPackSummary[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const dirs = contextPackDirs(paths);
  const entries = await fs.readdir(dirs.stateDir, { withFileTypes: true }).catch(() => []);
  const packs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<ContextPack>(path.join(dirs.stateDir, entry.name)))
  );
  return packs
    .filter((pack): pack is ContextPack => Boolean(pack))
    .map(contextPackSummary)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function resolveContextPackArtifactPath(rootDir: string, target: string): Promise<string | null> {
  const { paths } = await loadVaultConfig(rootDir);
  const dirs = contextPackDirs(paths);
  const direct = path.resolve(rootDir, target);
  if (isPathWithin(dirs.stateDir, direct) && direct.endsWith(".json") && (await fileExists(direct))) {
    return direct;
  }

  const byId = path.resolve(dirs.stateDir, `${target.replace(/\.json$/, "")}.json`);
  if (isPathWithin(dirs.stateDir, byId) && (await fileExists(byId))) {
    return byId;
  }

  const summaries = await listContextPacks(rootDir);
  const match = summaries.find((summary) => summary.id === target || path.basename(summary.artifactPath, ".json") === target);
  return match?.artifactPath ?? null;
}

export async function readContextPack(rootDir: string, target: string): Promise<ContextPack | null> {
  const artifactPath = await resolveContextPackArtifactPath(rootDir, target);
  return artifactPath ? await readJsonFile<ContextPack>(artifactPath) : null;
}

export async function deleteContextPack(rootDir: string, target: string): Promise<ContextPackSummary | null> {
  const pack = await readContextPack(rootDir, target);
  if (!pack) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const dirs = contextPackDirs(paths);
  const artifactPath = path.resolve(pack.artifactPath);
  const markdownPath = path.resolve(pack.markdownPath);
  if (isPathWithin(dirs.stateDir, artifactPath)) {
    await fs.rm(artifactPath, { force: true });
  }
  if (isPathWithin(dirs.wikiDir, markdownPath)) {
    await fs.rm(markdownPath, { force: true });
  }
  return contextPackSummary(pack);
}
