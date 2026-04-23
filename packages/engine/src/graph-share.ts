import type { GraphArtifact, GraphNode, GraphReportArtifact, GraphShareArtifact } from "./types.js";
import { truncate, uniqueBy } from "./utils.js";

function displayVaultName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "this vault";
}

function sortedFallbackHubs(graph: GraphArtifact): GraphNode[] {
  return graph.nodes
    .filter((node) => node.type !== "source")
    .sort(
      (left, right) =>
        (right.degree ?? 0) - (left.degree ?? 0) ||
        (right.bridgeScore ?? 0) - (left.bridgeScore ?? 0) ||
        left.label.localeCompare(right.label)
    )
    .slice(0, 5);
}

function graphNodeMap(graph: GraphArtifact): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function compactJoin(values: string[], fallback: string): string {
  const filtered = values.filter(Boolean);
  if (!filtered.length) {
    return fallback;
  }
  if (filtered.length === 1) {
    return filtered[0] ?? fallback;
  }
  if (filtered.length === 2) {
    return `${filtered[0]} and ${filtered[1]}`;
  }
  return `${filtered.slice(0, -1).join(", ")}, and ${filtered[filtered.length - 1]}`;
}

function buildShortPost(input: {
  vaultName: string;
  overview: GraphShareArtifact["overview"];
  topHubs: GraphShareArtifact["highlights"]["topHubs"];
  surprisingConnections: GraphShareArtifact["highlights"]["surprisingConnections"];
}): string {
  const topHubLine = input.topHubs.length
    ? `Top hubs: ${compactJoin(
        input.topHubs.slice(0, 3).map((node) => node.label),
        "still emerging"
      )}.`
    : "Top hubs are still emerging.";
  const surprise = input.surprisingConnections[0];
  const surpriseLine = surprise
    ? `Most surprising link: ${surprise.sourceLabel} ${surprise.relation} ${surprise.targetLabel}.`
    : "The graph is ready for its first surprising connection.";

  return [
    `I scanned ${input.vaultName} with SwarmVault: ${input.overview.sources} sources -> ${input.overview.pages} wiki pages, ${input.overview.nodes} graph nodes, ${input.overview.edges} edges.`,
    topHubLine,
    surpriseLine,
    "Everything stays local. Try: npm install -g @swarmvaultai/cli && swarmvault scan ./your-repo"
  ].join("\n");
}

function escapeXml(value: string | number | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replaceAll("\n", " ").replaceAll("\r", " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function svgText(input: {
  x: number;
  y: number;
  text: string;
  size: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
}): string {
  const attrs = [
    `x="${input.x}"`,
    `y="${input.y}"`,
    `font-size="${input.size}"`,
    `fill="${input.fill ?? "#f8fafc"}"`,
    `font-weight="${input.weight ?? 500}"`,
    `text-anchor="${input.anchor ?? "start"}"`,
    input.opacity === undefined ? "" : `opacity="${input.opacity}"`
  ].filter(Boolean);
  return `  <text ${attrs.join(" ")}>${escapeXml(input.text)}</text>`;
}

function svgStatCard(input: { x: number; y: number; label: string; value: string | number }): string[] {
  return [
    `  <rect x="${input.x}" y="${input.y}" width="168" height="92" rx="14" fill="#111827" stroke="#334155" />`,
    svgText({ x: input.x + 20, y: input.y + 36, text: String(input.value), size: 30, fill: "#ecfeff", weight: 800 }),
    svgText({ x: input.x + 20, y: input.y + 66, text: input.label, size: 16, fill: "#94a3b8", weight: 600 })
  ];
}

function svgListLines(input: { x: number; y: number; title: string; items: string[]; empty: string; maxItems: number }): string[] {
  const items = input.items.length ? input.items.slice(0, input.maxItems) : [input.empty];
  const lines = [svgText({ x: input.x, y: input.y, text: input.title, size: 19, fill: "#a7f3d0", weight: 800 })];
  for (const [index, item] of items.entries()) {
    lines.push(
      svgText({ x: input.x, y: input.y + 38 + index * 30, text: `- ${clipText(item, 58)}`, size: 19, fill: "#e2e8f0", weight: 600 })
    );
  }
  return lines;
}

