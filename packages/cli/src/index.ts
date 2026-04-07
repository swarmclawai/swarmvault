#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import {
  acceptApproval,
  archiveCandidate,
  compileVault,
  explainGraphVault,
  exploreVault,
  exportGraphHtml,
  getGitHookStatus,
  importInbox,
  ingestDirectory,
  ingestInput,
  initVault,
  installAgent,
  installGitHooks,
  lintVault,
  listApprovals,
  listCandidates,
  listGodNodes,
  listSchedules,
  loadVaultConfig,
  pathGraphVault,
  promoteCandidate,
  queryGraphVault,
  queryVault,
  readApproval,
  rejectApproval,
  runSchedule,
  runWatchCycle,
  serveSchedules,
  startGraphServer,
  startMcpServer,
  uninstallGitHooks,
  watchVault
} from "@swarmvaultai/engine";
import { Command, Option } from "commander";

const program = new Command();
const CLI_VERSION = readCliVersion();

program
  .name("swarmvault")
  .description("SwarmVault is a local-first LLM wiki compiler with graph outputs and pluggable providers.")
  .version(CLI_VERSION)
  .option("--json", "Emit structured JSON output", false);

function readCliVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "0.1.20";
  } catch {
    return "0.1.20";
  }
}

function isJson(): boolean {
  return program.opts().json === true;
}

function emitJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function log(message: string): void {
  if (isJson()) {
    process.stderr.write(`${message}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

program
  .command("init")
  .description("Initialize a SwarmVault workspace in the current directory.")
  .option("--obsidian", "Generate a minimal .obsidian workspace alongside the vault", false)
  .action(async (options: { obsidian?: boolean }) => {
    await initVault(process.cwd(), { obsidian: options.obsidian ?? false });
    if (isJson()) {
      emitJson({ status: "initialized", rootDir: process.cwd(), obsidian: options.obsidian ?? false });
    } else {
      log("Initialized SwarmVault workspace.");
    }
  });

program
  .command("ingest")
  .description("Ingest a local file path, directory path, or URL into the raw SwarmVault workspace.")
  .argument("<input>", "Local file path, directory path, or URL")
  .option("--include-assets", "Download remote image assets when ingesting URLs", true)
  .option("--no-include-assets", "Skip downloading remote image assets when ingesting URLs")
  .option("--max-asset-size <bytes>", "Maximum number of bytes to fetch for a single remote image asset")
  .option("--repo-root <path>", "Override the detected repo root when ingesting a directory")
  .option("--include <glob...>", "Only ingest files matching one or more glob patterns")
  .option("--exclude <glob...>", "Skip files matching one or more glob patterns")
  .option("--max-files <n>", "Maximum number of files to ingest from a directory")
  .option("--no-gitignore", "Ignore .gitignore rules when ingesting a directory")
  .action(
    async (
      input: string,
      options: {
        includeAssets?: boolean;
        maxAssetSize?: string;
        repoRoot?: string;
        include?: string[];
        exclude?: string[];
        maxFiles?: string;
        gitignore?: boolean;
      }
    ) => {
      const maxAssetSize =
        typeof options.maxAssetSize === "string" && options.maxAssetSize.trim() ? Number.parseInt(options.maxAssetSize, 10) : undefined;
      const maxFiles = typeof options.maxFiles === "string" && options.maxFiles.trim() ? Number.parseInt(options.maxFiles, 10) : undefined;
      const commonOptions = {
        includeAssets: options.includeAssets,
        maxAssetSize: Number.isFinite(maxAssetSize) ? maxAssetSize : undefined,
        repoRoot: options.repoRoot,
        include: options.include,
        exclude: options.exclude,
        maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined,
        gitignore: options.gitignore
      };
      const directoryResult = !/^https?:\/\//i.test(input)
        ? await import("node:fs/promises").then((fs) =>
            fs
              .stat(input)
              .then((stat) => (stat.isDirectory() ? ingestDirectory(process.cwd(), input, commonOptions) : null))
              .catch(() => null)
          )
        : null;
      if (directoryResult) {
        if (isJson()) {
          emitJson(directoryResult);
        } else {
          log(
            `Imported ${directoryResult.imported.length} file(s), updated ${directoryResult.updated.length}, skipped ${directoryResult.skipped.length}.`
          );
        }
        return;
      }
      const manifest = await ingestInput(process.cwd(), input, commonOptions);
      if (isJson()) {
        emitJson(manifest);
      } else {
        log(manifest.sourceId);
      }
    }
  );

const inbox = program.command("inbox").description("Inbox and capture workflows.");
inbox
  .command("import")
  .description("Import supported files from the configured inbox directory.")
  .argument("[dir]", "Optional inbox directory override")
  .action(async (dir?: string) => {
    const result = await importInbox(process.cwd(), dir);
    if (isJson()) {
      emitJson(result);
    } else {
      log(
        `Imported ${result.imported.length} source(s) from ${result.inputDir}. Scanned: ${result.scannedCount}. Attachments: ${result.attachmentCount}. Skipped: ${result.skipped.length}.`
      );
    }
  });

program
  .command("compile")
  .description("Compile manifests into wiki pages, graph JSON, and search index.")
  .option("--approve", "Stage a review bundle without applying active page changes", false)
  .action(async (options: { approve?: boolean }) => {
    const result = await compileVault(process.cwd(), { approve: options.approve ?? false });
    if (isJson()) {
      emitJson(result);
    } else {
      if (result.staged) {
        log(`Staged ${result.changedPages.length} change(s) for review at ${result.approvalDir}.`);
      } else {
        log(`Compiled ${result.sourceCount} source(s), ${result.pageCount} page(s). Changed: ${result.changedPages.length}.`);
      }
    }
  });

program
  .command("query")
  .description("Query the compiled SwarmVault wiki.")
  .argument("<question>", "Question to ask SwarmVault")
  .option("--no-save", "Do not persist the answer to wiki/outputs")
  .addOption(
    new Option("--format <format>", "Output format").choices(["markdown", "report", "slides", "chart", "image"]).default("markdown")
  )
  .action(async (question: string, options: { save?: boolean; format?: "markdown" | "report" | "slides" | "chart" | "image" }) => {
    const result = await queryVault(process.cwd(), {
      question,
      save: options.save ?? true,
      format: options.format
    });
    if (isJson()) {
      emitJson(result);
    } else {
      log(result.answer);
      if (result.savedPath) {
        log(`Saved to ${result.savedPath}`);
      }
    }
  });

program
  .command("explore")
  .description("Run a save-first multi-step exploration loop against the vault.")
  .argument("<question>", "Root question to explore")
  .option("--steps <n>", "Maximum number of exploration steps", "3")
  .addOption(
    new Option("--format <format>", "Output format for step pages")
      .choices(["markdown", "report", "slides", "chart", "image"])
      .default("markdown")
  )
  .action(async (question: string, options: { steps?: string; format?: "markdown" | "report" | "slides" | "chart" | "image" }) => {
    const stepCount = Number.parseInt(options.steps ?? "3", 10);
    const result = await exploreVault(process.cwd(), {
      question,
      steps: Number.isFinite(stepCount) ? stepCount : 3,
      format: options.format
    });
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Exploration hub saved to ${result.hubPath}`);
      log(`Completed ${result.stepCount} step(s).`);
    }
  });

program
  .command("lint")
  .description("Run anti-drift and wiki-health checks.")
  .option("--deep", "Run LLM-powered advisory lint", false)
  .option("--web", "Augment deep lint with configured web search", false)
  .action(async (options: { deep?: boolean; web?: boolean }) => {
    const findings = await lintVault(process.cwd(), {
      deep: options.deep ?? false,
      web: options.web ?? false
    });
    if (isJson()) {
      emitJson(findings);
      return;
    }
    if (!findings.length) {
      log("No findings.");
      return;
    }
    for (const finding of findings) {
      log(`[${finding.severity}] ${finding.code}: ${finding.message}${finding.pagePath ? ` (${finding.pagePath})` : ""}`);
    }
  });

