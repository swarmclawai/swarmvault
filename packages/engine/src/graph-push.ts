import fs from "node:fs/promises";
import path from "node:path";
import neo4j from "neo4j-driver";
import { graphHash } from "./benchmark.js";
import { loadVaultConfig } from "./config.js";
import {
  filterGraphBySourceClasses,
  graphCounts,
  graphPageById,
  normalizeEdgeProps,
  normalizeGroupMemberProps,
  normalizeHyperedgeNodeProps,
  normalizeSwarmNodeProps,
  relationType
} from "./graph-interchange.js";
import type { GraphArtifact, GraphPushNeo4jOptions, GraphPushResult, SourceClass } from "./types.js";
import { sha256, slugify } from "./utils.js";

const DEFAULT_NEO4J_BATCH_SIZE = 500;
const DEFAULT_NEO4J_DATABASE = "neo4j";

type ResolvedNeo4jPushConfig = {
  uri: string;
  username: string;
  passwordEnv: string;
  database: string;
  vaultId: string;
  includeClasses: SourceClass[];
  batchSize: number;
};

type PushDriverLike = {
  session(options: { database: string }): {
    run(query: string, params?: Record<string, unknown>): Promise<unknown>;
    executeWrite<T>(work: (tx: { run(query: string, params?: Record<string, unknown>): Promise<unknown> }) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  };
  close(): Promise<void>;
};

type GraphPushInternalOptions = GraphPushNeo4jOptions & {
  driverFactory?: (uri: string, username: string, password: string) => PushDriverLike;
};

function requireConfigValue(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Neo4j push requires ${name}. Configure \`graphSinks.neo4j.${name}\` or pass the matching CLI flag.`);
}

async function deriveVaultId(rootDir: string): Promise<string> {
  const realRoot = await fs.realpath(rootDir).catch(() => path.resolve(rootDir));
  const label = slugify(path.basename(realRoot));
  return `${label}-${sha256(realRoot).slice(0, 12)}`;
}

async function resolveNeo4jPushConfig(rootDir: string, options: GraphPushNeo4jOptions): Promise<ResolvedNeo4jPushConfig> {
  const { config } = await loadVaultConfig(rootDir);
  const sink = config.graphSinks?.neo4j;
  const includeClasses = normalizeIncludedClasses(options.includeClasses ?? sink?.includeClasses ?? ["first_party"]);
  return {
    uri: requireConfigValue(options.uri ?? sink?.uri, "uri"),
    username: requireConfigValue(options.username ?? sink?.username, "username"),
    passwordEnv: requireConfigValue(options.passwordEnv ?? sink?.passwordEnv, "passwordEnv"),
    database: options.database?.trim() || sink?.database?.trim() || DEFAULT_NEO4J_DATABASE,
    vaultId: options.vaultId?.trim() || sink?.vaultId?.trim() || (await deriveVaultId(rootDir)),
    includeClasses,
    batchSize: normalizeBatchSize(options.batchSize ?? sink?.batchSize)
  };
}

function normalizeIncludedClasses(values: SourceClass[]): SourceClass[] {
  const allowed = ["first_party", "third_party", "resource", "generated"] satisfies SourceClass[];
  const unique = [...new Set(values)].filter((value): value is SourceClass => allowed.includes(value as SourceClass));
  return unique.length ? unique : ["first_party"];
}

function normalizeBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return DEFAULT_NEO4J_BATCH_SIZE;
  }
  return Math.max(1, Math.floor(value));
}

async function loadGraph(rootDir: string): Promise<GraphArtifact> {
  const { paths } = await loadVaultConfig(rootDir);
  const raw = JSON.parse(await fs.readFile(paths.graphPath, "utf8")) as GraphArtifact;
  return raw;
}

