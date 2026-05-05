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

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      default:
        return character;
    }
  });
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

type GraphTreeInspectorEdge = {
  id: string;
  relation: string;
  direction: "incoming" | "outgoing";
  otherId: string;
  otherLabel: string;
  evidenceClass: string;
  confidence: number;
};

type GraphTreeInspectorEntry = {
  id: string;
  label: string;
  kind: GraphTreeNodeKind;
  count: number;
  path?: string;
  sourceId?: string;
  nodeId?: string;
  language?: string;
  symbolKind?: CodeSymbolKind;
  hiddenChildren?: number;
  edges: GraphTreeInspectorEdge[];
};

function collectTreeInspectorEntries(tree: GraphTreeNode, graph: GraphArtifact): Record<string, GraphTreeInspectorEntry> {
  const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const entries: Record<string, GraphTreeInspectorEntry> = {};

  const visit = (node: GraphTreeNode) => {
    const edges = node.nodeId
      ? graph.edges
          .filter((edge) => edge.source === node.nodeId || edge.target === node.nodeId)
          .slice()
          .sort((left, right) => right.confidence - left.confidence || left.relation.localeCompare(right.relation))
          .slice(0, 8)
          .map((edge) => {
            const outgoing = edge.source === node.nodeId;
            const otherId = outgoing ? edge.target : edge.source;
            return {
              id: edge.id,
              relation: edge.relation,
              direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
              otherId,
              otherLabel: graphNodes.get(otherId)?.label ?? otherId,
              evidenceClass: edge.evidenceClass,
              confidence: edge.confidence
            };
          })
      : [];
    entries[node.id] = {
      id: node.id,
      label: node.label,
      kind: node.kind,
      count: node.count,
      path: node.path,
      sourceId: node.sourceId,
      nodeId: node.nodeId,
      language: node.language,
      symbolKind: node.symbolKind,
      hiddenChildren: node.hiddenChildren,
      edges
    };
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree);
  return entries;
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
    `<button class="node-button" type="button" data-tree-id="${escapeAttribute(node.id)}"><span class="label">${escapeHtml(node.label)}</span></button>`,
    node.count ? `<span class="count">${node.count}</span>` : "",
    meta.length ? `<span class="meta">${escapeHtml(meta.join(" · "))}</span>` : ""
  ].join("");
  if (node.children.length === 0) {
    return `<li class="tree-node kind-${escapeAttribute(node.kind)}" data-tree-id="${escapeAttribute(node.id)}">${content}</li>`;
  }
  return `<li class="tree-node kind-${escapeAttribute(node.kind)}" data-tree-id="${escapeAttribute(node.id)}"><details open><summary>${content}</summary><ul>${node.children
    .map(renderNode)
    .join("")}</ul></details></li>`;
}

export function renderGraphTreeHtml(tree: GraphTreeNode, graph: GraphArtifact): string {
  const inspectorEntries = collectTreeInspectorEntries(tree, graph);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(tree.label)}</title>
