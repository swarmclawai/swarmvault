import fs from "node:fs/promises";
import path from "node:path";
import { loadVaultConfig } from "./config.js";
import type { GraphArtifact, GraphExportFormat, GraphExportResult, GraphNode, GraphPage } from "./types.js";
import { ensureDir, fileExists, readJsonFile } from "./utils.js";

const NODE_COLORS: Record<string, string> = {
  source: "#f59e0b",
  module: "#fb7185",
  symbol: "#8b5cf6",
  rationale: "#14b8a6",
  concept: "#0ea5e9",
  entity: "#22c55e"
};

type PositionedNode = {
  node: GraphNode;
  x: number;
  y: number;
};

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function cypherEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function relationType(relation: string): string {
  const normalized = relation
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "RELATED_TO";
}

function graphPageById(graph: GraphArtifact): Map<string, GraphPage> {
  return new Map(graph.pages.map((page) => [page.id, page]));
}

function graphNodeById(graph: GraphArtifact): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function sortedCommunities(graph: GraphArtifact): Array<{ id: string; label: string; nodeIds: string[] }> {
  const known = (graph.communities ?? []).map((community) => ({
    ...community,
    nodeIds: [...community.nodeIds].sort((left, right) => left.localeCompare(right))
  }));
  const knownIds = new Set(known.flatMap((community) => community.nodeIds));
  const unassigned = graph.nodes
    .filter((node) => !knownIds.has(node.id))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
    .map((node) => node.id);
  if (unassigned.length) {
    known.push({
      id: "community:unassigned",
      label: "Unassigned",
      nodeIds: unassigned
    });
  }
  return known.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function layoutGraph(graph: GraphArtifact): { width: number; height: number; nodes: PositionedNode[] } {
  const communities = sortedCommunities(graph);
  const width = 1600;
  const height = Math.max(900, 420 * Math.max(1, Math.ceil(communities.length / 3)));
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, communities.length))));
  const nodesById = graphNodeById(graph);
  const positioned: PositionedNode[] = [];

  communities.forEach((community, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const centerX = 240 + col * 460;
    const centerY = 220 + row * 360;
    const members = community.nodeIds
      .map((nodeId) => nodesById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    const radius = Math.max(40, 36 * Math.sqrt(members.length));

    members.forEach((node, memberIndex) => {
      const angle = (Math.PI * 2 * memberIndex) / Math.max(1, members.length);
      positioned.push({
        node,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      });
    });
  });

  return { width, height, nodes: positioned };
}

function nodeShape(positioned: PositionedNode): string {
  const { node, x, y } = positioned;
  const fill = NODE_COLORS[node.type] ?? "#94a3b8";
  if (node.type === "module") {
    return `<rect x="${(x - 32).toFixed(1)}" y="${(y - 18).toFixed(1)}" width="64" height="36" rx="10" fill="${fill}" stroke="#0f172a" stroke-width="2" />`;
  }
  if (node.type === "symbol") {
    const points = [
      `${x.toFixed(1)},${(y - 18).toFixed(1)}`,
      `${(x + 18).toFixed(1)},${y.toFixed(1)}`,
      `${x.toFixed(1)},${(y + 18).toFixed(1)}`,
      `${(x - 18).toFixed(1)},${y.toFixed(1)}`
    ].join(" ");
    return `<polygon points="${points}" fill="${fill}" stroke="#0f172a" stroke-width="2" />`;
  }
  if (node.type === "rationale") {
    const points = [
      `${(x - 18).toFixed(1)},${(y - 10).toFixed(1)}`,
      `${x.toFixed(1)},${(y - 20).toFixed(1)}`,
      `${(x + 18).toFixed(1)},${(y - 10).toFixed(1)}`,
      `${(x + 18).toFixed(1)},${(y + 10).toFixed(1)}`,
      `${x.toFixed(1)},${(y + 20).toFixed(1)}`,
      `${(x - 18).toFixed(1)},${(y + 10).toFixed(1)}`
    ].join(" ");
    return `<polygon points="${points}" fill="${fill}" stroke="#0f172a" stroke-width="2" />`;
  }
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${node.isGodNode ? 24 : 18}" fill="${fill}" stroke="#0f172a" stroke-width="${node.isGodNode ? 3 : 2}" />`;
}