function buildResult(input: {
  resolved: ResolvedNeo4jPushConfig;
  filteredGraph: GraphArtifact;
  fullGraph: GraphArtifact;
  dryRun: boolean;
  warnings?: string[];
}): GraphPushResult {
  const counts = graphCounts(input.filteredGraph);
  const fullCounts = graphCounts(input.fullGraph);
  return {
    sink: "neo4j",
    uri: input.resolved.uri,
    database: input.resolved.database,
    vaultId: input.resolved.vaultId,
    dryRun: input.dryRun,
    graphHash: graphHash(input.fullGraph),
    includedSourceClasses: input.resolved.includeClasses,
    counts,
    skipped: {
      sources: Math.max(0, fullCounts.sources - counts.sources),
      pages: Math.max(0, fullCounts.pages - counts.pages),
      nodes: Math.max(0, fullCounts.nodes - counts.nodes),
      relationships: Math.max(0, fullCounts.relationships - counts.relationships),
      hyperedges: Math.max(0, fullCounts.hyperedges - counts.hyperedges),
      groupMembers: Math.max(0, fullCounts.groupMembers - counts.groupMembers)
    },
    warnings: input.warnings ?? []
  };
}

function createDriver(uri: string, username: string, password: string): PushDriverLike {
  return neo4j.driver(uri, neo4j.auth.basic(username, password));
}

async function ensureNeo4jConstraints(session: ReturnType<PushDriverLike["session"]>): Promise<void> {
  await session.run("CREATE CONSTRAINT swarmvault_node_identity IF NOT EXISTS FOR (n:SwarmNode) REQUIRE (n.vaultId, n.id) IS UNIQUE");
  await session.run("CREATE CONSTRAINT swarmvault_sync_identity IF NOT EXISTS FOR (s:SwarmVaultSync) REQUIRE s.vaultId IS UNIQUE");
}

function chunkRows<T>(rows: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    chunks.push(rows.slice(index, index + batchSize));
  }
  return chunks;
}

async function writeNodeRows(
  session: ReturnType<PushDriverLike["session"]>,
  vaultId: string,
  rows: Array<{ id: string; props: Record<string, boolean | number | string> }>,
  batchSize: number
): Promise<void> {
  for (const chunk of chunkRows(rows, batchSize)) {
    await session.executeWrite((tx) =>
      tx.run(["UNWIND $rows AS row", "MERGE (n:SwarmNode { vaultId: $vaultId, id: row.id })", "SET n += row.props"].join("\n"), {
        vaultId,
        rows: chunk
      })
    );
  }
}

async function writeEdgeRows(
  session: ReturnType<PushDriverLike["session"]>,
  vaultId: string,
  rows: Array<{ id: string; source: string; target: string; props: Record<string, boolean | number | string> }>,
  batchSize: number,
  relation: string
): Promise<void> {
  const neoRelation = relationType(relation);
  const query = [
    "UNWIND $rows AS row",
    "MATCH (a:SwarmNode { vaultId: $vaultId, id: row.source })",
    "MATCH (b:SwarmNode { vaultId: $vaultId, id: row.target })",
    `MERGE (a)-[r:${neoRelation} { vaultId: $vaultId, id: row.id }]->(b)`,
    "SET r += row.props"
  ].join("\n");
  for (const chunk of chunkRows(rows, batchSize)) {
    await session.executeWrite((tx) => tx.run(query, { vaultId, rows: chunk }));
  }
}