export function buildGraphShareArtifact(input: {
  graph: GraphArtifact;
  report?: GraphReportArtifact | null;
  vaultName?: string;
}): GraphShareArtifact {
  const { graph, report } = input;
  const vaultName = displayVaultName(input.vaultName);
  const nodesById = graphNodeMap(graph);
  const fallbackHubs = sortedFallbackHubs(graph);
  const reportHubs =
    report?.godNodes.map((node) => {
      const graphNode = nodesById.get(node.nodeId);
      return {
        nodeId: node.nodeId,
        label: node.label ?? graphNode?.label ?? node.nodeId,
        degree: node.degree ?? graphNode?.degree
      };
    }) ?? [];
  const fallbackHubHighlights = fallbackHubs.map((node) => ({
    nodeId: node.id,
    label: node.label,
    degree: node.degree
  }));
  const topHubs = (reportHubs.length ? reportHubs : fallbackHubHighlights).slice(0, 5);
  const reportBridgeNodes =
    report?.bridgeNodes.map((node) => {
      const graphNode = nodesById.get(node.nodeId);
      return {
        nodeId: node.nodeId,
        label: node.label ?? graphNode?.label ?? node.nodeId,
        bridgeScore: node.bridgeScore ?? graphNode?.bridgeScore
      };
    }) ?? [];
  const fallbackBridgeNodes = fallbackHubs.map((node) => ({
    nodeId: node.id,
    label: node.label,
    bridgeScore: node.bridgeScore
  }));
  const bridgeNodes = (reportBridgeNodes.length ? reportBridgeNodes : fallbackBridgeNodes).slice(0, 3).filter((node) => node.label);
  const surprisingConnections = (report?.surprisingConnections ?? []).slice(0, 3).map((connection) => {
    const source = nodesById.get(connection.sourceNodeId);
    const target = nodesById.get(connection.targetNodeId);
    return {
      sourceLabel: source?.label ?? connection.sourceNodeId,
      targetLabel: target?.label ?? connection.targetNodeId,
      relation: connection.relation,
      why: truncate(connection.why || connection.explanation || "Cross-community connection", 180)
    };
  });
  const overview = {
    sources: graph.sources.length,
    nodes: report?.overview.nodes ?? graph.nodes.length,
    edges: report?.overview.edges ?? graph.edges.length,
    pages: report?.overview.pages ?? graph.pages.length,
    communities: report?.overview.communities ?? graph.communities?.length ?? 0
  };
  const firstPartyOverview = report?.firstPartyOverview ?? {
    nodes: graph.nodes.filter((node) => node.sourceClass === "first_party").length,
    edges: graph.edges.length,
    pages: graph.pages.filter((page) => page.sourceClass === "first_party").length,
    communities: graph.communities?.length ?? 0
  };
  const relatedNodeIds = uniqueBy([...topHubs.map((node) => node.nodeId), ...bridgeNodes.map((node) => node.nodeId)], (value) => value);
  const relatedPageIds = uniqueBy(
    relatedNodeIds.map((nodeId) => nodesById.get(nodeId)?.pageId).filter((pageId): pageId is string => Boolean(pageId)),
    (value) => value
  );
  const relatedSourceIds = uniqueBy(
    [...graph.sources.map((source) => source.sourceId), ...relatedNodeIds.flatMap((nodeId) => nodesById.get(nodeId)?.sourceIds ?? [])],
    (value) => value
  );
  const knowledgeGaps = report?.knowledgeGaps?.warnings?.length
    ? report.knowledgeGaps.warnings.slice(0, 3)
    : report?.warnings?.length
      ? report.warnings.slice(0, 3)
      : [];
  const tagline = `A local-first map of ${vaultName}: ${overview.sources} sources compiled into ${overview.nodes} graph nodes and ${overview.pages} wiki pages.`;
  const artifact = {
    generatedAt: new Date().toISOString(),
    vaultName,
    tagline,
    overview,
    firstPartyOverview,
    highlights: {
      topHubs,
      bridgeNodes,
      surprisingConnections,
      suggestedQuestions: (report?.suggestedQuestions ?? []).slice(0, 5)
    },
    knowledgeGaps,
    shortPost: "",
    relatedNodeIds,
    relatedPageIds,
    relatedSourceIds
  } satisfies GraphShareArtifact;

  return {
    ...artifact,
    shortPost: buildShortPost({
      vaultName,
      overview,
      topHubs,
      surprisingConnections
    })
  };
}