const graph = program.command("graph").description("Graph-related commands.");
graph
  .command("serve")
  .description("Serve the local graph viewer.")
  .option("--port <port>", "Port override")
  .action(async (options: { port?: string }) => {
    const port = options.port ? Number.parseInt(options.port, 10) : undefined;
    const server = await startGraphServer(process.cwd(), port);
    if (isJson()) {
      emitJson({ port: server.port, url: `http://localhost:${server.port}` });
    } else {
      log(`Graph viewer running at http://localhost:${server.port}`);
    }
    process.on("SIGINT", async () => {
      await server.close();
      process.exit(0);
    });
  });

graph
  .command("export")
  .description("Export the graph viewer as a single self-contained HTML file.")
  .requiredOption("--html <output>", "Output HTML file path")
  .action(async (options: { html: string }) => {
    const outputPath = await exportGraphHtml(process.cwd(), options.html);
    if (isJson()) {
      emitJson({ outputPath });
    } else {
      log(`Exported graph HTML to ${outputPath}`);
    }
  });

graph
  .command("query")
  .description("Traverse the compiled graph deterministically from local search seeds.")
  .argument("<question>", "Question or graph search seed")
  .option("--dfs", "Prefer a depth-first traversal instead of breadth-first", false)
  .option("--budget <n>", "Maximum number of graph nodes to summarize")
  .action(async (question: string, options: { dfs?: boolean; budget?: string }) => {
    const budget = options.budget ? Number.parseInt(options.budget, 10) : undefined;
    const result = await queryGraphVault(process.cwd(), question, {
      traversal: options.dfs ? "dfs" : "bfs",
      budget: Number.isFinite(budget) ? budget : undefined
    });
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(result.summary);
  });

graph
  .command("path")
  .description("Find the shortest graph path between two nodes or pages.")
  .argument("<from>", "Source node/page label or id")
  .argument("<to>", "Target node/page label or id")
  .action(async (from: string, to: string) => {
    const result = await pathGraphVault(process.cwd(), from, to);
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(result.summary);
  });

graph
  .command("explain")
  .description("Explain a graph node, its page, community, and neighbors.")
  .argument("<target>", "Node/page label or id")
  .action(async (target: string) => {
    const result = await explainGraphVault(process.cwd(), target);
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(result.summary);
  });

graph
  .command("god-nodes")
  .description("List the highest-connectivity non-source graph nodes.")
  .option("--limit <n>", "Maximum number of nodes to return", "10")
  .action(async (options: { limit?: string }) => {
    const limit = Number.parseInt(options.limit ?? "10", 10);
    const result = await listGodNodes(process.cwd(), Number.isFinite(limit) ? limit : 10);
    if (isJson()) {
      emitJson(result);
      return;
    }
    for (const node of result) {
      log(`${node.label} degree=${node.degree ?? 0} bridge=${node.bridgeScore ?? 0}`);
    }
  });

const review = program.command("review").description("Review staged compile approval bundles.");
review
  .command("list")
  .description("List staged approval bundles and their resolution status.")
  .action(async () => {
    const approvals = await listApprovals(process.cwd());
    if (isJson()) {
      emitJson(approvals);
      return;
    }
    if (!approvals.length) {
      log("No approval bundles.");
      return;
    }
    for (const approval of approvals) {
      log(
        `${approval.approvalId} pending=${approval.pendingCount} accepted=${approval.acceptedCount} rejected=${approval.rejectedCount} created=${approval.createdAt}`
      );
    }
  });

review
  .command("show")
  .description("Show the entries inside a staged approval bundle.")
  .argument("<approvalId>", "Approval bundle identifier")
  .action(async (approvalId: string) => {
    const approval = await readApproval(process.cwd(), approvalId);
    if (isJson()) {
      emitJson(approval);
      return;
    }
    log(`${approval.approvalId} pending=${approval.pendingCount} accepted=${approval.acceptedCount} rejected=${approval.rejectedCount}`);
    for (const entry of approval.entries) {
      log(`- ${entry.status} ${entry.changeType} ${entry.pageId} ${entry.nextPath ?? entry.previousPath ?? ""}`.trim());
    }
  });