function nodeTitle(node: GraphNode, page?: GraphPage): string {
  return [
    node.label,
    `id=${node.id}`,
    `type=${node.type}`,
    node.communityId ? `community=${node.communityId}` : "",
    page ? `page=${page.path}` : "",
    node.degree !== undefined ? `degree=${node.degree}` : "",
    node.bridgeScore !== undefined ? `bridge=${node.bridgeScore}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function renderSvg(graph: GraphArtifact): string {
  const layout = layoutGraph(graph);
  const pageById = graphPageById(graph);
  const positionedById = new Map(layout.nodes.map((item) => [item.node.id, item]));
  const communityLabels = sortedCommunities(graph).map((community, index) => {
    const col = index % Math.max(1, Math.ceil(Math.sqrt(Math.max(1, sortedCommunities(graph).length))));
    const row = Math.floor(index / Math.max(1, Math.ceil(Math.sqrt(Math.max(1, sortedCommunities(graph).length)))));
    return {
      label: community.label,
      x: 240 + col * 460,
      y: 90 + row * 360
    };
  });

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="title desc">`,
    '  <title id="title">SwarmVault Graph Export</title>',
    `  <desc id="desc">Nodes=${graph.nodes.length}, edges=${graph.edges.length}, communities=${graph.communities?.length ?? 0}</desc>`,
    "  <defs>",
    '    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">',
    '      <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />',
    "    </marker>",
    "  </defs>",
    '  <rect width="100%" height="100%" fill="#020617" />'
  ];

  for (const community of communityLabels) {
    lines.push(
      `  <text x="${community.x.toFixed(1)}" y="${community.y.toFixed(1)}" fill="#cbd5e1" font-family="Avenir Next, Segoe UI, sans-serif" font-size="16" text-anchor="middle">${xmlEscape(community.label)}</text>`
    );
  }

  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const source = positionedById.get(edge.source);
    const target = positionedById.get(edge.target);
    if (!source || !target) {
      continue;
    }
    lines.push(
      `  <g data-edge-id="${xmlEscape(edge.id)}" data-relation="${xmlEscape(edge.relation)}" data-evidence-class="${xmlEscape(edge.evidenceClass)}">`,
      `    <title>${xmlEscape(
        `${source.node.label} --${edge.relation}/${edge.evidenceClass}/${edge.confidence.toFixed(2)}--> ${target.node.label}`
      )}</title>`,
      `    <line x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" stroke="#64748b" stroke-opacity="0.55" stroke-width="${Math.max(
        1.5,
        Math.min(4, edge.confidence * 3)
      ).toFixed(1)}" marker-end="url(#arrow)" />`,
      "  </g>"
    );
  }

  for (const positioned of layout.nodes) {
    const page = positioned.node.pageId ? pageById.get(positioned.node.pageId) : undefined;
    lines.push(
      `  <g data-node-id="${xmlEscape(positioned.node.id)}" data-node-type="${xmlEscape(positioned.node.type)}" data-community-id="${xmlEscape(positioned.node.communityId ?? "")}">`,
      `    <title>${xmlEscape(nodeTitle(positioned.node, page))}</title>`,
      `    ${nodeShape(positioned)}`,
      `    <text x="${positioned.x.toFixed(1)}" y="${(positioned.y + 34).toFixed(1)}" fill="#e2e8f0" font-family="Avenir Next, Segoe UI, sans-serif" font-size="11" text-anchor="middle">${xmlEscape(positioned.node.label)}</text>`,
      "  </g>"
    );
  }

  lines.push("</svg>", "");
  return lines.join("\n");
}

