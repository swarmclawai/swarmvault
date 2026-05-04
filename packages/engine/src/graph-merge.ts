import fs from "node:fs/promises";
import path from "node:path";
import type { EvidenceClass, GraphArtifact, GraphEdge, GraphNode, GraphPage, SourceManifest } from "./types.js";
import { ensureDir, sha256, slugify, toPosix, uniqueBy } from "./utils.js";

export interface GraphMergeInputSummary {
  path: string;
  label: string;
  format: "swarmvault" | "node-link";
  nodeCount: number;
  edgeCount: number;
}

export interface GraphMergeOptions {
  label?: string;
}

export interface GraphMergeResult {
  outputPath: string;
  graph: GraphArtifact;
  inputGraphs: GraphMergeInputSummary[];
  warnings: string[];
}

type NodeLinkNode = Record<string, unknown> | string | number;
type NodeLinkEdge = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSwarmVaultGraph(value: unknown): value is GraphArtifact {
  return (
    isRecord(value) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    Array.isArray(value.sources) &&
    Array.isArray(value.pages)
  );
}

function stringField(record: Record<string, unknown>, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function arrayStringField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function numberField(record: Record<string, unknown>, field: string, fallback: number): number {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safePrefix(inputPath: string, index: number): string {
  return slugify(path.basename(inputPath, path.extname(inputPath)) || `graph-${index + 1}`);
}

function prefixed(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

function ensureUniquePrefix(base: string, used: Set<string>): string {
  let candidate = base || "graph";
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function mapEvidenceClass(value: unknown): EvidenceClass {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (normalized === "extracted") return "extracted";
  if (normalized === "ambiguous") return "ambiguous";
  return "inferred";
}

function mapNodeType(value: unknown): GraphNode["type"] {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (["source", "file", "document", "paper", "image", "video"].includes(normalized)) return "source";
  if (["module", "code"].includes(normalized)) return "module";
  if (["function", "class", "symbol", "method", "component"].includes(normalized)) return "symbol";
  if (["entity", "person", "org", "organization"].includes(normalized)) return "entity";
  if (["rationale", "comment", "docstring", "why"].includes(normalized)) return "rationale";
  if (["decision", "adr"].includes(normalized)) return "decision";
  return "concept";
}

function remapSwarmVaultGraph(inputPath: string, graph: GraphArtifact, prefix: string): GraphArtifact {
  const sourceMap = new Map(graph.sources.map((source) => [source.sourceId, prefixed(prefix, source.sourceId)]));
  const pageMap = new Map(graph.pages.map((page) => [page.id, prefixed(prefix, page.id)]));
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, prefixed(prefix, node.id)]));
  const communityMap = new Map((graph.communities ?? []).map((community) => [community.id, prefixed(prefix, community.id)]));

  const sources = graph.sources.map((source) => ({
    ...source,
    sourceId: sourceMap.get(source.sourceId) ?? prefixed(prefix, source.sourceId),
    title: `[${prefix}] ${source.title}`,
    sourceGroupId: source.sourceGroupId ? prefixed(prefix, source.sourceGroupId) : undefined,
    details: {
      ...(source.details ?? {}),
      mergedInput: inputPath,
      mergedPrefix: prefix
    }
  }));

  const pages = graph.pages.map((page) => ({
    ...page,
    id: pageMap.get(page.id) ?? prefixed(prefix, page.id),
    path: toPosix(path.posix.join("merged", prefix, page.path)),
    sourceIds: page.sourceIds.map((sourceId) => sourceMap.get(sourceId) ?? prefixed(prefix, sourceId)),
    nodeIds: page.nodeIds.map((nodeId) => nodeMap.get(nodeId) ?? prefixed(prefix, nodeId)),
    relatedPageIds: page.relatedPageIds.map((pageId) => pageMap.get(pageId) ?? prefixed(prefix, pageId)),
    relatedNodeIds: page.relatedNodeIds.map((nodeId) => nodeMap.get(nodeId) ?? prefixed(prefix, nodeId)),
    relatedSourceIds: page.relatedSourceIds.map((sourceId) => sourceMap.get(sourceId) ?? prefixed(prefix, sourceId)),
    backlinks: page.backlinks.map((pageId) => pageMap.get(pageId) ?? prefixed(prefix, pageId)),
    supersededBy: page.supersededBy ? (pageMap.get(page.supersededBy) ?? prefixed(prefix, page.supersededBy)) : undefined
  }));

  const nodes = graph.nodes.map((node) => ({
    ...node,
    id: nodeMap.get(node.id) ?? prefixed(prefix, node.id),
    pageId: node.pageId ? (pageMap.get(node.pageId) ?? prefixed(prefix, node.pageId)) : undefined,
    sourceIds: node.sourceIds.map((sourceId) => sourceMap.get(sourceId) ?? prefixed(prefix, sourceId)),
    moduleId: node.moduleId ? (nodeMap.get(node.moduleId) ?? prefixed(prefix, node.moduleId)) : undefined,
    communityId: node.communityId ? (communityMap.get(node.communityId) ?? prefixed(prefix, node.communityId)) : undefined
  }));

  const edges = graph.edges.map((edge) => ({
    ...edge,
    id: prefixed(prefix, edge.id),
    source: nodeMap.get(edge.source) ?? prefixed(prefix, edge.source),
    target: nodeMap.get(edge.target) ?? prefixed(prefix, edge.target),
    provenance: edge.provenance.map((id) => nodeMap.get(id) ?? pageMap.get(id) ?? sourceMap.get(id) ?? prefixed(prefix, id))
  }));

  const hyperedges = graph.hyperedges.map((hyperedge) => ({
    ...hyperedge,
    id: prefixed(prefix, hyperedge.id),
    nodeIds: hyperedge.nodeIds.map((nodeId) => nodeMap.get(nodeId) ?? prefixed(prefix, nodeId)),
    sourcePageIds: hyperedge.sourcePageIds.map((pageId) => pageMap.get(pageId) ?? prefixed(prefix, pageId))
  }));

  return {
    generatedAt: graph.generatedAt,
    nodes,
    edges,
    hyperedges,
    communities: (graph.communities ?? []).map((community) => ({
      ...community,
      id: communityMap.get(community.id) ?? prefixed(prefix, community.id),
      label: `[${prefix}] ${community.label}`,
      nodeIds: community.nodeIds.map((nodeId) => nodeMap.get(nodeId) ?? prefixed(prefix, nodeId))
    })),
    sources,
    pages
  };
}

function nodeLinkArrays(raw: Record<string, unknown>): { nodes: NodeLinkNode[]; edges: NodeLinkEdge[] } | null {
  const nodes = raw.nodes;
  const edges = Array.isArray(raw.links) ? raw.links : raw.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return null;
  }
  return {
    nodes: nodes as NodeLinkNode[],
    edges: edges.filter(isRecord)
  };
}

