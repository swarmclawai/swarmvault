import path from "node:path";
import { loadVaultConfig } from "./config.js";
import type { CodeSymbolKind, GraphArtifact, GraphNode } from "./types.js";
import { ensureDir, isPathWithin, readJsonFile, toPosix } from "./utils.js";

export type GraphTreeNodeKind = "root" | "directory" | "source" | "module" | "symbol" | "rationale" | "node" | "more";

export interface GraphTreeNode {
  id: string;
  label: string;
  kind: GraphTreeNodeKind;
  count: number;
  children: GraphTreeNode[];
  path?: string;
  sourceId?: string;
  nodeId?: string;
  language?: string;
  symbolKind?: CodeSymbolKind;
  hiddenChildren?: number;
}

export interface GraphTreeOptions {
  label?: string;
  maxChildren?: number;
}

export interface GraphTreeExportResult {
  outputPath: string;
  sourceCount: number;
  nodeCount: number;
  tree: GraphTreeNode;
}

const DEFAULT_MAX_CHILDREN = 250;

function compareTreeNodes(left: GraphTreeNode, right: GraphTreeNode): number {
  const kindOrder = new Map<GraphTreeNodeKind, number>([
    ["directory", 0],
    ["source", 1],
    ["module", 2],
    ["symbol", 3],
    ["rationale", 4],
    ["node", 5],
    ["more", 6],
    ["root", 7]
  ]);
  const leftKind = kindOrder.get(left.kind) ?? 99;
  const rightKind = kindOrder.get(right.kind) ?? 99;
  return leftKind - rightKind || left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function normalizeSourcePath(rootDir: string | undefined, source: GraphArtifact["sources"][number]): string {
  const candidate = source.repoRelativePath ?? source.originalPath ?? source.storedPath ?? source.title;
  if (source.repoRelativePath) {
    return toPosix(source.repoRelativePath);
  }
  if (rootDir && path.isAbsolute(candidate) && isPathWithin(rootDir, candidate)) {
    return toPosix(path.relative(rootDir, candidate));
  }
  if (path.isAbsolute(candidate)) {
    return toPosix(path.basename(candidate));
  }
  return toPosix(candidate).replace(/^\/+/, "") || source.title || source.sourceId;
}

function makeDirectoryNode(parentId: string, segment: string): GraphTreeNode {
  return {
    id: `${parentId}/${segment}`,
    label: segment,
    kind: "directory",
    count: 0,
    children: []
  };
}

function ensureDirectory(parent: GraphTreeNode, segment: string): GraphTreeNode {
  const existing = parent.children.find((child) => child.kind === "directory" && child.label === segment);
  if (existing) {
    existing.count += 1;
    return existing;
  }
  const created = makeDirectoryNode(parent.id, segment);
  created.count = 1;
  parent.children.push(created);
  return created;
}

function nodeChildrenForSource(sourceId: string, nodes: GraphNode[]): GraphTreeNode[] {
  const sourceNodes = nodes.filter((node) => node.sourceIds.includes(sourceId));
  const modules = sourceNodes.filter((node) => node.type === "module").sort((left, right) => left.label.localeCompare(right.label));
  const moduleIds = new Set(modules.map((node) => node.id));
  const symbols = sourceNodes.filter((node) => node.type === "symbol");
  const rationales = sourceNodes.filter((node) => node.type === "rationale");
  const children: GraphTreeNode[] = [];

  for (const moduleNode of modules) {
    const moduleChildren = symbols
      .filter((symbol) => symbol.moduleId === moduleNode.id)
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((symbol) => graphNodeToTreeNode(symbol, "symbol"));
    children.push({
      id: `tree:${moduleNode.id}`,
      label: moduleNode.label,
      kind: "module",
      count: moduleChildren.length,
      children: moduleChildren,
      nodeId: moduleNode.id,
      sourceId,
      language: moduleNode.language
    });
  }

  for (const symbol of symbols.filter((node) => !node.moduleId || !moduleIds.has(node.moduleId))) {
    children.push(graphNodeToTreeNode(symbol, "symbol"));
  }
  for (const rationale of rationales) {
    children.push(graphNodeToTreeNode(rationale, "rationale"));
  }
  return children.sort(compareTreeNodes);
}

function graphNodeToTreeNode(node: GraphNode, kind: GraphTreeNodeKind): GraphTreeNode {
  return {
    id: `tree:${node.id}`,
    label: node.label,
    kind,
    count: 0,
    children: [],
    nodeId: node.id,
    language: node.language,
    symbolKind: node.symbolKind
  };
}

function sortAndCapTree(node: GraphTreeNode, maxChildren: number): GraphTreeNode {
  const sortedChildren = node.children.map((child) => sortAndCapTree(child, maxChildren)).sort(compareTreeNodes);
  if (sortedChildren.length <= maxChildren) {
    return { ...node, children: sortedChildren };
  }
  const visible = sortedChildren.slice(0, maxChildren);
  const hidden = sortedChildren.length - visible.length;
  return {
    ...node,
    hiddenChildren: hidden,
    children: [
      ...visible,
      {
        id: `${node.id}:more`,
        label: `+${hidden} more`,
        kind: "more",
        count: hidden,
        children: []
      }
    ]
  };
}

export function buildGraphTree(graph: GraphArtifact, options: GraphTreeOptions & { rootDir?: string } = {}): GraphTreeNode {
  const root: GraphTreeNode = {
    id: "tree:root",
    label: options.label ?? "SwarmVault Graph Tree",
    kind: "root",
    count: graph.sources.length,
    children: []
  };
  const nodes = [...graph.nodes];

  for (const source of [...graph.sources].sort((left, right) =>
    normalizeSourcePath(options.rootDir, left).localeCompare(normalizeSourcePath(options.rootDir, right))
  )) {
    const normalizedPath = normalizeSourcePath(options.rootDir, source);
    const segments = normalizedPath.split("/").filter(Boolean);
    const fileLabel = segments.pop() ?? source.title ?? source.sourceId;
    let parent = root;
    for (const segment of segments) {
      parent = ensureDirectory(parent, segment);
    }
    const children = nodeChildrenForSource(source.sourceId, nodes);
    parent.children.push({
      id: `tree:source:${source.sourceId}`,
      label: fileLabel,
      kind: "source",
      count: children.length,
      children,
      path: normalizedPath,
      sourceId: source.sourceId,
      language: source.language
    });
  }

  return sortAndCapTree(root, Math.max(1, options.maxChildren ?? DEFAULT_MAX_CHILDREN));
}

function renderNode(node: GraphTreeNode): string {
  const meta = [
    node.kind,
    node.language,
    node.symbolKind,
    node.path,
    node.nodeId,
    node.sourceId,
    node.count ? `${node.count} item${node.count === 1 ? "" : "s"}` : undefined
  ].filter(Boolean);
  const content = [
    `<span class="label">${escapeHtml(node.label)}</span>`,
    meta.length ? `<span class="meta">${escapeHtml(meta.join(" · "))}</span>` : ""
  ].join("");
  if (node.children.length === 0) {
    return `<li class="tree-node kind-${escapeHtml(node.kind)}">${content}</li>`;
  }
  return `<li class="tree-node kind-${escapeHtml(node.kind)}"><details open><summary>${content}</summary><ul>${node.children
    .map(renderNode)
    .join("")}</ul></details></li>`;
}

export function renderGraphTreeHtml(tree: GraphTreeNode, graph: GraphArtifact): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(tree.label)}</title>
<style>
:root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #f7f7f5; color: #171717; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; }
.subtitle { color: #5d5d5d; margin: 0 0 20px; }
.toolbar { display: flex; gap: 12px; align-items: center; margin: 0 0 18px; }
input { flex: 1; min-width: 0; border: 1px solid #c9c9c9; border-radius: 6px; padding: 10px 12px; font: inherit; background: #fff; color: inherit; }
.tree { background: #fff; border: 1px solid #deded9; border-radius: 8px; padding: 16px 18px; }
ul { list-style: none; margin: 0; padding-left: 20px; }
.tree > ul { padding-left: 0; }
li { margin: 4px 0; }
summary { cursor: pointer; }
.label { font-weight: 600; }
.meta { color: #666; font-size: 12px; margin-left: 8px; }
.kind-directory > details > summary .label { color: #245b78; }
.kind-source > details > summary .label, .kind-source > .label { color: #22543d; }
.kind-module > details > summary .label { color: #6b3f12; }
.kind-rationale > .label { color: #6d2f46; }
.hidden { display: none !important; }
@media (prefers-color-scheme: dark) {
  body { background: #161616; color: #efefef; }
  .subtitle, .meta { color: #ababab; }
  input, .tree { background: #202020; border-color: #3a3a3a; }
}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(tree.label)}</h1>
<p class="subtitle">${graph.sources.length} sources · ${graph.nodes.length} nodes · ${graph.edges.length} edges · generated ${escapeHtml(graph.generatedAt)}</p>
<div class="toolbar"><input id="filter" type="search" placeholder="Filter files, modules, symbols, or ids" aria-label="Filter graph tree"></div>
<section class="tree"><ul>${renderNode(tree)}</ul></section>
</main>
<script>
const input = document.getElementById('filter');
input.addEventListener('input', () => {
  const query = input.value.trim().toLowerCase();
  for (const node of document.querySelectorAll('.tree-node')) {
    const text = node.textContent.toLowerCase();
    node.classList.toggle('hidden', query.length > 0 && !text.includes(query));
  }
});
</script>
</body>
</html>
`;
}

export async function exportGraphTree(
  rootDir: string,
  outputPath?: string,
  options: GraphTreeOptions = {}
): Promise<GraphTreeExportResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error(`Graph artifact not found at ${paths.graphPath}. Run swarmvault compile first.`);
  }
  const tree = buildGraphTree(graph, { ...options, rootDir });
  const resolvedOutputPath = path.resolve(rootDir, outputPath ?? path.join(paths.wikiDir, "graph", "tree.html"));
  await ensureDir(path.dirname(resolvedOutputPath));
  await import("node:fs/promises").then((fs) => fs.writeFile(resolvedOutputPath, renderGraphTreeHtml(tree, graph), "utf8"));
  return {
    outputPath: resolvedOutputPath,
    sourceCount: graph.sources.length,
    nodeCount: graph.nodes.length,
    tree
  };
}
