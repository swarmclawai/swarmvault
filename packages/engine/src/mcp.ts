import fs from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadVaultConfig } from "./config.js";
import { buildContextPack, listContextPacks, readContextPack } from "./context-packs.js";
import { doctorVault } from "./doctor.js";
import { ingestInputDetailed, listManifests } from "./ingest.js";
import { finishMemoryTask, listMemoryTasks, readMemoryTask, resumeMemoryTask, startMemoryTask, updateMemoryTask } from "./memory.js";
import { runMigration } from "./migrate.js";
import { doctorRetrieval, getRetrievalStatus, rebuildRetrievalIndex } from "./retrieval.js";
import { loadVaultSchema } from "./schema.js";
import type { GraphArtifact } from "./types.js";
import { fileExists, isPathWithin, listFilesRecursive, readJsonFile, toPosix } from "./utils.js";
import {
  acceptApproval,
  archiveCandidate,
  blastRadiusVault,
  compileVault,
  consolidateVault,
  explainGraphVault,
  getGraphCommunityVault,
  getWorkspaceInfo,
  graphStatsVault,
  lintVault,
  listApprovals,
  listGodNodes,
  listGraphHyperedges,
  listPages,
  pathGraphVault,
  previewCandidatePromotions,
  promoteCandidate,
  queryGraphVault,
  queryVault,
  readApproval,
  readGraphReport,
  readPage,
  refreshGraphClusters,
  rejectApproval,
  runAutoPromotion,
  searchVault
} from "./vault.js";
import { getWatchStatus } from "./watch.js";

const SERVER_VERSION = "3.10.0";
const codeLanguageSchema = z.enum([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "bash",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "scala",
  "dart",
  "lua",
  "zig",
  "csharp",
  "c",
  "cpp",
  "php",
  "ruby",
  "powershell",
  "swift",
  "elixir",
  "ocaml",
  "objc",
  "rescript",
  "solidity",
  "html",
  "css",
  "vue",
  "svelte",
  "julia",
  "verilog",
  "systemverilog",
  "r",
  "sql"
]);