function nodeLinkNodeId(node: NodeLinkNode, index: number): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return stringField(node, "id", "key", "name", "label") ?? `node-${index + 1}`;
}

function endpointId(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (isRecord(value)) {
    return stringField(value, "id", "key", "name", "label");
  }
  return undefined;
}

function remapNodeLinkGraph(inputPath: string, raw: Record<string, unknown>, prefix: string, now: string): GraphArtifact {
  const arrays = nodeLinkArrays(raw);
  if (!arrays) {
    throw new Error(`${inputPath} is not a SwarmVault graph or node-link graph.`);
  }
  const syntheticSourceId = prefixed(prefix, "source");
  const source: SourceManifest = {
    sourceId: syntheticSourceId,
    title: `${prefix} merged graph`,
    originType: "file",
    sourceKind: "data",
    sourceClass: "generated",
    originalPath: inputPath,
    storedPath: inputPath,
    mimeType: "application/json",
    contentHash: `sha256:${sha256(JSON.stringify(raw)).slice(0, 24)}`,
    semanticHash: `sha256:${sha256(`${inputPath}:${arrays.nodes.length}:${arrays.edges.length}`).slice(0, 24)}`,
    details: {
      mergedInput: inputPath,
      mergedFormat: "node-link"
    },
    createdAt: now,
    updatedAt: now
  };
  const idMap = new Map<string, string>();
  const nodes: GraphNode[] = arrays.nodes.map((node, index) => {
    const originalId = nodeLinkNodeId(node, index);
    const mappedId = prefixed(prefix, originalId);
    idMap.set(originalId, mappedId);
    const record = isRecord(node) ? node : {};
    const label = stringField(record, "label", "name", "title", "path", "id") ?? originalId;
    const type = mapNodeType(record.type ?? record.file_type ?? record.kind ?? record.category);
    return {
      id: mappedId,
      type,
      label,
      sourceIds: [syntheticSourceId],
      projectIds: [],
      sourceClass: "generated",
      confidence: numberField(record, "confidence", numberField(record, "confidence_score", 1)),
      tags: arrayStringField(record, "tags")
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = arrays.edges.flatMap((edge, index) => {
    const source = endpointId(edge.source ?? edge.from);
    const target = endpointId(edge.target ?? edge.to);
    if (!source || !target) {
      return [];
    }
    const mappedSource = idMap.get(source) ?? prefixed(prefix, source);
    const mappedTarget = idMap.get(target) ?? prefixed(prefix, target);
    if (!nodeIds.has(mappedSource) || !nodeIds.has(mappedTarget)) {
      return [];
    }
    const evidenceClass = mapEvidenceClass(edge.evidenceClass ?? edge.evidence_class ?? edge.status ?? edge.confidence);
    return [
      {
        id: prefixed(prefix, stringField(edge, "id", "key") ?? `edge-${index + 1}`),
        source: mappedSource,
        target: mappedTarget,
        relation: stringField(edge, "relation", "type", "label") ?? "related_to",
        status: evidenceClass === "extracted" ? "extracted" : "inferred",
        evidenceClass,
        confidence: numberField(edge, "confidence", numberField(edge, "confidence_score", evidenceClass === "ambiguous" ? 0.5 : 0.75)),
        provenance: [syntheticSourceId]
      }
    ];
  });
  const page: GraphPage = {
    id: prefixed(prefix, "page"),
    path: toPosix(path.posix.join("merged", prefix, "index.md")),
    title: `${prefix} merged graph`,
    kind: "source",
    sourceClass: "generated",
    sourceIds: [syntheticSourceId],
    projectIds: [],
    nodeIds: nodes.map((node) => node.id),
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "merged-node-link",
    sourceHashes: { [syntheticSourceId]: source.contentHash },
    sourceSemanticHashes: { [syntheticSourceId]: source.semanticHash },
    relatedPageIds: [],
    relatedNodeIds: nodes.map((node) => node.id),
    relatedSourceIds: [syntheticSourceId],
    createdAt: now,
    updatedAt: now,
    compiledFrom: [inputPath],
    managedBy: "system"
  };
  return {
    generatedAt: now,
    nodes,
    edges,
    hyperedges: [],
    communities: [],
    sources: [source],
    pages: [page]
  };
}

function mergeGraphs(graphs: GraphArtifact[], now: string): GraphArtifact {
  return {
    generatedAt: now,
    nodes: uniqueBy(
      graphs.flatMap((graph) => graph.nodes),
      (node) => node.id
    ),
    edges: uniqueBy(
      graphs.flatMap((graph) => graph.edges),
      (edge) => edge.id
    ),
    hyperedges: uniqueBy(
      graphs.flatMap((graph) => graph.hyperedges),
      (hyperedge) => hyperedge.id
    ),
    communities: uniqueBy(
      graphs.flatMap((graph) => graph.communities ?? []),
      (community) => community.id
    ),
    sources: uniqueBy(
      graphs.flatMap((graph) => graph.sources),
      (source) => source.sourceId
    ),
    pages: uniqueBy(
      graphs.flatMap((graph) => graph.pages),
      (page) => page.id
    )
  };
}

export async function mergeGraphFiles(
  inputPaths: string[],
  outputPath: string,
  options: GraphMergeOptions = {}
): Promise<GraphMergeResult> {
  if (inputPaths.length === 0) {
    throw new Error("At least one graph JSON path is required.");
  }
  const now = new Date().toISOString();
  const usedPrefixes = new Set<string>();
  const graphs: GraphArtifact[] = [];
  const inputGraphs: GraphMergeInputSummary[] = [];
  const warnings: string[] = [];

  for (const [index, inputPath] of inputPaths.entries()) {
    const resolvedInputPath = path.resolve(inputPath);
    const raw = JSON.parse(await fs.readFile(resolvedInputPath, "utf8")) as unknown;
    const prefix = ensureUniquePrefix(
      inputPaths.length === 1 && options.label ? slugify(options.label) : safePrefix(resolvedInputPath, index),
      usedPrefixes
    );
    if (isSwarmVaultGraph(raw)) {
      const graph = remapSwarmVaultGraph(resolvedInputPath, raw, prefix);
      graphs.push(graph);
      inputGraphs.push({
        path: resolvedInputPath,
        label: prefix,
        format: "swarmvault",
        nodeCount: raw.nodes.length,
        edgeCount: raw.edges.length
      });
      continue;
    }
    if (isRecord(raw) && nodeLinkArrays(raw)) {
      const graph = remapNodeLinkGraph(resolvedInputPath, raw, prefix, now);
      graphs.push(graph);
      inputGraphs.push({
        path: resolvedInputPath,
        label: prefix,
        format: "node-link",
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length
      });
      continue;
    }
    warnings.push(`${resolvedInputPath} was skipped because it is not a supported graph JSON shape.`);
  }

  if (graphs.length === 0) {
    throw new Error("No supported graph inputs were found.");
  }
  const graph = mergeGraphs(graphs, now);
  const resolvedOutputPath = path.resolve(outputPath);
  await ensureDir(path.dirname(resolvedOutputPath));
  await fs.writeFile(resolvedOutputPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return {
    outputPath: resolvedOutputPath,
    graph,
    inputGraphs,
    warnings
  };
}
