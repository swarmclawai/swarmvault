#!/usr/bin/env node
import { Command } from "commander";
import process from "node:process";
import {
  compileVault,
  importInbox,
  ingestInput,
  initVault,
  installAgent,
  lintVault,
  queryVault,
  startGraphServer,
  startMcpServer,
  watchVault
} from "@swarmvaultai/engine";

const program = new Command();

program
  .name("swarmvault")
  .description("SwarmVault is a local-first LLM wiki compiler with graph outputs and pluggable providers.")
  .version("0.1.4");

program
  .command("init")
  .description("Initialize a SwarmVault workspace in the current directory.")
  .action(async () => {
    await initVault(process.cwd());
    process.stdout.write("Initialized SwarmVault workspace.\n");
  });

program
  .command("ingest")
  .description("Ingest a local file path or URL into the raw SwarmVault workspace.")
  .argument("<input>", "Local file path or URL")
  .action(async (input: string) => {
    const manifest = await ingestInput(process.cwd(), input);
    process.stdout.write(`${manifest.sourceId}\n`);
  });

const inbox = program.command("inbox").description("Inbox and capture workflows.");
inbox
  .command("import")
  .description("Import supported files from the configured inbox directory.")
  .argument("[dir]", "Optional inbox directory override")
  .action(async (dir?: string) => {
    const result = await importInbox(process.cwd(), dir);
    process.stdout.write(
      `Imported ${result.imported.length} source(s) from ${result.inputDir}. Scanned: ${result.scannedCount}. Attachments: ${result.attachmentCount}. Skipped: ${result.skipped.length}.\n`
    );
  });

program
  .command("compile")
  .description("Compile manifests into wiki pages, graph JSON, and search index.")
  .action(async () => {
    const result = await compileVault(process.cwd());
    process.stdout.write(
      `Compiled ${result.sourceCount} source(s), ${result.pageCount} page(s). Changed: ${result.changedPages.length}.\n`
    );
  });

program
  .command("query")
  .description("Query the compiled SwarmVault wiki.")
  .argument("<question>", "Question to ask SwarmVault")
  .option("--save", "Persist the answer to wiki/outputs", false)
  .action(async (question: string, options: { save?: boolean }) => {
    const result = await queryVault(process.cwd(), question, options.save ?? false);
    process.stdout.write(`${result.answer}\n`);
    if (result.savedTo) {
      process.stdout.write(`Saved to ${result.savedTo}\n`);
    }
  });

program
  .command("lint")
  .description("Run anti-drift and wiki-health checks.")
  .action(async () => {
    const findings = await lintVault(process.cwd());
    if (!findings.length) {
      process.stdout.write("No findings.\n");
      return;
    }

    for (const finding of findings) {
      process.stdout.write(
        `[${finding.severity}] ${finding.code}: ${finding.message}${finding.pagePath ? ` (${finding.pagePath})` : ""}\n`
      );
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
    process.stdout.write(`Graph viewer running at http://localhost:${server.port}\n`);
    process.on("SIGINT", async () => {
      await server.close();
      process.exit(0);
    });
  });

program
  .command("watch")
  .description("Watch the inbox directory and run import/compile cycles on changes.")
  .option("--lint", "Run lint after each compile cycle", false)
  .option("--debounce <ms>", "Debounce window in milliseconds", "900")
  .action(async (options: { lint?: boolean; debounce?: string }) => {
    const debounceMs = Number.parseInt(options.debounce ?? "900", 10);
    const controller = await watchVault(process.cwd(), {
      lint: options.lint ?? false,
      debounceMs: Number.isFinite(debounceMs) ? debounceMs : 900
    });
    process.stdout.write("Watching inbox for changes. Press Ctrl+C to stop.\n");
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

program
  .command("mcp")
  .description("Run SwarmVault as a local MCP server over stdio.")
  .action(async () => {
    const controller = await startMcpServer(process.cwd());
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

program
  .command("install")
  .description("Install SwarmVault instructions for an agent in the current project.")
  .requiredOption("--agent <agent>", "codex, claude, or cursor")
  .action(async (options: { agent: "codex" | "claude" | "cursor" }) => {
    const target = await installAgent(process.cwd(), options.agent);
    process.stdout.write(`Installed rules into ${target}\n`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