review
  .command("accept")
  .description("Accept all pending entries, or selected entries, from a staged approval bundle.")
  .argument("<approvalId>", "Approval bundle identifier")
  .argument("[targets...]", "Optional page ids or paths to accept")
  .action(async (approvalId: string, targets: string[]) => {
    const result = await acceptApproval(process.cwd(), approvalId, targets);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Accepted ${result.updatedEntries.length} entr${result.updatedEntries.length === 1 ? "y" : "ies"} from ${approvalId}.`);
    }
  });

review
  .command("reject")
  .description("Reject all pending entries, or selected entries, from a staged approval bundle.")
  .argument("<approvalId>", "Approval bundle identifier")
  .argument("[targets...]", "Optional page ids or paths to reject")
  .action(async (approvalId: string, targets: string[]) => {
    const result = await rejectApproval(process.cwd(), approvalId, targets);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Rejected ${result.updatedEntries.length} entr${result.updatedEntries.length === 1 ? "y" : "ies"} from ${approvalId}.`);
    }
  });

const candidate = program.command("candidate").description("Candidate page workflows.");
candidate
  .command("list")
  .description("List staged concept and entity candidates.")
  .action(async () => {
    const candidates = await listCandidates(process.cwd());
    if (isJson()) {
      emitJson(candidates);
      return;
    }
    if (!candidates.length) {
      log("No candidates.");
      return;
    }
    for (const entry of candidates) {
      log(`${entry.pageId} ${entry.path} -> ${entry.activePath}`);
    }
  });