async function writeSyncNode(
  session: ReturnType<PushDriverLike["session"]>,
  input: {
    vaultId: string;
    rootDir: string;
    graph: GraphArtifact;
    pushedAt: string;
    includedSourceClasses: SourceClass[];
    counts: GraphPushResult["counts"];
  }
): Promise<void> {
  await session.executeWrite((tx) =>
    tx.run(
      [
        "MERGE (s:SwarmVaultSync { vaultId: $vaultId })",
        "SET s += {",
        "  vaultId: $vaultId,",
        "  rootDir: $rootDir,",
        "  graphGeneratedAt: $graphGeneratedAt,",
        "  graphHash: $graphHash,",
        "  pushedAt: $pushedAt,",
        "  includedSourceClasses: $includedSourceClasses,",
        "  sources: $sources,",
        "  pages: $pages,",
        "  nodes: $nodes,",
        "  relationships: $relationships,",
        "  hyperedges: $hyperedges,",
        "  groupMembers: $groupMembers",
        "}"
      ].join("\n"),
      {
        vaultId: input.vaultId,
        rootDir: path.resolve(input.rootDir),
        graphGeneratedAt: input.graph.generatedAt,
        graphHash: graphHash(input.graph),
        pushedAt: input.pushedAt,
        includedSourceClasses: input.includedSourceClasses,
        ...input.counts
      }
    )
  );
}

export async function pushGraphNeo4j(rootDir: string, options: GraphPushInternalOptions = {}): Promise<GraphPushResult> {
  const graph = await loadGraph(rootDir);
  const resolved = await resolveNeo4jPushConfig(rootDir, options);
  const filteredGraph = filterGraphBySourceClasses(graph, resolved.includeClasses);
  const warnings =
    filteredGraph.nodes.length || filteredGraph.hyperedges.length || filteredGraph.edges.length
      ? []
      : [`No graph records matched the included source classes: ${resolved.includeClasses.join(", ")}`];
  const result = buildResult({
    resolved,
    filteredGraph,
    fullGraph: graph,
    dryRun: options.dryRun ?? false,
    warnings
  });

  if (options.dryRun) {
    return result;
  }

  const password = process.env[resolved.passwordEnv];
  if (!password) {
    throw new Error(`Environment variable ${resolved.passwordEnv} is required for Neo4j push.`);
  }

  const driver = (options.driverFactory ?? createDriver)(resolved.uri, resolved.username, password);
  const session = driver.session({ database: resolved.database });
  try {
    await ensureNeo4jConstraints(session);

    const pageById = graphPageById(filteredGraph);
    const nodeRows = [
      ...filteredGraph.nodes
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((node) => ({
          id: node.id,
          props: normalizeSwarmNodeProps(node, node.pageId ? pageById.get(node.pageId) : undefined)
        })),
      ...filteredGraph.hyperedges
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((hyperedge) => ({
          id: normalizeHyperedgeNodeProps(hyperedge).id as string,
          props: normalizeHyperedgeNodeProps(hyperedge)
        }))
    ];
    await writeNodeRows(session, resolved.vaultId, nodeRows, resolved.batchSize);

    const edgeGroups = new Map<
      string,
      Array<{ id: string; source: string; target: string; props: Record<string, boolean | number | string> }>
    >();
    for (const edge of [...filteredGraph.edges].sort((left, right) => left.id.localeCompare(right.id))) {
      const rows = edgeGroups.get(edge.relation) ?? [];
      rows.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        props: normalizeEdgeProps(edge)
      });
      edgeGroups.set(edge.relation, rows);
    }
    for (const [relation, rows] of [...edgeGroups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      await writeEdgeRows(session, resolved.vaultId, rows, resolved.batchSize, relation);
    }

    const memberRows = filteredGraph.hyperedges.flatMap((hyperedge) =>
      hyperedge.nodeIds.map((nodeId) => ({
        id: `member:${hyperedge.id}:${nodeId}`,
        source: normalizeHyperedgeNodeProps(hyperedge).id as string,
        target: nodeId,
        props: normalizeGroupMemberProps(hyperedge, nodeId)
      }))
    );
    if (memberRows.length) {
      await writeEdgeRows(session, resolved.vaultId, memberRows, resolved.batchSize, "group_member");
    }

    await writeSyncNode(session, {
      vaultId: resolved.vaultId,
      rootDir,
      graph,
      pushedAt: new Date().toISOString(),
      includedSourceClasses: resolved.includeClasses,
      counts: result.counts
    });
    return result;
  } finally {
    await session.close();
    await driver.close();
  }
}