export function renderGraphShareMarkdown(artifact: GraphShareArtifact): string {
  const lines = [
    "# SwarmVault Share Card",
    "",
    `> ${artifact.tagline}`,
    "",
    "## Snapshot",
    "",
    `- Sources: ${artifact.overview.sources}`,
    `- Wiki pages: ${artifact.overview.pages}`,
    `- Graph nodes: ${artifact.overview.nodes}`,
    `- Graph edges: ${artifact.overview.edges}`,
    `- Communities: ${artifact.overview.communities}`,
    `- First-party focus: ${artifact.firstPartyOverview.nodes} nodes, ${artifact.firstPartyOverview.edges} edges, ${artifact.firstPartyOverview.pages} pages`,
    "",
    "## Highlights",
    "",
    artifact.highlights.topHubs.length
      ? `- Top hubs: ${compactJoin(
          artifact.highlights.topHubs.slice(0, 5).map((node) => (node.degree ? `${node.label} (${node.degree})` : node.label)),
          "none yet"
        )}`
      : "- Top hubs: none yet",
    artifact.highlights.bridgeNodes.length
      ? `- Bridge nodes: ${compactJoin(
          artifact.highlights.bridgeNodes.slice(0, 3).map((node) => node.label),
          "none yet"
        )}`
      : "- Bridge nodes: none yet",
    ...(artifact.highlights.surprisingConnections.length
      ? artifact.highlights.surprisingConnections.map(
          (connection) => `- Surprising link: ${connection.sourceLabel} ${connection.relation} ${connection.targetLabel}. ${connection.why}`
        )
      : ["- Surprising link: not enough cross-community evidence yet"]),
    "",
    "## Ask Next",
    "",
    ...(artifact.highlights.suggestedQuestions.length
      ? artifact.highlights.suggestedQuestions.map((question) => `- ${question}`)
      : ["- Add more sources, run `swarmvault compile`, then ask the graph what changed."]),
    "",
    "## Share Post",
    "",
    "```text",
    artifact.shortPost,
    "```",
    "",
    "## Reproduce",
    "",
    "```bash",
    "npm install -g @swarmvaultai/cli",
    "swarmvault scan ./your-repo",
    "swarmvault graph share --post",
    "```",
    ""
  ];

  if (artifact.knowledgeGaps.length) {
    lines.splice(
      lines.indexOf("## Ask Next"),
      0,
      "## Gaps To Strengthen",
      "",
      ...artifact.knowledgeGaps.map((warning) => `- ${warning}`),
      ""
    );
  }

  return `${lines.join("\n")}`;
}