function graphMlData(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function renderGraphMl(graph: GraphArtifact): string {
  const pageById = graphPageById(graph);
  const keys = [
    { id: "n_label", for: "node", name: "label", type: "string" },
    { id: "n_type", for: "node", name: "type", type: "string" },
    { id: "n_page", for: "node", name: "pageId", type: "string" },
    { id: "n_page_path", for: "node", name: "pagePath", type: "string" },
    { id: "n_language", for: "node", name: "language", type: "string" },
    { id: "n_symbol_kind", for: "node", name: "symbolKind", type: "string" },
    { id: "n_project_ids", for: "node", name: "projectIds", type: "string" },
    { id: "n_source_ids", for: "node", name: "sourceIds", type: "string" },
    { id: "n_community", for: "node", name: "communityId", type: "string" },
    { id: "n_degree", for: "node", name: "degree", type: "double" },
    { id: "n_bridge", for: "node", name: "bridgeScore", type: "double" },
    { id: "e_relation", for: "edge", name: "relation", type: "string" },
    { id: "e_status", for: "edge", name: "status", type: "string" },
    { id: "e_evidence", for: "edge", name: "evidenceClass", type: "string" },
    { id: "e_confidence", for: "edge", name: "confidence", type: "double" },
    { id: "e_provenance", for: "edge", name: "provenance", type: "string" }
  ];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">'
  ];
  for (const key of keys) {
    lines.push(`  <key id="${key.id}" for="${key.for}" attr.name="${key.name}" attr.type="${key.type}" />`);
  }
  lines.push('  <graph id="swarmvault" edgedefault="directed">');
  for (const node of [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const page = node.pageId ? pageById.get(node.pageId) : undefined;
    lines.push(`    <node id="${xmlEscape(node.id)}">`);
    const dataEntries: Array<[string, unknown]> = [
      ["n_label", node.label],
      ["n_type", node.type],
      ["n_page", node.pageId],
      ["n_page_path", page?.path],
      ["n_language", node.language],
      ["n_symbol_kind", node.symbolKind],
      ["n_project_ids", node.projectIds],
      ["n_source_ids", node.sourceIds],
      ["n_community", node.communityId],
      ["n_degree", node.degree],
      ["n_bridge", node.bridgeScore]
    ];
    for (const [key, value] of dataEntries) {
      if (value === undefined) {
        continue;
      }
      lines.push(`      <data key="${key}">${xmlEscape(graphMlData(value))}</data>`);
    }
    lines.push("    </node>");
  }
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`    <edge id="${xmlEscape(edge.id)}" source="${xmlEscape(edge.source)}" target="${xmlEscape(edge.target)}">`);
    for (const [key, value] of [
      ["e_relation", edge.relation],
      ["e_status", edge.status],
      ["e_evidence", edge.evidenceClass],
      ["e_confidence", edge.confidence],
      ["e_provenance", edge.provenance]
    ] as Array<[string, unknown]>) {
      lines.push(`      <data key="${key}">${xmlEscape(graphMlData(value))}</data>`);
    }
    lines.push("    </edge>");
  }
  lines.push("  </graph>", "</graphml>", "");
  return lines.join("\n");
}

function renderCypher(graph: GraphArtifact): string {
  const pageById = graphPageById(graph);
  const lines = ["// Neo4j Cypher import generated by SwarmVault", ""];
  for (const node of [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const page = node.pageId ? pageById.get(node.pageId) : undefined;
    const props = [
      `id: '${cypherEscape(node.id)}'`,
      `label: '${cypherEscape(node.label)}'`,
      `type: '${cypherEscape(node.type)}'`,
      `sourceIds: '${cypherEscape(JSON.stringify(node.sourceIds))}'`,
      `projectIds: '${cypherEscape(JSON.stringify(node.projectIds))}'`,
      node.pageId ? `pageId: '${cypherEscape(node.pageId)}'` : "",
      page?.path ? `pagePath: '${cypherEscape(page.path)}'` : "",
      node.language ? `language: '${cypherEscape(node.language)}'` : "",
      node.symbolKind ? `symbolKind: '${cypherEscape(node.symbolKind)}'` : "",
      node.communityId ? `communityId: '${cypherEscape(node.communityId)}'` : "",
      node.degree !== undefined ? `degree: ${node.degree}` : "",
      node.bridgeScore !== undefined ? `bridgeScore: ${node.bridgeScore}` : "",
      node.isGodNode !== undefined ? `isGodNode: ${node.isGodNode}` : ""
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`MERGE (n:SwarmNode {id: '${cypherEscape(node.id)}'}) SET n += { ${props} };`);
  }
  lines.push("");
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(
      `MATCH (a:SwarmNode {id: '${cypherEscape(edge.source)}'}), (b:SwarmNode {id: '${cypherEscape(edge.target)}'})`,
      `MERGE (a)-[r:${relationType(edge.relation)} {id: '${cypherEscape(edge.id)}'}]->(b)`,
      `SET r += { relation: '${cypherEscape(edge.relation)}', status: '${cypherEscape(edge.status)}', evidenceClass: '${cypherEscape(
        edge.evidenceClass
      )}', confidence: ${edge.confidence}, provenance: '${cypherEscape(JSON.stringify(edge.provenance))}' };`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function loadGraph(rootDir: string): Promise<GraphArtifact> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` first.");
  }
  return graph;
}

async function writeGraphExport(outputPath: string, content: string): Promise<string> {
  await ensureDir(path.dirname(outputPath));
  await fs.writeFile(outputPath, content, "utf8");
  return path.resolve(outputPath);
}

export async function exportGraphFormat(
  rootDir: string,
  format: Exclude<GraphExportFormat, "html">,
  outputPath: string
): Promise<GraphExportResult> {
  const graph = await loadGraph(rootDir);
  const rendered = format === "svg" ? renderSvg(graph) : format === "graphml" ? renderGraphMl(graph) : renderCypher(graph);
  const resolvedPath = await writeGraphExport(outputPath, rendered);
  return { format, outputPath: resolvedPath };
}

export async function hasGraphArtifact(rootDir: string): Promise<boolean> {
  const { paths } = await loadVaultConfig(rootDir);
  return fileExists(paths.graphPath);
}