export async function createMcpServer(rootDir: string): Promise<McpServer> {
  const server = new McpServer({
    name: "swarmvault",
    version: SERVER_VERSION,
    websiteUrl: "https://www.swarmvault.ai"
  });

  server.registerTool(
    "workspace_info",
    {
      description: "Return the current SwarmVault workspace paths and high-level counts."
    },
    safeHandler(async () => {
      const info = await getWorkspaceInfo(rootDir);
      return asToolText(info);
    })
  );

  server.registerTool(
    "search_pages",
    {
      description: "Search compiled wiki pages using the local full-text index.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(25).optional().describe("Maximum number of results")
      }
    },
    safeHandler(async ({ query, limit }) => {
      const results = await searchVault(rootDir, query, limit ?? 5);
      return asToolText(results);
    })
  );

  server.registerTool(
    "retrieval_status",
    {
      description: "Read SwarmVault retrieval index health and configuration."
    },
    safeHandler(async () => {
      return asToolText(await getRetrievalStatus(rootDir));
    })
  );

  server.registerTool(
    "rebuild_retrieval",
    {
      description: "Rebuild the local retrieval index from the current graph."
    },
    safeHandler(async () => {
      return asToolText(await rebuildRetrievalIndex(rootDir));
    })
  );

  server.registerTool(
    "doctor_retrieval",
    {
      description: "Diagnose retrieval index problems and optionally repair them.",
      inputSchema: {
        repair: z.boolean().optional().describe("Rebuild stale or missing retrieval artifacts")
      }
    },
    safeHandler(async ({ repair }) => {
      return asToolText(await doctorRetrieval(rootDir, { repair }));
    })
  );

  server.registerTool(
    "doctor_vault",
    {
      description: "Diagnose vault health across graph, retrieval, review queues, watch state, and migrations.",
      inputSchema: {
        repair: z.boolean().optional().describe("Run safe repairs such as rebuilding stale retrieval artifacts")
      }
    },
    safeHandler(async ({ repair }) => {
      return asToolText(await doctorVault(rootDir, { repair }));
    })
  );

  server.registerTool(
    "read_page",
    {
      description: "Read a generated wiki page by its path relative to wiki/.",
      inputSchema: {
        path: z.string().min(1).describe("Path relative to wiki/, for example sources/example.md")
      }
    },
    safeHandler(async ({ path: relativePath }) => {
      const page = await readPage(rootDir, relativePath);
      if (!page) {
        return asToolError(`Page not found: ${relativePath}`);
      }

      return asToolText(page);
    })
  );

  server.registerTool(
    "list_sources",
    {
      description: "List source manifests in the current workspace.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum number of manifests to return")
      }
    },
    safeHandler(async ({ limit }) => {
      const manifests = await listManifests(rootDir);
      return asToolText(limit ? manifests.slice(0, limit) : manifests);
    })
  );

  server.registerTool(
    "query_graph",
    {
      description: "Traverse the local graph from search seeds without calling a model provider.",
      inputSchema: {
        question: z.string().min(1).describe("Question or graph search seed"),
        traversal: z.enum(["bfs", "dfs"]).optional().describe("Traversal strategy"),
        budget: z.number().int().min(3).max(50).optional().describe("Maximum nodes to summarize"),
        relations: z.array(z.string().min(1)).optional().describe("Only traverse edges with these relation names"),
        context: z
          .array(z.enum(["calls", "imports", "types", "data", "rationale", "evidence"]))
          .optional()
          .describe("Relation group filters for common code/evidence contexts"),
        evidenceClasses: z
          .array(z.enum(["extracted", "inferred", "ambiguous"]))
          .optional()
          .describe("Only traverse these evidence classes"),
        nodeTypes: z
          .array(z.enum(["source", "concept", "entity", "module", "symbol", "rationale", "memory_task", "decision"]))
          .optional()
          .describe("Prefer traversal around these graph node types"),
        languages: z.array(codeLanguageSchema).optional().describe("Prefer traversal around nodes with these code languages")
      }
    },
    safeHandler(async ({ question, traversal, budget, relations, context, evidenceClasses, nodeTypes, languages }) => {
      const result = await queryGraphVault(rootDir, question, {
        traversal,
        budget,
        filters: {
          relations,
          relationGroups: context,
          evidenceClasses,
          nodeTypes,
          languages
        }
      });
      return asToolText(result);
    })
  );

  server.registerTool(
    "graph_report",
    {
      description: "Return the machine-readable graph report and trust artifact."
    },
    safeHandler(async () => {
      return asToolText((await readGraphReport(rootDir)) ?? { error: "Graph report not found. Run `swarmvault compile` first." });
    })
  );

  server.registerTool(
    "graph_stats",
    {
      description: "Return lightweight counts for graph nodes, evidence classes, source classes, communities, pages, and edges."
    },
    safeHandler(async () => {
      return asToolText(await graphStatsVault(rootDir));
    })
  );

  server.registerTool(
    "cluster_graph",
    {
      description:
        "Recompute graph communities, node degrees, god-node flags, and graph report artifacts from the existing compiled graph.",
      inputSchema: {
        resolution: z.number().positive().optional().describe("Optional Louvain community resolution override")
      }
    },
    safeHandler(async ({ resolution }) => {
      return asToolText(await refreshGraphClusters(rootDir, { resolution }));
    })
  );

  server.registerTool(
    "get_node",
    {
      description: "Explain a graph node, its page, community, neighbors, and group patterns.",
      inputSchema: {
        target: z.string().min(1).describe("Node or page label/id")
      }
    },
    safeHandler(async ({ target }) => {
      return asToolText(await explainGraphVault(rootDir, target));
    })
  );

  server.registerTool(
    "get_community",
    {
      description: "Return members, pages, and top evidence edges for a graph community by id or label.",
      inputSchema: {
        target: z.string().min(1).describe("Community id or label"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum evidence edges to return")
      }
    },
    safeHandler(async ({ target, limit }) => {
      return asToolText(await getGraphCommunityVault(rootDir, target, limit ?? 25));
    })
  );

  server.registerTool(
    "get_hyperedges",
    {
      description: "List graph hyperedges, optionally filtered to a node or page target.",
      inputSchema: {
        target: z.string().optional().describe("Optional node/page label or id to filter by"),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum hyperedges to return")
      }
    },
    safeHandler(async ({ target, limit }) => {
      return asToolText(await listGraphHyperedges(rootDir, target, limit ?? 25));
    })
  );

  server.registerTool(
    "get_neighbors",
    {
      description: "Return the neighbors of a graph node or page target.",
      inputSchema: {
        target: z.string().min(1).describe("Node or page label/id")
      }
    },
    safeHandler(async ({ target }) => {
      const explanation = await explainGraphVault(rootDir, target);
      return asToolText(explanation.neighbors);
    })
  );

  server.registerTool(
    "shortest_path",
    {
      description: "Find the shortest graph path between two targets.",
      inputSchema: {
        from: z.string().min(1).describe("Start node/page label or id"),
        to: z.string().min(1).describe("End node/page label or id")
      }
    },
    safeHandler(async ({ from, to }) => {
      return asToolText(await pathGraphVault(rootDir, from, to));
    })
  );

  server.registerTool(
    "god_nodes",
    {
      description: "List the highest-connectivity graph nodes.",
      inputSchema: {
        limit: z.number().int().min(1).max(25).optional().describe("Maximum nodes to return")
      }
    },
    safeHandler(async ({ limit }) => {
      return asToolText(await listGodNodes(rootDir, limit ?? 10));
    })
  );

  server.registerTool(
    "blast_radius",
    {
      description: "Analyze the impact of changing a file or module by tracing reverse import edges.",
      inputSchema: {
        target: z.string().min(1).describe("File path, module label, or module id"),
        maxDepth: z.number().int().min(1).max(10).optional().describe("Maximum traversal depth (default 3)")
      }
    },
    safeHandler(async ({ target, maxDepth }) => {
      return asToolText(await blastRadiusVault(rootDir, target, { maxDepth: maxDepth ?? 3 }));
    })
  );

  server.registerTool(
    "query_vault",
    {
      description: "Ask a question against the compiled vault and optionally save the answer.",
      inputSchema: {
        question: z.string().min(1).describe("Question to ask the vault"),
        save: z.boolean().optional().describe("Persist the answer to wiki/outputs"),
        format: z.enum(["markdown", "report", "slides", "chart", "image"]).optional().describe("Output format")
      }
    },
    safeHandler(async ({ question, save, format }) => {
      const result = await queryVault(rootDir, {
        question,
        save: save ?? true,
        format
      });
      return asToolText(result);
    })
  );

  server.registerTool(
    "build_context_pack",
    {
      description: "Build a cited, token-bounded context pack for an agent task.",
      inputSchema: {
        goal: z.string().min(1).describe("Task, question, or goal the agent needs context for"),
        target: z.string().optional().describe("Optional page, node, path, project, or label to anchor the pack"),
        budgetTokens: z.number().int().min(200).optional().describe("Approximate token budget for included context"),
        format: z.enum(["markdown", "json", "llms"]).optional().describe("Preferred rendered output format")
      }
    },
    safeHandler(async ({ goal, target, budgetTokens, format }) => {
      const result = await buildContextPack(rootDir, { goal, target, budgetTokens, format });
      return asToolText(result);
    })
  );

  server.registerTool(
    "list_context_packs",
    {
      description: "List saved SwarmVault context packs."
    },
    safeHandler(async () => {
      return asToolText(await listContextPacks(rootDir));
    })
  );

  server.registerTool(
    "read_context_pack",
    {
      description: "Read a saved SwarmVault context pack by id.",
      inputSchema: {
        id: z.string().min(1).describe("Context pack id")
      }
    },
    safeHandler(async ({ id }) => {
      const pack = await readContextPack(rootDir, id);
      if (!pack) {
        return asToolError(`Context pack not found: ${id}`);
      }
      return asToolText(pack);
    })
  );

  server.registerTool(
    "start_memory_task",
    {
      description: "Start a durable SwarmVault agent memory task and build its initial context pack.",
      inputSchema: {
        goal: z.string().min(1).describe("Task goal to preserve in agent memory"),
        target: z.string().optional().describe("Optional page, node, path, project, or label to anchor the initial context pack"),
        budgetTokens: z.number().int().min(200).optional().describe("Approximate token budget for the initial context pack"),
        agent: z.string().optional().describe("Agent name to record on the task"),
        contextPackId: z.string().optional().describe("Existing context pack id to attach instead of building a new one")
      }
    },
    safeHandler(async ({ goal, target, budgetTokens, agent, contextPackId }) => {
      return asToolText(await startMemoryTask(rootDir, { goal, target, budgetTokens, agent, contextPackId }));
    })
  );

  server.registerTool(
    "update_memory_task",
    {
      description: "Append a note, decision, path, context pack, or status change to a SwarmVault memory task.",
      inputSchema: {
        id: z.string().min(1).describe("Memory task id"),
        note: z.string().optional().describe("Task note to append"),
        decision: z.string().optional().describe("Decision to append"),
        changedPath: z.string().optional().describe("Changed file or wiki path to attach"),
        contextPackId: z.string().optional().describe("Context pack id to attach"),
        sessionId: z.string().optional().describe("Session id to attach"),
        sourceId: z.string().optional().describe("Source id to attach"),
        pageId: z.string().optional().describe("Page id to attach"),
        nodeId: z.string().optional().describe("Graph node id to attach"),
        gitRef: z.string().optional().describe("Git ref to attach"),
        status: z.enum(["active", "blocked", "completed", "archived"]).optional().describe("Task status")
      }
    },
    safeHandler(async ({ id, ...options }) => {
      return asToolText(await updateMemoryTask(rootDir, id, options));
    })
  );

  server.registerTool(
    "finish_memory_task",
    {
      description: "Finish a SwarmVault memory task with an outcome and optional follow-up.",
      inputSchema: {
        id: z.string().min(1).describe("Memory task id"),
        outcome: z.string().min(1).describe("Outcome to record"),
        followUp: z.string().optional().describe("Follow-up to preserve for the next agent")
      }
    },
    safeHandler(async ({ id, outcome, followUp }) => {
      return asToolText(await finishMemoryTask(rootDir, id, { outcome, followUp }));
    })
  );

  server.registerTool(
    "list_memory_tasks",
    {
      description: "List saved SwarmVault agent memory tasks."
    },
    safeHandler(async () => {
      return asToolText(await listMemoryTasks(rootDir));
    })
  );

  server.registerTool(
    "read_memory_task",
    {
      description: "Read a saved SwarmVault agent memory task by id.",
      inputSchema: {
        id: z.string().min(1).describe("Memory task id")
      }
    },
    safeHandler(async ({ id }) => {
      const task = await readMemoryTask(rootDir, id);
      if (!task) {
        return asToolError(`Memory task not found: ${id}`);
      }
      return asToolText(task);
    })
  );

  server.registerTool(
    "resume_memory_task",
    {
      description: "Render a saved SwarmVault memory task as a next-agent handoff.",
      inputSchema: {
        id: z.string().min(1).describe("Memory task id"),
        format: z.enum(["markdown", "json", "llms"]).optional().describe("Rendered output format")
      }
    },
    safeHandler(async ({ id, format }) => {
      return asToolText(await resumeMemoryTask(rootDir, id, { format }));
    })
  );

  server.registerTool(
    "start_task",
    {
      description: "Start a durable SwarmVault agent task and build its initial context pack.",
      inputSchema: {
        goal: z.string().min(1).describe("Task goal to preserve"),
        target: z.string().optional().describe("Optional page, node, path, project, or label to anchor the initial context pack"),
        budgetTokens: z.number().int().min(200).optional().describe("Approximate token budget for the initial context pack"),
        agent: z.string().optional().describe("Agent name to record on the task"),
        contextPackId: z.string().optional().describe("Existing context pack id to attach instead of building a new one")
      }
    },
    safeHandler(async ({ goal, target, budgetTokens, agent, contextPackId }) => {
      return asToolText(await startMemoryTask(rootDir, { goal, target, budgetTokens, agent, contextPackId }));
    })
  );

  server.registerTool(
    "update_task",
    {
      description: "Append a note, decision, path, context pack, or status change to a SwarmVault task.",
      inputSchema: {
        id: z.string().min(1).describe("Task id"),
        note: z.string().optional().describe("Task note to append"),
        decision: z.string().optional().describe("Decision to append"),
        changedPath: z.string().optional().describe("Changed file or wiki path to attach"),
        contextPackId: z.string().optional().describe("Context pack id to attach"),
        sessionId: z.string().optional().describe("Session id to attach"),
        sourceId: z.string().optional().describe("Source id to attach"),
        pageId: z.string().optional().describe("Page id to attach"),
        nodeId: z.string().optional().describe("Graph node id to attach"),
        gitRef: z.string().optional().describe("Git ref to attach"),
        status: z.enum(["active", "blocked", "completed", "archived"]).optional().describe("Task status")
      }
    },
    safeHandler(async ({ id, ...options }) => {
      return asToolText(await updateMemoryTask(rootDir, id, options));
    })
  );

  server.registerTool(
    "finish_task",
    {
      description: "Finish a SwarmVault task with an outcome and optional follow-up.",
      inputSchema: {
        id: z.string().min(1).describe("Task id"),
        outcome: z.string().min(1).describe("Outcome to record"),
        followUp: z.string().optional().describe("Follow-up to preserve for the next agent")
      }
    },
    safeHandler(async ({ id, outcome, followUp }) => {
      return asToolText(await finishMemoryTask(rootDir, id, { outcome, followUp }));
    })
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List saved SwarmVault agent tasks."
    },
    safeHandler(async () => {
      return asToolText(await listMemoryTasks(rootDir));
    })
  );

  server.registerTool(
    "read_task",
    {
      description: "Read a saved SwarmVault agent task by id.",
      inputSchema: {
        id: z.string().min(1).describe("Task id")
      }
    },
    safeHandler(async ({ id }) => {
      const task = await readMemoryTask(rootDir, id);
      if (!task) {
        return asToolError(`Task not found: ${id}`);
      }
      return asToolText(task);
    })
  );

  server.registerTool(
    "resume_task",
    {
      description: "Render a saved SwarmVault task as a next-agent handoff.",
      inputSchema: {
        id: z.string().min(1).describe("Task id"),
        format: z.enum(["markdown", "json", "llms"]).optional().describe("Rendered output format")
      }
    },
    safeHandler(async ({ id, format }) => {
      return asToolText(await resumeMemoryTask(rootDir, id, { format }));
    })
  );

  server.registerTool(
    "ingest_input",
    {
      description: "Ingest a local file path or URL into the SwarmVault workspace.",
      inputSchema: {
        input: z.string().min(1).describe("Local path or URL to ingest")
      }
    },
    safeHandler(async ({ input }) => {
      const result = await ingestInputDetailed(rootDir, input);
      return asToolText(result);
    })
  );

  server.registerTool(
    "compile_vault",
    {
      description: "Compile source manifests into wiki pages, graph data, and search index.",
      inputSchema: {
        approve: z.boolean().optional().describe("Stage a review bundle without applying active page changes"),
        maxTokens: z.number().int().min(1000).optional().describe("Maximum token budget for wiki output")
      }
    },
    safeHandler(async ({ approve, maxTokens }) => {
      const result = await compileVault(rootDir, { approve: approve ?? false, maxTokens });
      return asToolText(result);
    })
  );

  server.registerTool(
    "lint_vault",
    {
      description: "Run anti-drift and vault health checks."
    },
    safeHandler(async () => {
      const findings = await lintVault(rootDir);
      return asToolText(findings);
    })
  );

  server.registerTool(
    "list_approvals",
    {
      description: "List staged approval bundles awaiting review."
    },
    safeHandler(async () => {
      const approvals = await listApprovals(rootDir);
      return asToolText(approvals);
    })
  );

  server.registerTool(
    "read_approval",
    {
      description: "Read the details and structured diffs for an approval bundle.",
      inputSchema: {
        approvalId: z.string().min(1).describe("Approval bundle id"),
        diff: z.boolean().optional().describe("Include the textual unified diff alongside the structured diff")
      }
    },
    safeHandler(async ({ approvalId, diff }) => {
      const result = await readApproval(rootDir, approvalId, { diff: diff ?? true });
      return asToolText(result);
    })
  );

  server.registerTool(
    "promote_candidate",
    {
      description: "Promote a staged candidate into its active concept or entity page.",
      inputSchema: {
        target: z.string().min(1).describe("Candidate page id or wiki/candidates path")
      }
    },
    safeHandler(async ({ target }) => {
      const result = await promoteCandidate(rootDir, target);
      return asToolText(result);
    })
  );

  server.registerTool(
    "archive_candidate",
    {
      description: "Archive a staged candidate without promoting it.",
      inputSchema: {
        target: z.string().min(1).describe("Candidate page id or wiki/candidates path")
      }
    },
    safeHandler(async ({ target }) => {
      const result = await archiveCandidate(rootDir, target);
      return asToolText(result);
    })
  );

  server.registerTool(
    "preview_candidate_scores",
    {
      description: "Score staged candidates against the configured auto-promotion rules without promoting."
    },
    safeHandler(async () => {
      const decisions = await previewCandidatePromotions(rootDir);
      return asToolText(decisions);
    })
  );

  server.registerTool(
    "auto_promote_candidates",
    {
      description: "Apply configured auto-promotion rules to staged candidates. Requires candidate.autoPromote.enabled in config.",
      inputSchema: {
        dryRun: z.boolean().optional().describe("Score candidates without moving files")
      }
    },
    safeHandler(async ({ dryRun }) => {
      const result = await runAutoPromotion(rootDir, { dryRun: dryRun ?? false });
      return asToolText(result);
    })
  );

  server.registerTool(
    "review_decision",
    {
      description: "Accept or reject approval bundle entries from a staged compile.",
      inputSchema: {
        approvalId: z.string().min(1).describe("Approval bundle id as reported by list_approvals or read_approval"),
        decision: z.enum(["accept", "reject"]).describe("Action to apply to the selected entries"),
        targets: z.array(z.string()).optional().describe("Specific entry page ids to act on (defaults to all pending)"),
        notes: z.string().optional().describe("Free-form reviewer notes, surfaced in the session log")
      }
    },
    safeHandler(async ({ approvalId, decision, targets, notes }) => {
      const apply = decision === "accept" ? acceptApproval : rejectApproval;
      const result = await apply(rootDir, approvalId, targets ?? []);
      return asToolText({ ...result, notes });
    })
  );

  server.registerTool(
    "watch_status",
    {
      description: "Return the current watch-mode status: watched repos, last run summary, and pending semantic refreshes."
    },
    safeHandler(async () => {
      const status = await getWatchStatus(rootDir);
      return asToolText(status);
    })
  );

  server.registerTool(
    "consolidate",
    {
      description:
        "Run the LLM Wiki v2 consolidation pass, rolling working-tier insight pages into episodic, semantic, and procedural tiers.",
      inputSchema: {
        dryRun: z.boolean().optional().describe("Return decisions without writing any files")
      }
    },
    safeHandler(async ({ dryRun }) => {
      const result = await consolidateVault(rootDir, { dryRun: dryRun ?? false });
      return asToolText(result);
    })
  );

  server.registerTool(
    "migrate",
    {
      description: "Detect the vault's version and preview the migration plan to the current SwarmVault version.",
      inputSchema: {
        target: z.string().optional().describe("Optional target version cap (migrations with toVersion above this are skipped)")
      }
    },
    safeHandler(async ({ target }) => {
      const plan = await runMigration(rootDir, { targetVersion: target, dryRun: true });
      return asToolText(plan);
    })
  );

  server.registerResource(
    "swarmvault-config",
    "swarmvault://config",
    {
      title: "SwarmVault Config",
      description: "The resolved SwarmVault config file.",
      mimeType: "application/json"
    },
    async () => {
      const { config } = await loadVaultConfig(rootDir);
      return asTextResource("swarmvault://config", JSON.stringify(config, null, 2));
    }
  );

  server.registerResource(
    "swarmvault-graph",
    "swarmvault://graph",
    {
      title: "SwarmVault Graph",
      description: "The compiled graph artifact for the current workspace.",
      mimeType: "application/json"
    },
    async () => {
      const { paths } = await loadVaultConfig(rootDir);
      const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
      return asTextResource(
        "swarmvault://graph",
        JSON.stringify(graph ?? { error: "Graph artifact not found. Run `swarmvault compile` first." }, null, 2)
      );
    }
  );

  server.registerResource(
    "swarmvault-manifests",
    "swarmvault://manifests",
    {
      title: "SwarmVault Manifests",
      description: "All source manifests in the workspace.",
      mimeType: "application/json"
    },
    async () => {
      const manifests = await listManifests(rootDir);
      return asTextResource("swarmvault://manifests", JSON.stringify(manifests, null, 2));
    }
  );

  server.registerResource(
    "swarmvault-schema",
    "swarmvault://schema",
    {
      title: "SwarmVault Schema",
      description: "The vault schema file that guides compile and query behavior.",
      mimeType: "text/markdown"
    },
    async () => {
      const schema = await loadVaultSchema(rootDir);
      return asTextResource("swarmvault://schema", schema.content);
    }
  );

  server.registerResource(
    "swarmvault-sessions",
    "swarmvault://sessions",
    {
      title: "SwarmVault Sessions",
      description: "Canonical session artifacts for compile, query, explore, lint, and watch runs.",
      mimeType: "application/json"
    },
    async () => {
      const { paths } = await loadVaultConfig(rootDir);
      const files = (await listFilesRecursive(paths.sessionsDir))
        .filter((filePath) => filePath.endsWith(".md"))
        .map((filePath) => toPosix(path.relative(paths.sessionsDir, filePath)))
        .sort();
      return asTextResource("swarmvault://sessions", JSON.stringify(files, null, 2));
    }
  );

  server.registerResource(
    "swarmvault-context-packs",
    "swarmvault://context-packs",
    {
      title: "SwarmVault Context Packs",
      description: "Saved token-bounded context packs for agent tasks.",
      mimeType: "application/json"
    },
    async () => {
      return asTextResource("swarmvault://context-packs", JSON.stringify(await listContextPacks(rootDir), null, 2));
    }
  );

  server.registerResource(
    "swarmvault-memory-tasks",
    "swarmvault://memory-tasks",
    {
      title: "SwarmVault Agent Memory Tasks",
      description: "Saved git-backed agent memory task ledger entries.",
      mimeType: "application/json"
    },
    async () => {
      return asTextResource("swarmvault://memory-tasks", JSON.stringify(await listMemoryTasks(rootDir), null, 2));
    }
  );

  server.registerResource(
    "swarmvault-tasks",
    "swarmvault://tasks",
    {
      title: "SwarmVault Agent Tasks",
      description: "Saved git-backed agent task ledger entries.",
      mimeType: "application/json"
    },
    async () => {
      return asTextResource("swarmvault://tasks", JSON.stringify(await listMemoryTasks(rootDir), null, 2));
    }
  );

  server.registerResource(
    "swarmvault-pages",
    new ResourceTemplate("swarmvault://pages/{path}", {
      list: async () => {
        const pages = await listPages(rootDir);
        return {
          resources: pages.map((page) => ({
            uri: `swarmvault://pages/${encodeURIComponent(page.path)}`,
            name: page.title,
            title: page.title,
            description: `SwarmVault ${page.kind} page`,
            mimeType: "text/markdown"
          }))
        };
      }
    }),
    {
      title: "SwarmVault Pages",
      description: "Generated wiki pages exposed as MCP resources.",
      mimeType: "text/markdown"
    },
    async (_uri, variables) => {
      const encodedPath = typeof variables.path === "string" ? variables.path : "";
      const relativePath = decodeURIComponent(encodedPath);
      const page = await readPage(rootDir, relativePath);
      if (!page) {
        return asTextResource(`swarmvault://pages/${encodedPath}`, `Page not found: ${relativePath}`);
      }

      const { paths } = await loadVaultConfig(rootDir);
      const absolutePath = path.resolve(paths.wikiDir, relativePath);
      return asTextResource(`swarmvault://pages/${encodedPath}`, await fs.readFile(absolutePath, "utf8"));
    }
  );

  server.registerResource(
    "swarmvault-session-files",
    new ResourceTemplate("swarmvault://sessions/{path}", {
      list: async () => {
        const { paths } = await loadVaultConfig(rootDir);
        const files = (await listFilesRecursive(paths.sessionsDir))
          .filter((filePath) => filePath.endsWith(".md"))
          .map((filePath) => toPosix(path.relative(paths.sessionsDir, filePath)))
          .sort();
        return {
          resources: files.map((relativePath) => ({
            uri: `swarmvault://sessions/${encodeURIComponent(relativePath)}`,
            name: path.basename(relativePath, ".md"),
            title: relativePath,
            description: "SwarmVault session artifact",
            mimeType: "text/markdown"
          }))
        };
      }
    }),
    {
      title: "SwarmVault Session Files",
      description: "Session artifacts exposed as MCP resources.",
      mimeType: "text/markdown"
    },
    async (_uri, variables) => {
      const { paths } = await loadVaultConfig(rootDir);
      const encodedPath = typeof variables.path === "string" ? variables.path : "";
      const relativePath = decodeURIComponent(encodedPath);
      const absolutePath = path.resolve(paths.sessionsDir, relativePath);
      if (!isPathWithin(paths.sessionsDir, absolutePath) || !(await fileExists(absolutePath))) {
        return asTextResource(`swarmvault://sessions/${encodedPath}`, `Session not found: ${relativePath}`);
      }

      return asTextResource(`swarmvault://sessions/${encodedPath}`, await fs.readFile(absolutePath, "utf8"));
    }
  );

  return server;
}

export async function startMcpServer(rootDir: string, stdin?: Readable, stdout?: Writable): Promise<{ close: () => Promise<void> }> {
  const server = await createMcpServer(rootDir);
  const transport = new StdioServerTransport(stdin, stdout);
  await server.connect(transport);
  return {
    close: async () => {
      await server.close();
    }
  };
}

function asToolText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function asToolError(message: string) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: message
      }
    ]
  };
}

/**
 * Wraps an MCP tool handler so thrown errors become a well-formed MCP error
 * response instead of crashing the stdio server. A single malformed argument
 * or transient IO failure should not sever every other tool in the session.
 */
function safeHandler<Args, Result>(
  handler: (args: Args) => Promise<Result>
): (args: Args) => Promise<Result | ReturnType<typeof asToolError>> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[swarmvault-mcp] tool handler failed: ${message}`);
      return asToolError(message);
    }
  };
}

function asTextResource(uri: string, text: string) {
  return {
    contents: [
      {
        uri,
        text
      }
    ]
  };
}