export function renderGraphShareSvg(artifact: GraphShareArtifact): string {
  const topHubs = artifact.highlights.topHubs.map((node) => (node.degree ? `${node.label} (${node.degree})` : node.label));
  const bridges = artifact.highlights.bridgeNodes.map((node) => node.label);
  const surprise = artifact.highlights.surprisingConnections[0];
  const surpriseLine = surprise
    ? `${surprise.sourceLabel} ${surprise.relation} ${surprise.targetLabel}`
    : "Add more sources to reveal the first surprising link";
  const generated = new Date(artifact.generatedAt);
  const generatedLabel = Number.isNaN(generated.getTime()) ? artifact.generatedAt : generated.toISOString().slice(0, 10);

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">`,
    `  <title>SwarmVault share card for ${escapeXml(artifact.vaultName)}</title>`,
    `  <desc>${escapeXml(artifact.tagline)}</desc>`,
    "  <defs>",
    '    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">',
    '      <stop offset="0%" stop-color="#020617" />',
    '      <stop offset="58%" stop-color="#0f172a" />',
    '      <stop offset="100%" stop-color="#063f37" />',
    "    </linearGradient>",
    '    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">',
    '      <stop offset="0%" stop-color="#22c55e" />',
    '      <stop offset="100%" stop-color="#06b6d4" />',
    "    </linearGradient>",
    "  </defs>",
    '  <rect width="1200" height="630" fill="url(#background)" />',
    '  <rect x="34" y="34" width="1132" height="562" rx="28" fill="#020617" opacity="0.72" stroke="#1f2937" />',
    '  <path d="M92 512 C214 386 314 456 438 326 C540 218 648 284 746 194 C860 88 1004 152 1110 84" fill="none" stroke="#22c55e" stroke-width="4" opacity="0.35" />',
    '  <circle cx="92" cy="512" r="9" fill="#22c55e" />',
    '  <circle cx="438" cy="326" r="10" fill="#06b6d4" />',
    '  <circle cx="746" cy="194" r="10" fill="#a7f3d0" />',
    '  <circle cx="1110" cy="84" r="9" fill="#22c55e" />',
    svgText({ x: 78, y: 96, text: "SwarmVault", size: 28, fill: "#86efac", weight: 900 }),
    svgText({ x: 78, y: 152, text: clipText(artifact.vaultName, 42), size: 54, fill: "#f8fafc", weight: 900 }),
    svgText({ x: 78, y: 196, text: clipText(artifact.tagline, 86), size: 22, fill: "#cbd5e1", weight: 600 }),
    ...svgStatCard({ x: 78, y: 242, label: "Sources", value: artifact.overview.sources }),
    ...svgStatCard({ x: 270, y: 242, label: "Wiki pages", value: artifact.overview.pages }),
    ...svgStatCard({ x: 462, y: 242, label: "Graph nodes", value: artifact.overview.nodes }),
    ...svgStatCard({ x: 654, y: 242, label: "Edges", value: artifact.overview.edges }),
    `  <rect x="870" y="240" width="246" height="94" rx="18" fill="url(#accent)" opacity="0.95" />`,
    svgText({ x: 993, y: 278, text: "Local-first", size: 22, fill: "#052e16", weight: 900, anchor: "middle" }),
    svgText({ x: 993, y: 307, text: "no API keys required", size: 18, fill: "#064e3b", weight: 800, anchor: "middle" }),
    ...svgListLines({
      x: 82,
      y: 398,
      title: "Top hubs",
      items: topHubs,
      empty: "Still emerging",
      maxItems: 3
    }),
    ...svgListLines({
      x: 470,
      y: 398,
      title: "Bridge nodes",
      items: bridges,
      empty: "Still emerging",
      maxItems: 3
    }),
    svgText({ x: 820, y: 398, text: "Surprising link", size: 19, fill: "#a7f3d0", weight: 800 }),
    svgText({ x: 820, y: 436, text: clipText(surpriseLine, 40), size: 21, fill: "#e2e8f0", weight: 800 }),
    svgText({
      x: 820,
      y: 470,
      text: clipText(surprise?.why ?? "Run compile again after adding more sources.", 44),
      size: 17,
      fill: "#94a3b8",
      weight: 600
    }),
    `  <rect x="78" y="536" width="744" height="42" rx="12" fill="#0f172a" stroke="#1e293b" />`,
    svgText({
      x: 100,
      y: 564,
      text: "npm install -g @swarmvaultai/cli && swarmvault scan ./your-repo",
      size: 18,
      fill: "#d1fae5",
      weight: 800
    }),
    svgText({ x: 1116, y: 564, text: `Generated ${generatedLabel}`, size: 16, fill: "#94a3b8", weight: 600, anchor: "end" }),
    "</svg>",
    ""
  ];

  return lines.join("\n");
}