candidate
  .command("promote")
  .description("Promote a candidate into its active concept or entity path.")
  .argument("<target>", "Candidate page id or path")
  .action(async (target: string) => {
    const result = await promoteCandidate(process.cwd(), target);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Promoted ${result.pageId} to ${result.path}`);
    }
  });

candidate
  .command("archive")
  .description("Archive a candidate by removing it from the active candidate set.")
  .argument("<target>", "Candidate page id or path")
  .action(async (target: string) => {
    const result = await archiveCandidate(process.cwd(), target);
    if (isJson()) {
      emitJson(result);
    } else {
      log(`Archived ${result.pageId}`);
    }
  });

program
  .command("watch")
  .description("Watch the inbox directory and optionally tracked repos, or run one refresh cycle immediately.")
  .option("--lint", "Run lint after each compile cycle", false)
  .option("--repo", "Also refresh tracked repo sources and watch their repo roots", false)
  .option("--once", "Run one import/refresh cycle immediately instead of starting a watcher", false)
  .option("--debounce <ms>", "Debounce window in milliseconds", "900")
  .action(async (options: { lint?: boolean; repo?: boolean; once?: boolean; debounce?: string }) => {
    const debounceMs = Number.parseInt(options.debounce ?? "900", 10);
    if (options.once) {
      const result = await runWatchCycle(process.cwd(), {
        lint: options.lint ?? false,
        repo: options.repo ?? false,
        debounceMs: Number.isFinite(debounceMs) ? debounceMs : 900
      });
      if (isJson()) {
        emitJson(result);
      } else {
        log(
          `Refreshed inbox${options.repo ? " and tracked repos" : ""}. Imported ${result.importedCount}, repo imported ${result.repoImportedCount}, repo updated ${result.repoUpdatedCount}, repo removed ${result.repoRemovedCount}.`
        );
      }
      return;
    }
    const { paths } = await loadVaultConfig(process.cwd());
    const controller = await watchVault(process.cwd(), {
      lint: options.lint ?? false,
      repo: options.repo ?? false,
      debounceMs: Number.isFinite(debounceMs) ? debounceMs : 900
    });
    if (isJson()) {
      emitJson({ status: "watching", inboxDir: paths.inboxDir, repo: options.repo ?? false });
    } else {
      log(`Watching inbox${options.repo ? " and tracked repos" : ""} for changes. Press Ctrl+C to stop.`);
    }
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

const hook = program.command("hook").description("Install local git hooks that keep tracked repos and the vault in sync.");
hook
  .command("install")
  .description("Install post-commit and post-checkout hooks for the nearest git repository.")
  .action(async () => {
    const status = await installGitHooks(process.cwd());
    if (isJson()) {
      emitJson(status);
      return;
    }
    log(`Installed hooks in ${status.repoRoot}`);
  });

hook
  .command("uninstall")
  .description("Remove the SwarmVault-managed git hook blocks from the nearest git repository.")
  .action(async () => {
    const status = await uninstallGitHooks(process.cwd());
    if (isJson()) {
      emitJson(status);
      return;
    }
    log(`Removed SwarmVault hook blocks from ${status.repoRoot ?? "the current workspace"}`);
  });

hook
  .command("status")
  .description("Show whether SwarmVault-managed git hooks are installed.")
  .action(async () => {
    const status = await getGitHookStatus(process.cwd());
    if (isJson()) {
      emitJson(status);
      return;
    }
    if (!status.repoRoot) {
      log("No git repository found.");
      return;
    }
    log(`repo=${status.repoRoot}`);
    log(`post-commit=${status.postCommit}`);
    log(`post-checkout=${status.postCheckout}`);
  });

const schedule = program.command("schedule").description("Run scheduled vault maintenance jobs.");
schedule
  .command("list")
  .description("List configured schedule jobs and their next run state.")
  .action(async () => {
    const schedules = await listSchedules(process.cwd());
    if (isJson()) {
      emitJson(schedules);
      return;
    }
    if (!schedules.length) {
      log("No schedules configured.");
      return;
    }
    for (const entry of schedules) {
      log(
        `${entry.jobId} enabled=${entry.enabled} task=${entry.taskType} next=${entry.nextRunAt ?? "n/a"} last=${entry.lastRunAt ?? "never"} status=${entry.lastStatus ?? "n/a"} approval=${entry.lastApprovalId ?? "none"}`
      );
    }
  });

schedule
  .command("run")
  .description("Run one configured schedule job immediately.")
  .argument("<jobId>", "Schedule identifier")
  .action(async (jobId: string) => {
    const result = await runSchedule(process.cwd(), jobId);
    if (isJson()) {
      emitJson(result);
      return;
    }
    log(
      `${jobId} ${result.success ? "completed" : "failed"} (${result.taskType})${result.approvalId ? ` approval=${result.approvalId}` : ""}${
        result.error ? ` error=${result.error}` : ""
      }`
    );
  });

schedule
  .command("serve")
  .description("Run the local schedule loop.")
  .option("--poll <ms>", "Polling interval in milliseconds", "30000")
  .action(async (options: { poll?: string }) => {
    const pollMs = Number.parseInt(options.poll ?? "30000", 10);
    const controller = await serveSchedules(process.cwd(), Number.isFinite(pollMs) ? pollMs : 30_000);
    if (isJson()) {
      emitJson({ status: "serving", pollMs: Number.isFinite(pollMs) ? pollMs : 30_000 });
    } else {
      log("Serving schedules. Press Ctrl+C to stop.");
    }
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

program
  .command("mcp")
  .description("Run SwarmVault as a local MCP server over stdio.")
  .action(async () => {
    if (isJson()) {
      process.stderr.write(`${JSON.stringify({ status: "running", transport: "stdio" })}\n`);
    }
    const controller = await startMcpServer(process.cwd());
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

program
  .command("install")
  .description("Install SwarmVault instructions for an agent in the current project.")
  .requiredOption("--agent <agent>", "codex, claude, cursor, goose, pi, gemini, or opencode")
  .option("--hook", "Also install the recommended Claude pre-search hook when agent=claude", false)
  .action(async (options: { agent: "codex" | "claude" | "cursor" | "goose" | "pi" | "gemini" | "opencode"; hook?: boolean }) => {
    if (options.hook && options.agent !== "claude") {
      throw new Error("--hook is only supported for --agent claude");
    }
    const target = await installAgent(process.cwd(), options.agent, { claudeHook: options.hook ?? false });
    if (isJson()) {
      emitJson({ agent: options.agent, target, hook: options.hook ?? false });
    } else {
      log(`Installed rules into ${target}`);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (isJson()) {
    emitJson({ error: message });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});
