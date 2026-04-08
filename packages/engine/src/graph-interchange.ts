import type { GraphArtifact, GraphEdge, GraphHyperedge, GraphNode, GraphPage, GraphPushCounts, SourceClass } from "./types.js";

export function exportHyperedgeNodeId(hyperedge: GraphHyperedge): string {
  return `hyperedge:${hyperedge.id}`;
}

export function relationType(relation: string): string {
  const normalized = relation
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "RELATED_TO";
}

export function cypherStringLiteral(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case "'":
        escaped += "\\'";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\b":
        escaped += "\\b";
        break;
      case "\f":
        escaped += "\\f";
        break;
      default: {
        const code = char.codePointAt(0) ?? 0;
        escaped += code < 0x20 || code === 0x2028 || code === 0x2029 ? `\\u${code.toString(16).padStart(4, "0")}` : char;
      }
    }
  }
  return `'${escaped}'`;
}

export function graphPageById(graph: GraphArtifact): Map<string, GraphPage> {
  return new Map(graph.pages.map((page) => [page.id, page]));
}

export function graphNodeById(graph: GraphArtifact): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

export function normalizeSwarmNodeProps(node: GraphNode, page?: GraphPage): Record<string, boolean | number | string> {
  return {
    id: node.id,
    label: node.label,
    type: node.type,
    sourceIds: JSON.stringify(node.sourceIds),
    projectIds: JSON.stringify(node.projectIds),
    ...(node.pageId ? { pageId: node.pageId } : {}),
    ...(page?.path ? { pagePath: page.path } : {}),
    ...(node.sourceClass ? { sourceClass: node.sourceClass } : {}),
    ...(node.language ? { language: node.language } : {}),
    ...(node.moduleId ? { moduleId: node.moduleId } : {}),
    ...(node.symbolKind ? { symbolKind: node.symbolKind } : {}),
    ...(node.communityId ? { communityId: node.communityId } : {}),
    ...(node.freshness ? { freshness: node.freshness } : {}),
    ...(node.confidence !== undefined ? { confidence: node.confidence } : {}),
    ...(node.degree !== undefined ? { degree: node.degree } : {}),
    ...(node.bridgeScore !== undefined ? { bridgeScore: node.bridgeScore } : {}),
    ...(node.isGodNode !== undefined ? { isGodNode: node.isGodNode } : {})
  };
}

export function normalizeHyperedgeNodeProps(hyperedge: GraphHyperedge): Record<string, boolean | number | string> {
  return {
    id: exportHyperedgeNodeId(hyperedge),
    label: hyperedge.label,
    type: "hyperedge",
    relation: hyperedge.relation,
    evidenceClass: hyperedge.evidenceClass,
    confidence: hyperedge.confidence,
    sourcePageIds: JSON.stringify(hyperedge.sourcePageIds),
    why: hyperedge.why
  };
}

export function normalizeEdgeProps(edge: GraphEdge): Record<string, boolean | number | string> {
  return {
    id: edge.id,
    relation: edge.relation,
    status: edge.status,
    evidenceClass: edge.evidenceClass,
    confidence: edge.confidence,
    provenance: JSON.stringify(edge.provenance),
    ...(edge.similarityReasons?.length ? { similarityReasons: JSON.stringify(edge.similarityReasons) } : {}),
    ...(edge.similarityBasis ? { similarityBasis: edge.similarityBasis } : {})
  };
}

export function normalizeGroupMemberProps(hyperedge: GraphHyperedge, nodeId: string): Record<string, boolean | number | string> {
  return {
    id: `member:${hyperedge.id}:${nodeId}`,
    relation: "group_member",
    status: "inferred",
    evidenceClass: hyperedge.evidenceClass,
    confidence: hyperedge.confidence,
    provenance: JSON.stringify(hyperedge.sourcePageIds)
  };
}

export function filterGraphBySourceClasses(graph: GraphArtifact, includeClasses: SourceClass[]): GraphArtifact {
  const allowed = new Set(includeClasses);
  const nodeIds = new Set(graph.nodes.filter((node) => node.sourceClass && allowed.has(node.sourceClass)).map((node) => node.id));
  const pageIds = new Set(graph.pages.filter((page) => page.sourceClass && allowed.has(page.sourceClass)).map((page) => page.id));
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => nodeIds.has(node.id)),
    edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    hyperedges: graph.hyperedges
      .map((hyperedge) => ({
        ...hyperedge,
        nodeIds: hyperedge.nodeIds.filter((nodeId) => nodeIds.has(nodeId))
      }))
      .filter((hyperedge) => hyperedge.nodeIds.length >= 2),
    communities: (graph.communities ?? [])
      .map((community) => ({
        ...community,
        nodeIds: community.nodeIds.filter((nodeId) => nodeIds.has(nodeId))
      }))
      .filter((community) => community.nodeIds.length > 0),
    sources: graph.sources.filter((source) => source.sourceClass && allowed.has(source.sourceClass)),
    pages: graph.pages.filter((page) => pageIds.has(page.id))
  };
}

export function graphCounts(graph: GraphArtifact): GraphPushCounts {
  return {
    sources: graph.sources.length,
    pages: graph.pages.length,
    nodes: graph.nodes.length,
    relationships: graph.edges.length,
    hyperedges: graph.hyperedges.length,
    groupMembers: graph.hyperedges.reduce((total, hyperedge) => total + hyperedge.nodeIds.length, 0)
  };
}