<style>
:root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body { margin: 0; background: #f7f7f5; color: #171717; }
main { max-width: 1280px; margin: 0 auto; padding: 32px 20px 56px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; }
.subtitle { color: #5d5d5d; margin: 0 0 20px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 0 0 18px; }
input { flex: 1 1 320px; min-width: 0; border: 1px solid #c9c9c9; border-radius: 6px; padding: 10px 12px; font: inherit; background: #fff; color: inherit; }
.toolbar button { border: 1px solid #c9c9c9; border-radius: 6px; background: #fff; color: inherit; font: inherit; padding: 10px 12px; cursor: pointer; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
.tree, .inspector { background: #fff; border: 1px solid #deded9; border-radius: 8px; padding: 16px 18px; }
.inspector { position: sticky; top: 16px; }
.inspector h2 { font-size: 17px; margin: 0 0 10px; }
.inspector dl { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px 10px; margin: 0 0 16px; font-size: 13px; }
.inspector dt { color: #666; }
.inspector dd { margin: 0; overflow-wrap: anywhere; }
.edge-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.edge-list li { border-top: 1px solid #ecece8; padding-top: 8px; }
ul { list-style: none; margin: 0; padding-left: 20px; }
.tree > ul { padding-left: 0; }
li { margin: 4px 0; }
summary { cursor: pointer; }
.node-button { border: 0; background: transparent; color: inherit; font: inherit; padding: 2px 0; cursor: pointer; text-align: left; }
.node-button:focus-visible, .toolbar button:focus-visible, input:focus-visible { outline: 2px solid #1f6feb; outline-offset: 2px; }
.label { font-weight: 600; }
.count { display: inline-flex; min-width: 18px; justify-content: center; margin-left: 8px; padding: 1px 6px; border-radius: 999px; background: #ededdf; color: #444; font-size: 12px; }
.meta { color: #666; font-size: 12px; margin-left: 8px; }
.kind-directory > details > summary .label { color: #245b78; }
.kind-source > details > summary .label, .kind-source > .label { color: #22543d; }
.kind-module > details > summary .label { color: #6b3f12; }
.kind-rationale > .label { color: #6d2f46; }
.selected > details > summary, .selected > .node-button { background: #eef6f1; border-radius: 4px; }
.hidden { display: none !important; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .inspector { position: static; } }
@media (prefers-color-scheme: dark) {
  body { background: #161616; color: #efefef; }
  .subtitle, .meta, .inspector dt { color: #ababab; }
  input, .tree, .inspector, .toolbar button { background: #202020; border-color: #3a3a3a; }
  .count { background: #333329; color: #deded8; }
  .edge-list li { border-color: #333; }
  .selected > details > summary, .selected > .node-button { background: #24362d; }
}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(tree.label)}</h1>
<p class="subtitle">${graph.sources.length} sources · ${graph.nodes.length} nodes · ${graph.edges.length} edges · generated ${escapeHtml(graph.generatedAt)}</p>
<div class="toolbar">
  <input id="filter" type="search" placeholder="Filter files, modules, symbols, or ids" aria-label="Filter graph tree">
  <button type="button" id="expandAll">Expand all</button>
  <button type="button" id="collapseAll">Collapse all</button>
  <button type="button" id="resetTree">Reset</button>
</div>
<div class="layout">
  <section class="tree" aria-label="Graph tree"><ul>${renderNode(tree)}</ul></section>
  <aside class="inspector" aria-live="polite">
    <h2 id="inspectorTitle">Select a node</h2>
    <dl id="inspectorMeta"></dl>
    <ul class="edge-list" id="inspectorEdges"></ul>
  </aside>
</div>
</main>
<script>
const treeData = ${escapeScriptJson(inspectorEntries)};
const input = document.getElementById('filter');
const inspectorTitle = document.getElementById('inspectorTitle');
const inspectorMeta = document.getElementById('inspectorMeta');
const inspectorEdges = document.getElementById('inspectorEdges');
const renderText = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);
function selectNode(id) {
  const entry = treeData[id];
  if (!entry) return;
  for (const selected of document.querySelectorAll('.selected')) selected.classList.remove('selected');
  const selectedNode = Array.from(document.querySelectorAll('[data-tree-id]')).find((node) => node.dataset.treeId === id);
  selectedNode?.classList.add('selected');
  inspectorTitle.textContent = entry.label;
  const rows = [
    ['Kind', entry.kind],
    ['Count', entry.count],
    ['Path', entry.path],
    ['Source', entry.sourceId],
    ['Node', entry.nodeId],
    ['Language', entry.language],
    ['Symbol', entry.symbolKind],
    ['Hidden', entry.hiddenChildren]
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  inspectorMeta.innerHTML = rows.map(([label, value]) => '<dt>' + renderText(label) + '</dt><dd>' + renderText(value) + '</dd>').join('');
  inspectorEdges.innerHTML = entry.edges.length
    ? entry.edges.map((edge) => '<li><strong>' + renderText(edge.relation) + '</strong> ' + renderText(edge.direction) + ' ' + renderText(edge.otherLabel) + '<br><span class="meta">' + renderText(edge.evidenceClass) + ' · ' + renderText(edge.confidence) + '</span></li>').join('')
    : '<li>No connected edges in the top slice.</li>';
}
document.querySelector('.tree')?.addEventListener('click', (event) => {
  const button = event.target.closest('.node-button');
  if (!button) return;
  selectNode(button.dataset.treeId);
});
input.addEventListener('input', () => {
  const query = input.value.trim().toLowerCase();
  for (const node of document.querySelectorAll('.tree-node')) {
    const text = node.textContent.toLowerCase();
    node.classList.toggle('hidden', query.length > 0 && !text.includes(query));
  }
});
document.getElementById('expandAll').addEventListener('click', () => {
  for (const details of document.querySelectorAll('details')) details.open = true;
});
document.getElementById('collapseAll').addEventListener('click', () => {
  for (const details of document.querySelectorAll('details')) details.open = false;
});
document.getElementById('resetTree').addEventListener('click', () => {
  input.value = '';
  input.dispatchEvent(new Event('input'));
  for (const details of document.querySelectorAll('details')) details.open = true;
  selectNode('${escapeAttribute(tree.id)}');
});
selectNode('${escapeAttribute(tree.id)}');
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
