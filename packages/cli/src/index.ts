#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import {
  acceptApproval,
  archiveCandidate,
  compileVault,
  exploreVault,
  exportGraphHtml,
  importInbox,
  ingestInput,
  initVault,
  installAgent,
  lintVault,
  listApprovals,
  listCandidates,
  listSchedules,
  loadVaultConfig,
  promoteCandidate,
  queryVault,
  readApproval,
  rejectApproval,
  runSchedule,
  serveSchedules,
  startGraphServer,
  startMcpServer,
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
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "0.1.16";
  } catch {
    return "0.1.16";
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
  .description("Ingest a local file path or URL into the raw SwarmVault workspace.")
  .argument("<input>", "Local file path or URL")
  .option("--include-assets", "Download remote image assets when ingesting URLs", true)
  .option("--no-include-assets", "Skip downloading remote image assets when ingesting URLs")
  .option("--max-asset-size <bytes>", "Maximum number of bytes to fetch for a single remote image asset")
  .action(async (input: string, options: { includeAssets?: boolean; maxAssetSize?: string }) => {
    const maxAssetSize =
      typeof options.maxAssetSize === "string" && options.maxAssetSize.trim() ? Number.parseInt(options.maxAssetSize, 10) : undefined;
    const manifest = await ingestInput(process.cwd(), input, {
      includeAssets: options.includeAssets,
      maxAssetSize: Number.isFinite(maxAssetSize) ? maxAssetSize : undefined
    });
    if (isJson()) {
      emitJson(manifest);
    } else {
      log(manifest.sourceId);
    }
  });

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
  .description("Watch the inbox directory and run import/compile cycles on changes.")
  .option("--lint", "Run lint after each compile cycle", false)
  .option("--debounce <ms>", "Debounce window in milliseconds", "900")
  .action(async (options: { lint?: boolean; debounce?: string }) => {
    const debounceMs = Number.parseInt(options.debounce ?? "900", 10);
    const { paths } = await loadVaultConfig(process.cwd());
    const controller = await watchVault(process.cwd(), {
      lint: options.lint ?? false,
      debounceMs: Number.isFinite(debounceMs) ? debounceMs : 900
    });
    if (isJson()) {
      emitJson({ status: "watching", inboxDir: paths.inboxDir });
    } else {
      log("Watching inbox for changes. Press Ctrl+C to stop.");
    }
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
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
  .requiredOption("--agent <agent>", "codex, claude, cursor, goose, pi, or gemini")
  .action(async (options: { agent: "codex" | "claude" | "cursor" | "goose" | "pi" | "gemini" }) => {
    const target = await installAgent(process.cwd(), options.agent);
    if (isJson()) {
      emitJson({ agent: options.agent, target });
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
