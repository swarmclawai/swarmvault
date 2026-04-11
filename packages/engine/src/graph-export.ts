import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "./config.js";
import {
  cypherStringLiteral,
  exportHyperedgeNodeId,
  graphNodeById,
  graphPageById,
  normalizeEdgeProps,
  normalizeGroupMemberProps,
  normalizeHyperedgeNodeProps,
  normalizeSwarmNodeProps,
  relationType
} from "./graph-interchange.js";
import { renderGraphReportHtml } from "./graph-report-html.js";
import type { GraphArtifact, GraphExportFormat, GraphExportResult, GraphNode, GraphPage, GraphReportArtifact } from "./types.js";
import { ensureDir, fileExists, readJsonFile, slugify } from "./utils.js";

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
    { id: "n_relation", for: "node", name: "relation", type: "string" },
    { id: "n_evidence", for: "node", name: "evidenceClass", type: "string" },
    { id: "n_confidence", for: "node", name: "confidence", type: "double" },
    { id: "n_source_pages", for: "node", name: "sourcePageIds", type: "string" },
    { id: "n_why", for: "node", name: "why", type: "string" },
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
  for (const hyperedge of [...(graph.hyperedges ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`    <node id="${xmlEscape(exportHyperedgeNodeId(hyperedge))}">`);
    for (const [key, value] of [
      ["n_label", hyperedge.label],
      ["n_type", "hyperedge"],
      ["n_relation", hyperedge.relation],
      ["n_evidence", hyperedge.evidenceClass],
      ["n_confidence", hyperedge.confidence],
      ["n_source_pages", hyperedge.sourcePageIds],
      ["n_why", hyperedge.why]
    ] as Array<[string, unknown]>) {
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
  for (const hyperedge of [...(graph.hyperedges ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const nodeId of hyperedge.nodeIds) {
      lines.push(
        `    <edge id="${xmlEscape(`member:${hyperedge.id}:${nodeId}`)}" source="${xmlEscape(exportHyperedgeNodeId(hyperedge))}" target="${xmlEscape(nodeId)}">`
      );
      for (const [key, value] of [
        ["e_relation", "group_member"],
        ["e_status", "inferred"],
        ["e_evidence", hyperedge.evidenceClass],
        ["e_confidence", hyperedge.confidence],
        ["e_provenance", hyperedge.sourcePageIds]
      ] as Array<[string, unknown]>) {
        lines.push(`      <data key="${key}">${xmlEscape(graphMlData(value))}</data>`);
      }
      lines.push("    </edge>");
    }
  }
  lines.push("  </graph>", "</graphml>", "");
  return lines.join("\n");
}

function renderCypher(graph: GraphArtifact): string {
  const pageById = graphPageById(graph);
  const lines = ["// Neo4j Cypher import generated by SwarmVault", ""];
  for (const node of [...graph.nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const page = node.pageId ? pageById.get(node.pageId) : undefined;
    const props = Object.entries(normalizeSwarmNodeProps(node, page))
      .map(([key, value]) => `${key}: ${typeof value === "string" ? cypherStringLiteral(value) : value}`)
      .filter(Boolean)
      .join(", ");
    lines.push(`MERGE (n:SwarmNode {id: ${cypherStringLiteral(node.id)}}) SET n += { ${props} };`);
  }
  lines.push("");
  for (const hyperedge of [...(graph.hyperedges ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    const hyperedgeNodeId = exportHyperedgeNodeId(hyperedge);
    const props = Object.entries(normalizeHyperedgeNodeProps(hyperedge))
      .map(([key, value]) => `${key}: ${typeof value === "string" ? cypherStringLiteral(value) : value}`)
      .join(", ");
    lines.push(`MERGE (h:SwarmNode {id: ${cypherStringLiteral(hyperedgeNodeId)}}) SET h += { ${props} };`);
  }
  if ((graph.hyperedges ?? []).length) {
    lines.push("");
  }
  for (const hyperedge of [...(graph.hyperedges ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
    const hyperedgeNodeId = exportHyperedgeNodeId(hyperedge);
    for (const nodeId of hyperedge.nodeIds) {
      const props = Object.entries(normalizeGroupMemberProps(hyperedge, nodeId))
        .map(([key, value]) => `${key}: ${typeof value === "string" ? cypherStringLiteral(value) : value}`)
        .join(", ");
      lines.push(
        `MATCH (h:SwarmNode {id: ${cypherStringLiteral(hyperedgeNodeId)}}), (n:SwarmNode {id: ${cypherStringLiteral(nodeId)}})`,
        `MERGE (h)-[r:GROUP_MEMBER {id: ${cypherStringLiteral(`member:${hyperedge.id}:${nodeId}`)}}]->(n)`,
        `SET r += { ${props} };`
      );
    }
  }
  lines.push("");
  for (const edge of [...graph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
    const props = Object.entries(normalizeEdgeProps(edge))
      .map(([key, value]) => `${key}: ${typeof value === "string" ? cypherStringLiteral(value) : value}`)
      .join(", ");
    lines.push(
      `MATCH (a:SwarmNode {id: ${cypherStringLiteral(edge.source)}}), (b:SwarmNode {id: ${cypherStringLiteral(edge.target)}})`,
      `MERGE (a)-[r:${relationType(edge.relation)} {id: ${cypherStringLiteral(edge.id)}}]->(b)`,
      `SET r += { ${props} };`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderJson(graph: GraphArtifact): string {
  const communities = sortedCommunities(graph);
  const payload = {
    nodes: [...graph.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => ({
        id: node.id,
        label: node.label,
        type: node.type,
        communityId: node.communityId ?? null,
        degree: node.degree ?? null,
        bridgeScore: node.bridgeScore ?? null,
        confidence: node.confidence ?? null,
        sourceClass: node.sourceClass ?? null,
        tags: node.tags ?? []
      })),
    edges: [...graph.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        evidenceClass: edge.evidenceClass,
        confidence: edge.confidence,
        similarityReasons: edge.similarityReasons ?? []
      })),
    communities: communities.map((community) => ({
      id: community.id,
      label: community.label,
      nodeIds: community.nodeIds
    })),
    hyperedges: graph.hyperedges ?? [],
    metadata: {
      generatedAt: new Date().toISOString(),
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      communityCount: (graph.communities ?? []).length
    }
  };
  return JSON.stringify(payload, null, 2);
}

function renderHtmlStandalone(graph: GraphArtifact): string {
  const communities = sortedCommunities(graph);

  // Cap at 5000 nodes by degree descending
  const cappedNodes = [...graph.nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0)).slice(0, 5000);
  const cappedNodeIds = new Set(cappedNodes.map((n) => n.id));
  const cappedEdges = graph.edges.filter((e) => cappedNodeIds.has(e.source) && cappedNodeIds.has(e.target));

  const communityColors = [
    "#f59e0b",
    "#fb7185",
    "#8b5cf6",
    "#14b8a6",
    "#0ea5e9",
    "#22c55e",
    "#f97316",
    "#a78bfa",
    "#2dd4bf",
    "#38bdf8",
    "#facc15",
    "#e879f9",
    "#34d399",
    "#60a5fa",
    "#fb923c"
  ];

  const nodesData = cappedNodes.map((node) => ({
    id: node.id,
    label: node.label,
    type: node.type,
    communityId: node.communityId ?? null,
    degree: node.degree ?? 0,
    bridgeScore: node.bridgeScore ?? null,
    confidence: node.confidence ?? null,
    sourceClass: node.sourceClass ?? null,
    tags: node.tags ?? []
  }));

  const edgesData = cappedEdges.map((edge) => ({
    id: edge.id,
    from: edge.source,
    to: edge.target,
    relation: edge.relation,
    evidenceClass: edge.evidenceClass,
    confidence: edge.confidence
  }));

  const communitiesData = communities.map((c) => ({
    id: c.id,
    label: c.label,
    nodeIds: c.nodeIds
  }));

  const graphJson = JSON.stringify({
    nodes: nodesData,
    edges: edgesData,
    communities: communitiesData
  });

  // The inline JS uses DOM-based escaping (createElement + textContent + reading back
  // the safely-encoded HTML) so all user-provided labels/values are safe against XSS.
  // eslint-disable-next-line no-useless-escape
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SwarmVault Graph</title>
  <script src="https://unpkg.com/vis-network@9/standalone/umd/vis-network.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; display: flex; height: 100vh; background: #0f172a; color: #e2e8f0; }
    #graph { flex: 1; }
    #sidebar { width: 320px; background: #1e293b; padding: 16px; overflow-y: auto; border-left: 1px solid #334155; display: none; }
    #sidebar.open { display: block; }
    #sidebar h2 { font-size: 16px; margin-bottom: 8px; color: #f8fafc; }
    #sidebar .field { margin-bottom: 6px; font-size: 13px; }
    #sidebar .label { color: #94a3b8; }
    #sidebar .value { color: #e2e8f0; }
    #sidebar .neighbors { margin-top: 12px; }
    #sidebar .neighbor { cursor: pointer; color: #38bdf8; text-decoration: underline; margin: 2px 0; font-size: 13px; }
    #search { position: absolute; top: 12px; left: 12px; z-index: 10; }
    #search input { padding: 8px 12px; border-radius: 6px; border: 1px solid #475569; background: #1e293b; color: #e2e8f0; width: 240px; font-size: 14px; }
    #legend { position: absolute; bottom: 12px; left: 12px; z-index: 10; background: #1e293b; padding: 10px 14px; border-radius: 8px; border: 1px solid #334155; }
    #legend .item { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 3px 0; }
    #legend .dot { width: 10px; height: 10px; border-radius: 50%; }
    #stats { position: absolute; top: 12px; right: 340px; z-index: 10; background: #1e293b; padding: 8px 12px; border-radius: 6px; font-size: 12px; color: #94a3b8; border: 1px solid #334155; }
  </style>
</head>
<body>
  <div id="search"><input type="text" placeholder="Search nodes..." id="searchInput"></div>
  <div id="stats"></div>
  <div id="graph"></div>
  <div id="sidebar">
    <h2 id="sidebarTitle"></h2>
    <div id="sidebarFields"></div>
    <div class="neighbors" id="sidebarNeighbors"></div>
  </div>
  <div id="legend"></div>
  <script>
    var GRAPH_DATA = ${graphJson};

    var TYPE_COLORS = {
      source: "#f59e0b",
      module: "#fb7185",
      symbol: "#8b5cf6",
      rationale: "#14b8a6",
      concept: "#0ea5e9",
      entity: "#22c55e"
    };

    var COMMUNITY_COLORS = {};
    var palette = ${JSON.stringify(communityColors)};
    GRAPH_DATA.communities.forEach(function(c, i) {
      COMMUNITY_COLORS[c.id] = palette[i % palette.length];
    });

    var adjacency = {};
    GRAPH_DATA.nodes.forEach(function(n) { adjacency[n.id] = []; });
    GRAPH_DATA.edges.forEach(function(e) {
      if (adjacency[e.from]) adjacency[e.from].push({ id: e.to, relation: e.relation });
      if (adjacency[e.to]) adjacency[e.to].push({ id: e.from, relation: e.relation });
    });

    var nodeMap = {};
    GRAPH_DATA.nodes.forEach(function(n) { nodeMap[n.id] = n; });

    var visNodes = new vis.DataSet(GRAPH_DATA.nodes.map(function(n) {
      var size = 8 + Math.min(32, n.degree * 2);
      return {
        id: n.id,
        label: n.label,
        color: { background: TYPE_COLORS[n.type] || "#94a3b8", border: "#0f172a" },
        size: size,
        font: { color: "#e2e8f0", size: 11 },
        borderWidth: 2
      };
    }));

    var visEdges = new vis.DataSet(GRAPH_DATA.edges.map(function(e) {
      var dashed = (e.evidenceClass === "inferred" || e.evidenceClass === "ambiguous");
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        color: { color: "#64748b", opacity: 0.55 },
        width: Math.max(1.5, Math.min(4, e.confidence * 3)),
        dashes: dashed,
        arrows: { to: { enabled: true, scaleFactor: 0.5 } }
      };
    }));

    var container = document.getElementById("graph");
    var network = new vis.Network(container, { nodes: visNodes, edges: visEdges }, {
      physics: {
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: -30,
          centralGravity: 0.005,
          springLength: 100,
          springConstant: 0.04
        },
        stabilization: { iterations: 150 }
      },
      interaction: { hover: true, tooltipDelay: 200 },
      nodes: { shape: "dot" },
      edges: { smooth: { type: "continuous" } }
    });

    document.getElementById("stats").textContent =
      "Nodes: " + GRAPH_DATA.nodes.length +
      " | Edges: " + GRAPH_DATA.edges.length +
      " | Communities: " + GRAPH_DATA.communities.length;

    (function buildLegend() {
      var el = document.getElementById("legend");
      GRAPH_DATA.communities.forEach(function(c) {
        var color = COMMUNITY_COLORS[c.id] || "#94a3b8";
        var item = document.createElement("div");
        item.className = "item";
        var dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = color;
        item.appendChild(dot);
        item.appendChild(document.createTextNode(c.label + " (" + c.nodeIds.length + ")"));
        el.appendChild(item);
      });
    })();

    var sidebar = document.getElementById("sidebar");
    var sidebarTitle = document.getElementById("sidebarTitle");
    var sidebarFields = document.getElementById("sidebarFields");
    var sidebarNeighbors = document.getElementById("sidebarNeighbors");

    function renderField(parent, label, value) {
      var wrap = document.createElement("div");
      wrap.className = "field";
      var lbl = document.createElement("span");
      lbl.className = "label";
      lbl.textContent = label + ":";
      var val = document.createElement("span");
      val.className = "value";
      val.textContent = " " + value;
      wrap.appendChild(lbl);
      wrap.appendChild(val);
      parent.appendChild(wrap);
    }

    network.on("click", function(params) {
      if (params.nodes.length === 0) {
        sidebar.classList.remove("open");
        return;
      }
      var nodeId = params.nodes[0];
      var node = nodeMap[nodeId];
      if (!node) return;

      sidebarTitle.textContent = node.label;
      sidebarFields.textContent = "";
      renderField(sidebarFields, "Type", node.type);
      renderField(sidebarFields, "Community", node.communityId || "none");
      renderField(sidebarFields, "Confidence", node.confidence != null ? node.confidence.toFixed(2) : "n/a");
      renderField(sidebarFields, "Degree", String(node.degree));
      renderField(sidebarFields, "Bridge Score", node.bridgeScore != null ? node.bridgeScore.toFixed(3) : "n/a");
      renderField(sidebarFields, "Tags", (node.tags && node.tags.length) ? node.tags.join(", ") : "none");

      sidebarNeighbors.textContent = "";
      var neighbors = adjacency[nodeId] || [];
      if (neighbors.length > 0) {
        renderField(sidebarNeighbors, "Neighbors", String(neighbors.length));
        neighbors.forEach(function(nb) {
          var nbNode = nodeMap[nb.id];
          var nbLabel = nbNode ? nbNode.label : nb.id;
          var link = document.createElement("div");
          link.className = "neighbor";
          link.dataset.nodeId = nb.id;
          link.textContent = nbLabel + " (" + nb.relation + ")";
          sidebarNeighbors.appendChild(link);
        });
      } else {
        renderField(sidebarNeighbors, "Neighbors", "none");
      }

      sidebar.classList.add("open");
    });

    sidebarNeighbors.addEventListener("click", function(e) {
      var target = e.target;
      while (target && target !== sidebarNeighbors) {
        if (target.dataset && target.dataset.nodeId) {
          var nid = target.dataset.nodeId;
          network.selectNodes([nid]);
          network.focus(nid, { scale: 1.2, animation: { duration: 400 } });
          network.body.emitter.emit("click", { nodes: [nid] });
          return;
        }
        target = target.parentElement;
      }
    });

    document.getElementById("searchInput").addEventListener("input", function() {
      var query = this.value.toLowerCase().trim();
      if (!query) {
        visNodes.forEach(function(n) {
          visNodes.update({ id: n.id, opacity: 1.0, font: { color: "#e2e8f0", size: 11 } });
        });
        return;
      }
      visNodes.forEach(function(n) {
        var match = n.label.toLowerCase().indexOf(query) !== -1;
        visNodes.update({
          id: n.id,
          opacity: match ? 1.0 : 0.15,
          font: { color: match ? "#f8fafc" : "#475569", size: match ? 13 : 9 }
        });
      });
    });
  </script>
</body>
</html>`;
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
  format: Exclude<GraphExportFormat, "html" | "report" | "obsidian" | "canvas">,
  outputPath: string
): Promise<GraphExportResult> {
  const graph = await loadGraph(rootDir);
  const rendered =
    format === "html-standalone"
      ? renderHtmlStandalone(graph)
      : format === "json"
        ? renderJson(graph)
        : format === "svg"
          ? renderSvg(graph)
          : format === "graphml"
            ? renderGraphMl(graph)
            : renderCypher(graph);
  const resolvedPath = await writeGraphExport(outputPath, rendered);
  return { format, outputPath: resolvedPath };
}

export async function exportGraphReportHtml(rootDir: string, outputPath: string): Promise<GraphExportResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await loadGraph(rootDir);
  const report = await readJsonFile<GraphReportArtifact>(path.join(paths.wikiDir, "graph", "report.json"));
  const html = renderGraphReportHtml(graph, report);
  const resolvedPath = await writeGraphExport(outputPath, html);
  return { format: "report", outputPath: resolvedPath };
}

function safeFileName(label: string): string {
  return (
    label
      .replace(/[\\/*?:"<>|#^[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200) || "unnamed"
  );
}

function deduplicateFileName(baseName: string, used: Set<string>): string {
  let name = baseName;
  let counter = 2;
  while (used.has(name)) {
    name = `${baseName}_${counter}`;
    counter++;
  }
  used.add(name);
  return name;
}

function typePluralDir(nodeType: string): string {
  const map: Record<string, string> = {
    source: "sources",
    module: "modules",
    symbol: "symbols",
    concept: "concepts",
    entity: "entities",
    rationale: "rationales"
  };
  return map[nodeType] ?? "other";
}

function obsidianNodeSlug(node: GraphNode, pageById: Map<string, GraphPage>): string {
  if (node.pageId) {
    const page = pageById.get(node.pageId);
    if (page) return path.basename(page.path, ".md");
  }
  return slugify(node.label);
}

type AdjacencyEntry = { neighborId: string; relation: string; evidenceClass: string; confidence: number; direction: "out" | "in" };

function buildAdjacency(edges: GraphArtifact["edges"]): Map<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)!.push({
      neighborId: edge.target,
      relation: edge.relation,
      evidenceClass: edge.evidenceClass,
      confidence: edge.confidence,
      direction: "out"
    });
    adjacency.get(edge.target)!.push({
      neighborId: edge.source,
      relation: edge.relation,
      evidenceClass: edge.evidenceClass,
      confidence: edge.confidence,
      direction: "in"
    });
  }
  return adjacency;
}

async function listFilesRecursive(dir: string, base = ""): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function connectionsSection(
  nodeIds: string[],
  adjacency: Map<string, AdjacencyEntry[]>,
  nodesById: Map<string, GraphNode>,
  wikilinkTarget: Map<string, string>
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const nodeId of nodeIds) {
    for (const entry of adjacency.get(nodeId) ?? []) {
      const key = `${entry.neighborId}:${entry.relation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const neighbor = nodesById.get(entry.neighborId);
      if (!neighbor) continue;
      const target = wikilinkTarget.get(entry.neighborId);
      if (!target) continue;
      lines.push(`- [[${target}|${neighbor.label}]] \u2014 ${entry.relation} (${entry.evidenceClass}, ${entry.confidence.toFixed(2)})`);
    }
  }
  return lines;
}

export async function exportObsidianVault(rootDir: string, outputDir: string): Promise<GraphExportResult> {
  const graph = await loadGraph(rootDir);
  const { paths } = await loadVaultConfig(rootDir);
  const resolvedOutputDir = path.resolve(outputDir);
  await ensureDir(resolvedOutputDir);

  const nodesById = graphNodeById(graph);
  const pageById = graphPageById(graph);
  const communities = sortedCommunities(graph);
  const adjacency = buildAdjacency(graph.edges);

  // Group nodes by their pageId
  const nodesByPageId = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.pageId && pageById.has(node.pageId)) {
      const list = nodesByPageId.get(node.pageId) ?? [];
      list.push(node);
      nodesByPageId.set(node.pageId, list);
    }
  }

  // Build orphan node slug map (for nodes without a wiki page)
  const orphanNodes = graph.nodes.filter((node) => !node.pageId || !pageById.has(node.pageId));
  const usedOrphanSlugs = new Set<string>();
  const orphanFilePath = new Map<string, string>();
  for (const node of [...orphanNodes].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))) {
    const slug = deduplicateFileName(obsidianNodeSlug(node, pageById), usedOrphanSlugs);
    orphanFilePath.set(node.id, `graph/nodes/${typePluralDir(node.type)}/${slug}.md`);
  }

  // Build wikilink target map: node id -> wikilink path (without .md)
  const wikilinkTarget = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.pageId) {
      const page = pageById.get(node.pageId);
      if (page) {
        wikilinkTarget.set(node.id, page.path.replace(/\.md$/, ""));
        continue;
      }
    }
    const orphanPath = orphanFilePath.get(node.id);
    if (orphanPath) {
      wikilinkTarget.set(node.id, orphanPath.replace(/\.md$/, ""));
    }
  }

  let fileCount = 0;

  // Layer 1: Copy wiki pages with enriched frontmatter and graph connections
  const wikiFiles = await listFilesRecursive(paths.wikiDir);
  const pageByPath = new Map(graph.pages.map((p) => [p.path, p]));

  for (const relPath of wikiFiles) {
    if (!relPath.endsWith(".md")) continue;
    const srcFile = path.join(paths.wikiDir, relPath);
    const destFile = path.join(resolvedOutputDir, relPath);
    await ensureDir(path.dirname(destFile));

    let rawContent: string;
    try {
      rawContent = await fs.readFile(srcFile, "utf8");
    } catch {
      continue;
    }

    // Find the graph page matching this wiki file
    const matchingPage = pageByPath.get(relPath);
    const pageNodes = matchingPage ? (nodesByPageId.get(matchingPage.id) ?? []) : [];

    // Enrich frontmatter
    const parsed = matter(rawContent);
    const data = parsed.data as Record<string, unknown>;

    if (pageNodes.length > 0) {
      // Add graph community from primary node
      const primaryNode = pageNodes[0];
      if (primaryNode.communityId) {
        data.graph_community = primaryNode.communityId;
      }

      // Add aliases: node labels that differ from the page title
      const title = (data.title as string) ?? "";
      const nodeAliases = pageNodes.map((n) => n.label).filter((label) => label.toLowerCase() !== title.toLowerCase());
      const existingAliases: string[] = Array.isArray(data.aliases) ? (data.aliases as string[]) : [];
      const mergedAliases = [...new Set([...existingAliases, ...nodeAliases])];
      if (mergedAliases.length > 0) {
        data.aliases = mergedAliases;
      }
    }

    // Rebuild content with enriched frontmatter
    let outputContent = matter.stringify(parsed.content, data);

    // Append graph connections section
    if (pageNodes.length > 0) {
      const connLines = connectionsSection(
        pageNodes.map((n) => n.id),
        adjacency,
        nodesById,
        wikilinkTarget
      );
      if (connLines.length > 0) {
        outputContent = `${outputContent.trimEnd()}\n\n## Graph Connections\n\n${connLines.join("\n")}\n`;
      }
    }

    await fs.writeFile(destFile, outputContent, "utf8");
    fileCount++;
  }

  // Layer 2: Create orphan node stubs
  for (const node of orphanNodes) {
    const relPath = orphanFilePath.get(node.id)!;
    const destFile = path.join(resolvedOutputDir, relPath);
    await ensureDir(path.dirname(destFile));

    const slug = path.basename(relPath, ".md");
    const aliases = node.label !== slug ? [node.label] : [];

    const frontmatter: Record<string, unknown> = {
      id: node.id,
      type: node.type,
      community: node.communityId ?? null,
      confidence: node.confidence ?? null,
      source_class: node.sourceClass ?? null,
      tags: node.tags ?? []
    };
    if (aliases.length > 0) {
      frontmatter.aliases = aliases;
    }

    const lines = [`# ${node.label}`, ""];
    const connLines = connectionsSection([node.id], adjacency, nodesById, wikilinkTarget);
    if (connLines.length > 0) {
      lines.push("## Connections", "", ...connLines, "");
    }

    const content = matter.stringify(lines.join("\n"), frontmatter);
    await fs.writeFile(destFile, content, "utf8");
    fileCount++;
  }

  // Write overlay community files only for communities not already covered by wiki pages
  const usedCommunityFileNames = new Set<string>();
  for (const community of communities) {
    // Skip if the wiki already has a page for this community (copied in Layer 1)
    const wikiCommunityPage = graph.pages.find(
      (p) => p.kind === "community_summary" && p.nodeIds.some((nid) => community.nodeIds.includes(nid))
    );
    if (wikiCommunityPage) continue;

    const memberNodes = community.nodeIds.map((id) => nodesById.get(id)).filter((n): n is GraphNode => Boolean(n));

    const memberIdSet = new Set(community.nodeIds);
    let internalEdges = 0;
    for (const edge of graph.edges) {
      if (memberIdSet.has(edge.source) && memberIdSet.has(edge.target)) {
        internalEdges++;
      }
    }
    const n = memberNodes.length;
    const maxPossible = n * (n - 1);
    const cohesion = maxPossible > 0 ? internalEdges / maxPossible : 0;

    const bridgeNodes = memberNodes.filter((node) => {
      const neighbors = adjacency.get(node.id) ?? [];
      return neighbors.some((nb) => {
        const nbNode = nodesById.get(nb.neighborId);
        return nbNode && nbNode.communityId !== community.id;
      });
    });

    const communitySlug = deduplicateFileName(safeFileName(community.label), usedCommunityFileNames);
    const destFile = path.join(resolvedOutputDir, "graph", "communities", `${communitySlug}.md`);
    await ensureDir(path.dirname(destFile));

    const lines: string[] = [`# ${community.label}`, "", "## Members", ""];
    for (const member of memberNodes) {
      const target = wikilinkTarget.get(member.id);
      if (target) {
        lines.push(`- [[${target}|${member.label}]]`);
      } else {
        lines.push(`- ${member.label}`);
      }
    }
    lines.push("");

    if (bridgeNodes.length > 0) {
      lines.push("## Bridge Nodes", "");
      for (const bridge of bridgeNodes) {
        const target = wikilinkTarget.get(bridge.id);
        if (target) {
          lines.push(`- [[${target}|${bridge.label}]]`);
        } else {
          lines.push(`- ${bridge.label}`);
        }
      }
      lines.push("");
    }

    const frontmatter = {
      id: community.id,
      node_count: memberNodes.length,
      cohesion: Number(cohesion.toFixed(4))
    };
    const content = matter.stringify(lines.join("\n"), frontmatter);
    await fs.writeFile(destFile, content, "utf8");
    fileCount++;
  }

  // Copy outputs/assets directory if it exists
  const outputsAssetsDir = path.join(paths.wikiDir, "outputs", "assets");
  try {
    const assetFiles = await listFilesRecursive(outputsAssetsDir);
    for (const relAsset of assetFiles) {
      const src = path.join(outputsAssetsDir, relAsset);
      const dest = path.join(resolvedOutputDir, "outputs", "assets", relAsset);
      await ensureDir(path.dirname(dest));
      await fs.copyFile(src, dest);
      fileCount++;
    }
  } catch {
    // No outputs/assets directory
  }

  // Copy raw/assets directory if it exists
  try {
    const rawAssetFiles = await listFilesRecursive(paths.rawAssetsDir);
    for (const relAsset of rawAssetFiles) {
      const src = path.join(paths.rawAssetsDir, relAsset);
      const dest = path.join(resolvedOutputDir, "raw", "assets", relAsset);
      await ensureDir(path.dirname(dest));
      await fs.copyFile(src, dest);
      fileCount++;
    }
  } catch {
    // No raw/assets directory
  }

  // Write .obsidian config
  const obsidianDir = path.join(resolvedOutputDir, ".obsidian");
  await ensureDir(obsidianDir);
  const projectIds = Object.keys(
    graph.pages.reduce(
      (acc, page) => {
        for (const pid of page.projectIds) acc[pid] = true;
        return acc;
      },
      {} as Record<string, boolean>
    )
  );
  const colorGroups = projectIds.map((pid, index) => ({
    query: `tag:#project/${pid}`,
    color: ["#0ea5e9", "#22c55e", "#f59e0b", "#8b5cf6", "#fb7185", "#14b8a6"][index % 6]
  }));

  await fs.writeFile(
    path.join(obsidianDir, "app.json"),
    JSON.stringify(
      { newFileLocation: "folder", newFileFolderPath: "outputs", attachmentFolderPath: "raw/assets", useMarkdownLinks: false },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(obsidianDir, "core-plugins.json"),
    JSON.stringify(["file-explorer", "global-search", "graph", "backlink", "tag-pane", "page-preview", "outline"], null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(obsidianDir, "graph.json"),
    JSON.stringify(
      { colorGroups, "collapse-filter": false, search: "", showTags: true, showAttachments: false, showOrphans: true },
      null,
      2
    ),
    "utf8"
  );
  fileCount += 3;

  return { format: "obsidian", outputPath: resolvedOutputDir, fileCount };
}

export async function exportObsidianCanvas(rootDir: string, outputPath: string): Promise<GraphExportResult> {
  const graph = await loadGraph(rootDir);
  const communities = sortedCommunities(graph);
  const nodesById = graphNodeById(graph);

  const COLORS = ["1", "2", "3", "4", "5", "6"];
  const NODE_WIDTH = 250;
  const NODE_HEIGHT = 60;
  const NODE_PAD_X = 30;
  const NODE_PAD_Y = 20;
  const GROUP_PAD = 50;
  const GRID_COLS = 3;
  const GROUP_GAP = 100;

  const canvasNodes: Array<{
    id: string;
    type: string;
    text?: string;
    label?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
  }> = [];
  const canvasEdges: Array<{ id: string; fromNode: string; toNode: string; label: string }> = [];

  // Map node id to canvas node id
  const nodeCanvasId = new Map<string, string>();

  // Pre-compute community sizes for consistent grid layout
  const communitySizes = communities.map((community) => {
    const memberCount = community.nodeIds.filter((id) => nodesById.has(id)).length;
    const innerCols = Math.max(1, Math.ceil(Math.sqrt(memberCount)));
    const innerRows = Math.max(1, Math.ceil(memberCount / innerCols));
    const width = innerCols * (NODE_WIDTH + NODE_PAD_X) - NODE_PAD_X + GROUP_PAD * 2;
    const height = innerRows * (NODE_HEIGHT + NODE_PAD_Y) - NODE_PAD_Y + GROUP_PAD * 2 + 30;
    return { width, height, innerCols };
  });

  // Compute max width per column and max height per row
  const totalRows = Math.ceil(communities.length / GRID_COLS);
  const colWidths = new Array(GRID_COLS).fill(0) as number[];
  const rowHeights = new Array(totalRows).fill(0) as number[];
  communitySizes.forEach((size, index) => {
    const col = index % GRID_COLS;
    const row = Math.floor(index / GRID_COLS);
    colWidths[col] = Math.max(colWidths[col], size.width);
    rowHeights[row] = Math.max(rowHeights[row], size.height);
  });

  // Compute cumulative offsets
  const colOffsets = [0];
  for (let c = 1; c < GRID_COLS; c++) {
    colOffsets.push(colOffsets[c - 1] + colWidths[c - 1] + GROUP_GAP);
  }
  const rowOffsets = [0];
  for (let r = 1; r < totalRows; r++) {
    rowOffsets.push(rowOffsets[r - 1] + rowHeights[r - 1] + GROUP_GAP);
  }

  communities.forEach((community, communityIndex) => {
    const members = community.nodeIds
      .map((id) => nodesById.get(id))
      .filter((n): n is GraphNode => Boolean(n))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

    const col = communityIndex % GRID_COLS;
    const row = Math.floor(communityIndex / GRID_COLS);
    const { width: groupWidth, height: groupHeight, innerCols } = communitySizes[communityIndex];

    const groupX = colOffsets[col];
    const groupY = rowOffsets[row];

    // Add group node
    canvasNodes.push({
      id: `group-${community.id}`,
      type: "group",
      label: community.label,
      x: groupX,
      y: groupY,
      width: groupWidth,
      height: groupHeight
    });

    // Add member nodes inside the group
    members.forEach((node, memberIndex) => {
      const innerCol = memberIndex % innerCols;
      const innerRow = Math.floor(memberIndex / innerCols);

      const nodeX = groupX + GROUP_PAD + innerCol * (NODE_WIDTH + NODE_PAD_X);
      const nodeY = groupY + GROUP_PAD + 30 + innerRow * (NODE_HEIGHT + NODE_PAD_Y);

      const canvasId = `node-${node.id}`;
      nodeCanvasId.set(node.id, canvasId);

      const communityLabel = community.id === "community:unassigned" ? "Unassigned" : community.label;
      canvasNodes.push({
        id: canvasId,
        type: "text",
        text: `**${node.label}**\nType: ${node.type}\nCommunity: ${communityLabel}`,
        x: nodeX,
        y: nodeY,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        color: COLORS[communityIndex % COLORS.length]
      });
    });
  });

  // Add edges
  for (const edge of graph.edges) {
    const fromId = nodeCanvasId.get(edge.source);
    const toId = nodeCanvasId.get(edge.target);
    if (!fromId || !toId) continue;
    canvasEdges.push({
      id: `edge-${edge.id}`,
      fromNode: fromId,
      toNode: toId,
      label: edge.relation
    });
  }

  const canvas = {
    nodes: canvasNodes,
    edges: canvasEdges
  };

  const resolvedPath = await writeGraphExport(outputPath, JSON.stringify(canvas, null, 2));
  return { format: "canvas", outputPath: resolvedPath };
}

export async function hasGraphArtifact(rootDir: string): Promise<boolean> {
  const { paths } = await loadVaultConfig(rootDir);
  return fileExists(paths.graphPath);
}
