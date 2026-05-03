import fs from "node:fs/promises";
import path from "node:path";
import { loadVaultConfig } from "./config.js";
import { listManifests } from "./ingest.js";
import { listMemoryTasks } from "./memory.js";
import { planMigration } from "./migrate.js";
import { doctorRetrieval } from "./retrieval.js";
import type {
  GraphArtifact,
  ManagedSourcesArtifact,
  VaultDoctorCheck,
  VaultDoctorRecommendation,
  VaultDoctorReport,
  VaultDoctorStatus
} from "./types.js";
import { fileExists, readJsonFile } from "./utils.js";
import { listApprovals, listCandidates } from "./vault.js";
import { getWatchStatus } from "./watch.js";

export interface DoctorVaultOptions {
  repair?: boolean;
}

function worstStatus(checks: VaultDoctorCheck[]): VaultDoctorStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function recommendationPriority(status: VaultDoctorStatus): VaultDoctorRecommendation["priority"] {
  if (status === "error") return "high";
  if (status === "warning") return "medium";
  return "low";
}

function safeActionFor(checkId: string, command: string): VaultDoctorRecommendation["safeAction"] | undefined {
  if (checkId === "retrieval" && command === "swarmvault retrieval doctor --repair") {
    return "doctor:repair";
  }
  return undefined;
}

function buildRecommendations(checks: VaultDoctorCheck[]): VaultDoctorRecommendation[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return checks
    .filter((check) => check.status !== "ok")
    .flatMap((check) =>
      (check.actions ?? []).map((action) => ({
        id: `${check.id}:${action.command}`,
        label: `Fix ${check.label}`,
        summary: check.summary,
        priority: recommendationPriority(check.status),
        status: check.status,
        sourceCheckId: check.id,
        command: action.command,
        description: action.description,
        safeAction: safeActionFor(check.id, action.command)
      }))
    )
    .sort((left, right) => rank[left.priority] - rank[right.priority] || left.label.localeCompare(right.label));
}

