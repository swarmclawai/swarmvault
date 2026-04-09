import type { GraphArtifact, GraphHyperedge, GraphNode, GraphReportArtifact } from "./types.js";

const OVERVIEW_THRESHOLD = 5_000;
const OVERVIEW_NODE_BUDGET = 1_500;

export interface ViewerGraphPresentation {
  mode: "full" | "overview";
  threshold: number;
  nodeBudget: number;
  totalNodes: number;
  displayedNodes: number;
  totalEdges: number;
  displayedEdges: number;
  totalCommunities: number;
  displayedCommunities: number;
}

export type ViewerGraphArtifact = GraphArtifact & {
  presentation: ViewerGraphPresentation;
};

function nodePriority(node: GraphNode, pinnedNodeIds: Set<string>): [number, number, number, string, string] {
  return [pinnedNodeIds.has(node.id) ? 0 : 1, -(node.degree ?? 0), -(node.bridgeScore ?? 0), node.label, node.id];
}

function compareTuples(left: Array<number | string>, right: Array<number | string>): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      return leftValue - rightValue;
    }
    return String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
  }
  return 0;
}

function survivingHyperedges(hyperedges: GraphHyperedge[], sampledNodeIds: Set<string>): GraphHyperedge[] {
  return hyperedges.filter((hyperedge) => hyperedge.nodeIds.filter((nodeId) => sampledNodeIds.has(nodeId)).length >= 2);
}

function pinnedNodeIdsForReport(report: GraphReportArtifact | null | undefined): Set<string> {
  if (!report) {
    return new Set();
  }

  return new Set([
    ...report.godNodes.map((node) => node.nodeId),
    ...report.bridgeNodes.map((node) => node.nodeId),
    ...report.surprisingConnections.flatMap((connection) => [connection.sourceNodeId, connection.targetNodeId])
  ]);
}

function sampleGraphNodes(graph: GraphArtifact, report?: GraphReportArtifact | null, nodeBudget = OVERVIEW_NODE_BUDGET): Set<string> {
  const pinned = pinnedNodeIdsForReport(report);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selected = new Set([...pinned].filter((nodeId) => nodeById.has(nodeId)));

  const sortedCommunities = [...(graph.communities ?? [])].sort((left, right) => {
    const leftNodes = left.nodeIds.map((nodeId) => nodeById.get(nodeId)).filter((node): node is GraphNode => Boolean(node));
    const rightNodes = right.nodeIds.map((nodeId) => nodeById.get(nodeId)).filter((node): node is GraphNode => Boolean(node));
    const leftFirstParty = leftNodes.filter((node) => node.sourceClass === "first_party").length;
    const rightFirstParty = rightNodes.filter((node) => node.sourceClass === "first_party").length;
    return compareTuples(
      [-leftFirstParty, -leftNodes.length, left.label, left.id],
      [-rightFirstParty, -rightNodes.length, right.label, right.id]
    );
  });

  for (const community of sortedCommunities) {
    const communityNodes = community.nodeIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) => compareTuples(nodePriority(left, pinned), nodePriority(right, pinned)));

    for (const node of communityNodes) {
      if (selected.size >= nodeBudget && !pinned.has(node.id)) {
        break;
      }
      selected.add(node.id);
    }
    if (selected.size >= nodeBudget) {
      break;
    }
  }

  if (selected.size < nodeBudget) {
    for (const node of [...graph.nodes].sort((left, right) => compareTuples(nodePriority(left, pinned), nodePriority(right, pinned)))) {
      if (selected.size >= nodeBudget && !pinned.has(node.id)) {
        break;
      }
      selected.add(node.id);
    }
  }

  return selected;
}

export function buildViewerGraphArtifact(
  graph: GraphArtifact,
  options: {
    report?: GraphReportArtifact | null;
    full?: boolean;
    threshold?: number;
    nodeBudget?: number;
  } = {}
): ViewerGraphArtifact {
  const threshold = options.threshold ?? OVERVIEW_THRESHOLD;
  const nodeBudget = options.nodeBudget ?? OVERVIEW_NODE_BUDGET;
  const totalCommunities = graph.communities?.length ?? 0;

  if (options.full || graph.nodes.length <= threshold) {
    return {
      ...graph,
      presentation: {
        mode: "full",
        threshold,
        nodeBudget,
        totalNodes: graph.nodes.length,
        displayedNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        displayedEdges: graph.edges.length,
        totalCommunities,
        displayedCommunities: totalCommunities
      }
    };
  }

  const sampledNodeIds = sampleGraphNodes(graph, options.report, nodeBudget);
  const nodes = graph.nodes.filter((node) => sampledNodeIds.has(node.id));
  const edges = graph.edges.filter((edge) => sampledNodeIds.has(edge.source) && sampledNodeIds.has(edge.target));
  const hyperedges = survivingHyperedges(graph.hyperedges ?? [], sampledNodeIds);
  const communities = (graph.communities ?? [])
    .map((community) => ({
      ...community,
      nodeIds: community.nodeIds.filter((nodeId) => sampledNodeIds.has(nodeId))
    }))
    .filter((community) => community.nodeIds.length > 0);

  return {
    ...graph,
    nodes,
    edges,
    hyperedges,
    communities,
    presentation: {
      mode: "overview",
      threshold,
      nodeBudget,
      totalNodes: graph.nodes.length,
      displayedNodes: nodes.length,
      totalEdges: graph.edges.length,
      displayedEdges: edges.length,
      totalCommunities,
      displayedCommunities: communities.length
    }
  };
}