async function currentPackageVersion(): Promise<string> {
  try {
    const raw = await fs.readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function doctorVault(rootDir: string, options: DoctorVaultOptions = {}): Promise<VaultDoctorReport> {
  const generatedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const version = await currentPackageVersion();
  const repaired: string[] = [];
  const checks: VaultDoctorCheck[] = [];

  const [
    configExists,
    schemaExists,
    graph,
    manifests,
    managedSourcesArtifact,
    approvals,
    candidates,
    tasks,
    watchStatus,
    migrationPlan,
    retrievalDoctor
  ] = await Promise.all([
    fileExists(paths.configPath),
    fileExists(paths.schemaPath),
    readJsonFile<GraphArtifact>(paths.graphPath).catch(() => null),
    listManifests(rootDir).catch(() => []),
    readJsonFile<ManagedSourcesArtifact>(paths.managedSourcesPath).catch(() => null),
    listApprovals(rootDir).catch(() => []),
    listCandidates(rootDir).catch(() => []),
    listMemoryTasks(rootDir).catch(() => []),
    getWatchStatus(rootDir).catch(() => ({ generatedAt: "", watchedRepoRoots: [], pendingSemanticRefresh: [] })),
    planMigration(rootDir).catch(() => ({ fromVersion: null, toVersion: version, steps: [] })),
    doctorRetrieval(rootDir, { repair: options.repair }).catch((error: unknown) => ({
      ok: false,
      repaired: false,
      actions: ["rebuild"],
      status: {
        configured: { backend: "sqlite", shardSize: 25000, hybrid: true, rerank: false },
        manifestPath: paths.retrievalManifestPath,
        indexPath: paths.searchDbPath,
        manifestExists: false,
        indexExists: false,
        graphExists: false,
        stale: true,
        pageCount: 0,
        shardCount: 0,
        warnings: [error instanceof Error ? error.message : String(error)]
      }
    }))
  ]);

  if (retrievalDoctor.repaired) {
    repaired.push("retrieval");
  }

  checks.push({
    id: "workspace",
    label: "Workspace",
    status: configExists && schemaExists ? "ok" : "error",
    summary: configExists && schemaExists ? "Workspace config and schema are present." : "Workspace config or schema is missing.",
    detail: [configExists ? null : "Missing swarmvault.config.json.", schemaExists ? null : "Missing swarmvault.schema.md."]
      .filter((value): value is string => Boolean(value))
      .join(" "),
    actions:
      configExists && schemaExists
        ? []
        : [
            {
              command: "swarmvault init",
              description: "Initialize the missing workspace files."
            }
          ]
  });

  checks.push({
    id: "graph",
    label: "Graph",
    status: graph ? "ok" : "error",
    summary: graph
      ? `Graph is present with ${graph.nodes.length} nodes, ${graph.edges.length} edges, and ${graph.pages.length} pages.`
      : "Graph artifact is missing.",
    actions: graph
      ? []
      : [
          {
            command: "swarmvault compile",
            description: "Compile sources into graph and wiki artifacts."
          }
        ]
  });

  checks.push({
    id: "retrieval",
    label: "Retrieval",
    status: retrievalDoctor.ok ? "ok" : "warning",
    summary: retrievalDoctor.ok
      ? `Retrieval index is fresh with ${retrievalDoctor.status.pageCount} indexed pages.`
      : "Retrieval index needs attention.",
    detail: retrievalDoctor.status.warnings.join(" "),
    actions: retrievalDoctor.ok
      ? []
      : [
          {
            command: "swarmvault retrieval doctor --repair",
            description: "Rebuild stale or missing retrieval artifacts."
          }
        ]
  });

  const pendingApprovals = approvals.reduce((total, approval) => total + approval.pendingCount, 0);
  const managedSources = managedSourcesArtifact?.sources ?? [];
  const managedSourcesNeedingAttention = managedSources.filter((source) => source.status !== "ready" || source.lastSyncStatus === "error");

  checks.push({
    id: "managed_sources",
    label: "Managed Sources",
    status: managedSourcesNeedingAttention.length ? "warning" : "ok",
    summary: managedSources.length
      ? `${managedSources.length} managed source${managedSources.length === 1 ? "" : "s"} registered.`
      : "No managed sources registered.",
    detail: managedSourcesNeedingAttention.map((source) => `${source.id}: ${source.lastError ?? source.status}`).join(" "),
    actions: managedSourcesNeedingAttention.length
      ? [
          {
            command: "swarmvault source list",
            description: "Inspect managed source status."
          },
          {
            command: "swarmvault source reload --all",
            description: "Refresh registered managed sources."
          }
        ]
      : []
  });

  checks.push({
    id: "review",
    label: "Review Queues",
    status: pendingApprovals || candidates.length ? "warning" : "ok",
    summary:
      pendingApprovals || candidates.length
        ? `${pendingApprovals} pending approval entr${pendingApprovals === 1 ? "y" : "ies"} and ${candidates.length} candidate page${candidates.length === 1 ? "" : "s"} need review.`
        : "No pending approval entries or candidate pages.",
    actions:
      pendingApprovals || candidates.length
        ? [
            {
              command: "swarmvault review list",
              description: "Inspect staged approval bundles."
            },
            {
              command: "swarmvault candidate list",
              description: "Inspect candidate concept and entity pages."
            }
          ]
        : []
  });

  checks.push({
    id: "watch",
    label: "Watch",
    status: watchStatus.pendingSemanticRefresh.length ? "warning" : "ok",
    summary: watchStatus.pendingSemanticRefresh.length
      ? `${watchStatus.pendingSemanticRefresh.length} repo change${watchStatus.pendingSemanticRefresh.length === 1 ? "" : "s"} await semantic refresh.`
      : "No pending semantic refresh entries.",
    actions: watchStatus.pendingSemanticRefresh.length
      ? [
          {
            command: "swarmvault watch --repo --once",
            description: "Refresh pending repo changes."
          }
        ]
      : []
  });

  const migrationNeedsAttention = Boolean(migrationPlan.fromVersion && migrationPlan.steps.length);
  checks.push({
    id: "migration",
    label: "Migration",
    status: migrationNeedsAttention ? "warning" : "ok",
    summary: migrationNeedsAttention
      ? `${migrationPlan.steps.length} migration step${migrationPlan.steps.length === 1 ? "" : "s"} would run before ${migrationPlan.toVersion}.`
      : migrationPlan.fromVersion
        ? `Vault is current for ${migrationPlan.toVersion}.`
        : "No vault version record was found; current generated artifacts do not require an automatic migration warning.",
    actions: migrationNeedsAttention
      ? [
          {
            command: "swarmvault migrate --dry-run",
            description: "Preview migration changes before applying."
          }
        ]
      : []
  });

  const status = worstStatus(checks);
  const recommendations = buildRecommendations(checks);
  return {
    ok: status === "ok",
    status,
    generatedAt,
    rootDir: path.resolve(rootDir),
    version,
    counts: {
      sources: manifests.length,
      managedSources: managedSources.length,
      pages: graph?.pages.length ?? 0,
      nodes: graph?.nodes.length ?? 0,
      edges: graph?.edges.length ?? 0,
      approvalsPending: pendingApprovals,
      candidates: candidates.length,
      tasks: tasks.length,
      pendingSemanticRefresh: watchStatus.pendingSemanticRefresh.length
    },
    checks,
    recommendations,
    repaired
  };
}
