#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const fixturesDir = path.join(repoRoot, "smoke", "fixtures");
const packageJsonPath = path.join(repoRoot, "packages", "cli", "package.json");
const requireFromScript = createRequire(import.meta.url);

await loadEnvFile(path.join(workspaceRoot, ".env.local"));
await loadEnvFile(path.join(repoRoot, ".env.local"));

const args = parseArgs(process.argv.slice(2));
const lane = args.lane ?? "heuristic";
const version = args.version ?? (await readPackageVersion());
const installSpecs = args.installSpecs?.length ? args.installSpecs : [`@swarmvaultai/cli@${version}`];
const keepArtifacts = args.keepArtifacts ?? process.env.KEEP_LIVE_SMOKE_ARTIFACTS === "1";
const artifactDir =
  args.artifactDir ??
  path.join(repoRoot, ".live-smoke-artifacts", `${lane}-${new Date().toISOString().replaceAll(":", "-")}`);
const workspaceDir = path.join(artifactDir, "workspace");
const prefixDir = path.join(artifactDir, "global-prefix");
const logsDir = path.join(artifactDir, "logs");
const summaryPath = path.join(artifactDir, "summary.json");
const state = {
  lane,
  version,
  artifactDir,
  workspaceDir,
  prefixDir,
  steps: []
};
let installedCli;

let graphServer;
let chartPrimaryAssetPath = "";
let widgetModulePath = "";
let pendingApprovalId = "";

await fs.mkdir(logsDir, { recursive: true });

try {
  await runStep("install-published-cli", async () => {
    await runCommand("npm-install", "npm", ["install", "-g", "--prefix", prefixDir, ...installSpecs], {
      cwd: repoRoot
    });
    installedCli = await resolveInstalledCli(prefixDir);
    const cliVersion = (
      await runInstalledCliCommand("cli-version", ["--version"], {
        cwd: artifactDir
      })
    ).stdout.trim();
    assert.equal(cliVersion, version, "installed CLI version mismatch");
  });

  await runStep("init-workspace", async () => {
    await fs.mkdir(workspaceDir, { recursive: true });
    await runCliJson(["init"]);
    await assertExists(path.join(workspaceDir, "swarmvault.config.json"));
    await assertExists(path.join(workspaceDir, "swarmvault.schema.md"));
    await assertExists(path.join(workspaceDir, "inbox"));
    await assertExists(path.join(workspaceDir, "wiki"));
    await assertExists(path.join(workspaceDir, "state"));
  });

  if (lane === "openai" || lane === "ollama") {
    await runStep(`configure-${lane}`, async () => {
      const configPath = path.join(workspaceDir, "swarmvault.config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (lane === "openai") {
        assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for the openai live-smoke lane");
        config.providers.live = {
          type: "openai",
          model: process.env.SWARMVAULT_OPENAI_MODEL ?? "gpt-4.1-mini",
          apiKeyEnv: "OPENAI_API_KEY"
        };
      } else {
        assert.ok(process.env.OLLAMA_API_KEY, "OLLAMA_API_KEY is required for the ollama live-smoke lane");
        config.providers.live = {
          type: "ollama",
          model: process.env.SWARMVAULT_OLLAMA_MODEL ?? "gpt-oss:20b-cloud",
          apiKeyEnv: "OLLAMA_API_KEY",
          baseUrl: process.env.SWARMVAULT_OLLAMA_BASE_URL ?? "https://ollama.com/v1",
          apiStyle: process.env.SWARMVAULT_OLLAMA_API_STYLE ?? "chat"
        };
      }
      config.tasks = {
        compileProvider: "live",
        queryProvider: "live",
        lintProvider: "live",
        visionProvider: "live"
      };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    });
  }

  await runStep("baseline-ingest-compile", async () => {
    const manifest = await runCliJson(["ingest", path.join(fixturesDir, "source.md")]);
    assert.ok(typeof manifest.sourceId === "string" && manifest.sourceId.length > 0, "ingest did not return a sourceId");
    const compile = await runCliJson(["compile"]);
    assert.ok(compile.sourceCount >= 1, "compile did not report any sources");
    await assertExists(path.join(workspaceDir, "state", "graph.json"));
    await assertExists(path.join(workspaceDir, "state", "search.sqlite"));
    await assertExists(path.join(workspaceDir, "wiki", "index.md"));
  });

  if (lane === "heuristic") {
    await runStep("inbox-import", async () => {
      await copyInboxBundle();
      const result = await runCliJson(["inbox", "import"]);
      assert.equal(result.imported.length, 1, "expected exactly one imported inbox source");
      assert.ok(result.skipped.some((entry) => entry.reason === "referenced_attachment"), "expected referenced asset to be skipped");
      const imported = result.imported[0];
      assert.ok(Array.isArray(imported.attachments) && imported.attachments.length > 0, "expected copied attachments");
      for (const attachment of imported.attachments) {
        await assertExists(path.join(workspaceDir, attachment.path));
      }
      await runCliJson(["compile"]);
    });

    await runStep("remote-url-assets", async () => {
      const routes = {
        "/article": {
          contentType: "text/html; charset=utf-8",
          body: ""
        },
        "/notes.md": {
          contentType: "text/plain; charset=utf-8",
          body: ["# Remote Notes", "", "![Diagram](./images/diagram.png)"].join("\n")
        },
        "/large.md": {
          contentType: "text/plain; charset=utf-8",
          body: ["# Large Asset Note", "", "![Oversized](./images/large.png)"].join("\n")
        },
        "/images/relative.png": {
          contentType: "image/png",
          body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])
        },
        "/images/absolute.png": {
          contentType: "image/png",
          body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6, 7])
        },
        "/images/diagram.png": {
          contentType: "image/png",
          body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 8, 9, 10, 11])
        },
        "/images/large.png": {
          contentType: "image/png",
          body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
        }
      };
      const server = await startFixtureServer(routes);
      try {
        routes["/article"].body = [
          "<html><head><title>Remote Article</title></head><body>",
          "<article>",
          "<h1>Remote Article</h1>",
          "<p>SwarmVault localizes remote images during URL ingest.</p>",
          '<img alt="Relative" src="/images/relative.png" />',
          `<img alt="Absolute" src="${server.baseUrl}/images/absolute.png" />`,
          "</article>",
          "</body></html>"
        ].join("");

        const htmlManifest = await runCliJson(["ingest", `${server.baseUrl}/article`]);
        assert.equal(htmlManifest.attachments.length, 2, "expected HTML URL ingest to localize both remote images");
        const htmlStored = await fs.readFile(path.join(workspaceDir, htmlManifest.storedPath), "utf8");
        for (const attachment of htmlManifest.attachments) {
          const relativePath = attachment.path.replace(`raw/assets/${htmlManifest.sourceId}/`, "");
          assert.ok(htmlStored.includes(`../assets/${htmlManifest.sourceId}/${relativePath}`), "HTML ingest did not rewrite a local asset path");
          await assertExists(path.join(workspaceDir, attachment.path));
        }
        assert.ok(!htmlStored.includes(`${server.baseUrl}/images/absolute.png`), "HTML ingest left a remote absolute asset reference");

        const markdownManifest = await runCliJson(["ingest", `${server.baseUrl}/notes.md`]);
        assert.equal(markdownManifest.attachments.length, 1, "expected markdown URL ingest to localize one remote image");
        const markdownStored = await fs.readFile(path.join(workspaceDir, markdownManifest.storedPath), "utf8");
        const markdownAsset = markdownManifest.attachments[0];
        const markdownRelativePath = markdownAsset.path.replace(`raw/assets/${markdownManifest.sourceId}/`, "");
        assert.ok(
          markdownStored.includes(`../assets/${markdownManifest.sourceId}/${markdownRelativePath}`),
          "markdown URL ingest did not rewrite to a local asset path"
        );

        const skippedManifest = await runCliJson(["ingest", `${server.baseUrl}/large.md`, "--max-asset-size", "8"]);
        assert.ok(!skippedManifest.attachments?.length, "oversized asset should not have been attached");
        const skippedStored = await fs.readFile(path.join(workspaceDir, skippedManifest.storedPath), "utf8");
        assert.ok(skippedStored.includes("./images/large.png"), "oversized asset should leave the original markdown reference intact");

        const disabledManifest = await runCliJson(["ingest", `${server.baseUrl}/notes.md?no-assets=1`, "--no-include-assets"]);
        assert.ok(!disabledManifest.attachments?.length, "--no-include-assets should skip remote asset downloads");
        const disabledStored = await fs.readFile(path.join(workspaceDir, disabledManifest.storedPath), "utf8");
        assert.ok(disabledStored.includes("./images/diagram.png"), "--no-include-assets should leave the original markdown reference intact");

        await runCliJson(["compile"]);
      } finally {
        await server.close();
      }
    });
  }

  await runStep("query-save", async () => {
    const result = await runCliJson(["query", "What does this vault say about durable outputs?"]);
    assert.ok(typeof result.savedPath === "string" && result.savedPath.length > 0, "query did not return a saved path");
    assert.ok(result.citations.length > 0, "query returned no citations");
    await assertExists(result.savedPath);
    const outputsIndex = await fs.readFile(path.join(workspaceDir, "wiki", "outputs", "index.md"), "utf8");
    assert.ok(outputsIndex.includes(path.basename(result.savedPath, ".md")), "outputs index did not include saved output");
  });

  if (lane === "heuristic") {
    await runStep("visual-outputs", async () => {
      const chart = await runCliJson(["query", "Show this vault as a chart", "--format", "chart"]);
      assert.equal(chart.outputFormat, "chart", "chart query did not report the chart format");
      assert.ok(Array.isArray(chart.outputAssets) && chart.outputAssets.length > 0, "chart query did not return output assets");
      await assertExists(chart.savedPath);
      await assertExists(path.join(workspaceDir, "wiki", chart.outputAssets[0].path));
      chartPrimaryAssetPath = chart.outputAssets.find((asset) => asset.role === "primary")?.path ?? chart.outputAssets[0].path;

      const image = await runCliJson(["query", "Show this vault as an image", "--format", "image"]);
      assert.equal(image.outputFormat, "image", "image query did not report the image format");
      assert.ok(Array.isArray(image.outputAssets) && image.outputAssets.length > 0, "image query did not return output assets");
      await assertExists(image.savedPath);
      await assertExists(path.join(workspaceDir, "wiki", image.outputAssets[0].path));
    });

    await runStep("projects-and-code", async () => {
      await updateConfig((config) => {
        config.projects = {
          alpha: {
            roots: ["apps/alpha"]
          }
        };
      });
      await runCliJson(["init", "--obsidian"]);

      await fs.mkdir(path.join(workspaceDir, "apps", "alpha", "src"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "util.ts"),
        [
          "export interface Renderable {",
          "  render(): string;",
          "}",
          "",
          "export function formatLabel(name: string): string {",
          "  return `Widget:${name}`;",
          "}"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "widget.ts"),
        [
          "import { formatLabel, Renderable } from './util';",
          "",
          "function buildLabel(name: string): string {",
          "  return formatLabel(name);",
          "}",
          "",
          "export class Widget implements Renderable {",
          "  constructor(private readonly name: string) {}",
          "",
          "  render(): string {",
          "    return buildLabel(this.name);",
          "  }",
          "}",
          "",
          "export function renderWidget(name: string): string {",
          "  return buildLabel(name);",
          "}"
        ].join("\n"),
        "utf8"
      );

      const util = await runCliJson(["ingest", "apps/alpha/src/util.ts"]);
      const widget = await runCliJson(["ingest", "apps/alpha/src/widget.ts"]);
      assert.equal(util.sourceKind, "code", "util ingest did not classify as code");
      assert.equal(util.language, "typescript", "util ingest did not classify as typescript");
      assert.equal(widget.sourceKind, "code", "widget ingest did not classify as code");

      await runCliJson(["compile"]);

      widgetModulePath = `code/${widget.sourceId}.md`;
      await assertExists(path.join(workspaceDir, "wiki", widgetModulePath));
      await assertExists(path.join(workspaceDir, "wiki", "projects", "index.md"));
      await assertExists(path.join(workspaceDir, "wiki", "projects", "alpha", "index.md"));
      const modulePage = await fs.readFile(path.join(workspaceDir, "wiki", widgetModulePath), "utf8");
      assert.ok(modulePage.includes("## Imports"), "module page did not include imports");
      assert.ok(modulePage.includes("formatLabel"), "module page did not include imported symbol");

      const graphConfig = JSON.parse(await fs.readFile(path.join(workspaceDir, ".obsidian", "graph.json"), "utf8"));
      assert.ok(
        Array.isArray(graphConfig.colorGroups) && graphConfig.colorGroups.some((group) => group.query === "tag:#project/alpha"),
        "obsidian graph config did not include project tag colors"
      );
    });

    await runStep("candidate-flow", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "candidate-provider.mjs"),
        [
          "export async function createAdapter(id, config) {",
          "  return {",
          "    id,",
          "    type: 'custom',",
          "    model: config.model,",
          "    capabilities: new Set(config.capabilities ?? ['chat', 'structured']),",
          "    async generateText() {",
          "      return { text: 'ok' };",
          "    },",
          "    async generateStructured(request) {",
          "      if (request.prompt.includes('Approval Source')) {",
          "        return {",
          "          title: 'Approval Source',",
          "          summary: 'Approval summary.',",
          "          concepts: [{ name: 'Approval Concept', description: 'Requires review.' }],",
          "          entities: [],",
          "          claims: [{ text: 'Approval claim.', confidence: 0.8, status: 'extracted', polarity: 'positive', citation: 'approval-source' }],",
          "          questions: []",
          "        };",
          "      }",
          "      return {",
          "        title: 'Candidate Source',",
          "        summary: 'Candidate summary.',",
          "        concepts: [{ name: 'Candidate Concept', description: 'A recurring concept.' }],",
          "        entities: [],",
          "        claims: [{ text: 'Candidate claim.', confidence: 0.8, status: 'extracted', polarity: 'positive', citation: 'candidate-source' }],",
          "        questions: []",
          "      };",
          "    }",
          "  };",
          "}"
        ].join("\n"),
        "utf8"
      );

      await updateConfig((config) => {
        config.providers.candidateTest = {
          type: "custom",
          model: "candidate-test",
          module: "./candidate-provider.mjs",
          capabilities: ["chat", "structured"]
        };
        config.tasks.compileProvider = "candidateTest";
      });

      await fs.writeFile(path.join(workspaceDir, "candidate.md"), "# Candidate\n\nCandidate content.", "utf8");
      await runCliJson(["ingest", "candidate.md"]);
      await runCliJson(["compile"]);

      const candidates = await runCliJson(["candidate", "list"]);
      assert.ok(Array.isArray(candidates) && candidates.length > 0, "candidate list did not report staged candidates");
      assert.ok(candidates.some((entry) => entry.pageId === "concept:candidate-concept"), "candidate concept missing from candidate list");
      await assertExists(path.join(workspaceDir, "wiki", "candidates", "concepts", "candidate-concept.md"));
    });

    await runStep("explore", async () => {
      const result = await runCliJson(["explore", "What should I investigate next?", "--steps", "2"]);
      assert.ok(result.stepCount >= 1, "explore did not produce any steps");
      assert.ok(typeof result.hubPath === "string" && result.hubPath.length > 0, "explore did not return a hub path");
      await assertExists(result.hubPath);
      for (const step of result.steps) {
        await assertExists(step.savedPath);
      }
    });
  }

  await runStep("lint", async () => {
    const structural = await runCliJson(["lint"]);
    assert.ok(Array.isArray(structural), "lint output was not an array");
    const deep = await runCliJson(["lint", "--deep"]);
    assert.ok(Array.isArray(deep), "deep lint output was not an array");
  });

  if (lane === "heuristic") {
    await runStep("graph-export", async () => {
      const exportDir = path.join(workspaceDir, "exports");
      const outputPath = path.join(exportDir, "graph.html");
      await fs.mkdir(exportDir, { recursive: true });
      const result = await runCliJson(["graph", "export", "--html", outputPath]);
      assert.equal(result.outputPath, outputPath, "graph export returned an unexpected output path");
      await assertExists(outputPath);
      const html = await fs.readFile(outputPath, "utf8");
      assert.ok(html.includes("data:"), "graph export did not embed local asset data");
    });

    await runStep("schedule-run", async () => {
      const configPath = path.join(workspaceDir, "swarmvault.config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      config.schedules = {
        "nightly-chart": {
          enabled: true,
          when: { every: "1h" },
          task: {
            type: "query",
            question: "Show this vault as a chart on schedule",
            format: "chart"
          }
        }
      };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const schedules = await runCliJson(["schedule", "list"]);
      assert.ok(Array.isArray(schedules) && schedules.length === 1, "schedule list did not include the configured job");

      const run = await runCliJson(["schedule", "run", "nightly-chart"]);
      assert.equal(run.success, true, "schedule run did not succeed");
      assert.ok(typeof run.approvalId === "string" && run.approvalId.length > 0, "schedule run did not stage an approval");
      await assertMissing(path.join(workspaceDir, "wiki", "outputs", "show-this-vault-as-a-chart-on-schedule.md"));
    });

    await runStep("graph-serve", async () => {
      const port = await reservePort();
      graphServer = await startCliServer("graph-serve", ["graph", "serve", "--port", String(port)], workspaceDir);
      await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
        return Boolean(response?.ok);
      }, 10_000);
      const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
      const graph = await fetch(`http://127.0.0.1:${port}/api/graph`).then((response) => response.json());
      const candidates = await fetchJson(`http://127.0.0.1:${port}/api/candidates`);
      assert.ok(Array.isArray(candidates) && candidates.some((entry) => entry.pageId === "concept:candidate-concept"), "candidate API did not expose staged candidate");
      const promoted = await fetchJson(`http://127.0.0.1:${port}/api/candidate?action=promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: "concept:candidate-concept" })
      });
      assert.equal(promoted.pageId, "concept:candidate-concept", "candidate API returned the wrong promoted page");
      await assertExists(path.join(workspaceDir, "wiki", "concepts", "candidate-concept.md"));

      await fs.writeFile(path.join(workspaceDir, "approval.md"), "# Approval Source\n\nApproval content.", "utf8");
      await runCliJson(["ingest", "approval.md"]);
      await runCliJson(["compile"]);
      const staged = await runCliJson(["compile", "--approve"]);
      pendingApprovalId = staged.approvalId;
      assert.ok(typeof pendingApprovalId === "string" && pendingApprovalId.length > 0, "compile --approve did not return an approval id");

      const reviews = await fetchJson(`http://127.0.0.1:${port}/api/reviews`);
      assert.ok(Array.isArray(reviews) && reviews.some((entry) => entry.approvalId === pendingApprovalId), "reviews API did not list the pending approval");
      const reviewDetail = await fetchJson(`http://127.0.0.1:${port}/api/review?id=${encodeURIComponent(pendingApprovalId)}`);
      assert.ok(
        Array.isArray(reviewDetail.entries) && reviewDetail.entries.some((entry) => entry.pageId === "concept:approval-concept"),
        "review API did not expose the approval concept entry"
      );

      const search = await fetchJson(
        `http://127.0.0.1:${port}/api/search?q=${encodeURIComponent("renderWidget")}&project=alpha&kind=module&status=active&limit=10`
      );
      assert.ok(Array.isArray(search) && search.some((entry) => entry.path === widgetModulePath), "search API did not return the alpha module page");
      const page = await fetchJson(`http://127.0.0.1:${port}/api/page?path=${encodeURIComponent(widgetModulePath)}`);
      assert.equal(page.path, widgetModulePath, "page API returned the wrong module path");
      assert.ok(page.content.includes("## Imports"), "page API did not return module page content");

      const assetResponse = await fetch(`http://127.0.0.1:${port}/api/asset?path=${encodeURIComponent(chartPrimaryAssetPath)}`);
      assert.equal(assetResponse.ok, true, "asset API did not return the saved chart asset");
      assert.ok((assetResponse.headers.get("content-type") ?? "").includes("image/"), "asset API returned the wrong mime type");

      const blockedAssetResponse = await fetch(`http://127.0.0.1:${port}/api/asset?path=${encodeURIComponent("../package.json")}`);
      assert.equal(blockedAssetResponse.status, 404, "asset API did not block path traversal");

      assert.ok(html.includes("<!doctype html") || html.includes("<html"), "graph viewer did not return HTML");
      assert.ok(Array.isArray(graph.nodes), "graph API did not return nodes");
      assert.ok(Array.isArray(graph.pages), "graph API did not return pages");
      await stopProcess(graphServer.child, graphServer.label);
      graphServer = undefined;
    });

    await runStep("review-flow", async () => {
      const approvals = await runCliJson(["review", "list"]);
      assert.ok(Array.isArray(approvals) && approvals.some((entry) => entry.approvalId === pendingApprovalId), "review list did not include the pending approval");

      const detail = await runCliJson(["review", "show", pendingApprovalId]);
      assert.ok(Array.isArray(detail.entries) && detail.entries.some((entry) => entry.pageId === "concept:approval-concept"), "review show did not include the approval concept");

      const rejected = await runCliJson(["review", "reject", pendingApprovalId, "concept:approval-concept"]);
      assert.ok(Array.isArray(rejected.updatedEntries) && rejected.updatedEntries.length === 1, "review reject did not update exactly one entry");
      await assertMissing(path.join(workspaceDir, "wiki", "concepts", "approval-concept.md"));

      const stagedAgain = await runCliJson(["compile", "--approve"]);
      const accepted = await runCliJson(["review", "accept", stagedAgain.approvalId]);
      assert.ok(Array.isArray(accepted.updatedEntries) && accepted.updatedEntries.length > 0, "review accept did not apply staged entries");
      await assertExists(path.join(workspaceDir, "wiki", "concepts", "approval-concept.md"));
      await assertMissing(path.join(workspaceDir, "wiki", "candidates", "concepts", "approval-concept.md"));
    });

    await runStep("watch", async () => {
      const watchServer = await startCliServer("watch", ["watch", "--lint", "--debounce", "150"], workspaceDir);
      try {
        await fs.writeFile(
          path.join(workspaceDir, "inbox", "watch.md"),
          ["# Watch Note", "", "SwarmVault should import and compile this file when watch mode is running."].join("\n"),
          "utf8"
        );

        await waitFor(async () => {
          const jobsPath = path.join(workspaceDir, "state", "jobs.ndjson");
          const sessionsDir = path.join(workspaceDir, "state", "sessions");
          const jobs = await fs.readFile(jobsPath, "utf8").catch(() => "");
          const sessions = await fs.readdir(sessionsDir).catch(() => []);
          return jobs.includes('"success":true') && jobs.includes('"importedCount":1') && sessions.some((file) => file.includes("-watch-"));
        }, 20_000);
      } finally {
        await stopProcess(watchServer.child, watchServer.label);
      }
    });

    await runStep("mcp", async () => {
      const { Client, StdioClientTransport } = await loadMcpClient();
      assert.ok(installedCli, "installed CLI has not been resolved yet");
      const transport = new StdioClientTransport({
        command: installedCli.command,
        args: [...installedCli.args, "mcp"],
        cwd: workspaceDir,
        env: inheritedEnv(),
        stderr: "pipe"
      });
      const stderrPath = path.join(logsDir, "mcp.stderr.log");
      const stderrChunks = [];
      if (transport.stderr) {
        transport.stderr.on("data", (chunk) => {
          stderrChunks.push(Buffer.from(chunk).toString("utf8"));
        });
      }

      const client = new Client({ name: "swarmvault-live-smoke", version: "1.0.0" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === "workspace_info"), "workspace_info MCP tool missing");
        assert.ok(tools.tools.some((tool) => tool.name === "query_vault"), "query_vault MCP tool missing");

        const workspaceInfo = await client.callTool({ name: "workspace_info", arguments: {} });
        const workspaceJson = JSON.parse(readToolText(workspaceInfo));
        assert.equal(workspaceJson.rootDir, workspaceDir, "workspace_info rootDir mismatch");

        const searchResults = await client.callTool({ name: "search_pages", arguments: { query: "renderWidget", limit: 5 } });
        const searchJson = JSON.parse(readToolText(searchResults));
        assert.ok(Array.isArray(searchJson) && searchJson.some((entry) => entry.path === widgetModulePath), "MCP search_pages did not return the module page");

        const queryResult = await client.callTool({
          name: "query_vault",
          arguments: { question: "What is this vault about?", save: false }
        });
        const queryJson = JSON.parse(readToolText(queryResult));
        assert.ok(typeof queryJson.answer === "string" && queryJson.answer.length > 0, "MCP query returned no answer");

        const chartQuery = await client.callTool({
          name: "query_vault",
          arguments: { question: "Show this vault as a chart", save: false, format: "chart" }
        });
        const chartJson = JSON.parse(readToolText(chartQuery));
        assert.equal(chartJson.outputFormat, "chart", "MCP chart query did not return chart output");
      } finally {
        await fs.writeFile(stderrPath, stderrChunks.join(""), "utf8");
        await client.close();
        await transport.close();
      }
    });

    await runStep("install-agent", async () => {
      const result = await runCliJson(["install", "--agent", "codex"]);
      assert.equal(result.agent, "codex", "install command returned wrong agent");
      await assertExists(path.join(workspaceDir, "AGENTS.md"));
      const content = await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
      assert.ok(content.includes("SwarmVault Rules (codex)"), "AGENTS.md missing managed rules");
    });
  }

  await writeSummary("passed");
  console.log(`[live-smoke] ${lane} lane passed for @swarmvaultai/cli@${version}`);

  if (!keepArtifacts) {
    await fs.rm(artifactDir, { recursive: true, force: true });
  } else {
    console.log(`[live-smoke] kept artifacts at ${artifactDir}`);
  }
} catch (error) {
  await writeSummary("failed", error instanceof Error ? error.message : String(error));
  if (graphServer) {
    await stopProcess(graphServer.child, graphServer.label).catch(() => {});
  }
  console.error(`[live-smoke] ${lane} lane failed. Artifacts kept at ${artifactDir}`);
  throw error;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--lane") {
      parsed.lane = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--artifact-dir") {
      parsed.artifactDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--keep-artifacts") {
      parsed.keepArtifacts = true;
      continue;
    }
    if (value === "--install-spec") {
      parsed.installSpecs ??= [];
      parsed.installSpecs.push(argv[index + 1]);
      index += 1;
    }
  }
  return parsed;
}

async function readPackageVersion() {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  return pkg.version;
}

async function loadEnvFile(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!content) {
    return;
  }

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function cliPath(prefix) {
  return process.platform === "win32" ? path.join(prefix, "swarmvault.cmd") : path.join(prefix, "bin", "swarmvault");
}

async function runStep(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    const result = await fn();
    state.steps.push({ name, status: "passed", startedAt, finishedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    state.steps.push({
      name,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function runCliJson(args) {
  const result = await runInstalledCliCommand(args.join("-").replaceAll(path.sep, "_"), ["--json", ...args], {
    cwd: workspaceDir,
    env: inheritedEnv()
  });
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, `no JSON output received for command: ${args.join(" ")}`);
  return JSON.parse(lines.at(-1));
}

async function updateConfig(mutate) {
  const configPath = path.join(workspaceDir, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, `HTTP ${response.status} from ${url}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function startFixtureServer(routes) {
  const server = createServer((request, response) => {
    const requestUrl = request.url ? new URL(request.url, "http://127.0.0.1") : null;
    const route = requestUrl ? routes[requestUrl.pathname] : undefined;
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }

    const body = typeof route.body === "string" ? Buffer.from(route.body, "utf8") : route.body;
    response.writeHead(200, {
      "content-type": route.contentType ?? "text/plain; charset=utf-8",
      "content-length": String(body.length)
    });
    response.end(body);
  });

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind fixture server"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

async function runInstalledCliCommand(label, args, options = {}) {
  assert.ok(installedCli, "installed CLI has not been resolved yet");
  return runCommand(label, installedCli.command, [...installedCli.args, ...args], options);
}

async function runCommand(label, command, args, options = {}) {
  const commandIndex = state.steps.length + 1;
  const safeLabel = `${String(commandIndex).padStart(2, "0")}-${label.replace(/[^a-z0-9._-]+/gi, "-")}`;
  const stdoutPath = path.join(logsDir, `${safeLabel}.stdout.log`);
  const stderrPath = path.join(logsDir, `${safeLabel}.stderr.log`);
  const metaPath = path.join(logsDir, `${safeLabel}.meta.json`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  await Promise.all([
    fs.writeFile(stdoutPath, stdout, "utf8"),
    fs.writeFile(stderrPath, stderr, "utf8"),
    fs.writeFile(metaPath, JSON.stringify({ command, args, cwd: options.cwd ?? repoRoot, exit }, null, 2), "utf8")
  ]);

  if (exit.code !== 0) {
    throw new Error(`Command failed (${command} ${args.join(" ")}): exit=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`);
  }

  return { stdout, stderr };
}

async function copyInboxBundle() {
  const sourceDir = path.join(fixturesDir, "inbox-bundle");
  const targetDir = path.join(workspaceDir, "inbox");
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function assertExists(targetPath) {
  await fs.access(targetPath);
}

async function assertMissing(targetPath) {
  await fs.access(targetPath).then(
    () => {
      throw new Error(`Expected path to be absent: ${targetPath}`);
    },
    () => undefined
  );
}

async function reservePort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function startCliServer(label, args, cwd) {
  const stdoutPath = path.join(logsDir, `${label}.stdout.log`);
  const stderrPath = path.join(logsDir, `${label}.stderr.log`);
  assert.ok(installedCli, "installed CLI has not been resolved yet");
  const child = spawn(installedCli.command, [...installedCli.args, "--json", ...args], {
    cwd,
    env: inheritedEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("close", async () => {
    await Promise.all([fs.writeFile(stdoutPath, stdout, "utf8"), fs.writeFile(stderrPath, stderr, "utf8")]);
  });

  const ready = await waitForJsonLine(child.stdout, 10_000);
  return { child, label, ready };
}

async function stopProcess(child, label) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill("SIGINT");
  const exited = await waitFor(
    async () => child.exitCode !== null,
    5_000,
    `${label} did not exit after SIGINT`
  ).catch(async () => {
    child.kill("SIGKILL");
    await waitFor(async () => child.exitCode !== null, 5_000, `${label} did not exit after SIGKILL`);
  });
  return exited;
}

async function waitForJsonLine(stream, timeoutMs) {
  const reader = createInterface({ input: stream });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for JSON output from long-running command."));
      }, timeoutMs);

      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(trimmed));
        } catch (error) {
          reject(error);
        }
      });
      reader.on("error", reject);
    });
  } finally {
    reader.close();
  }
}

async function waitFor(condition, timeoutMs, message = "Timed out waiting for condition.") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

function inheritedEnv() {
  const env = { ...process.env };
  delete env.npm_config_prefix;
  return env;
}

async function loadMcpClient() {
  const clientIndexPath = requireFromScript.resolve("@modelcontextprotocol/sdk/client/index.js", {
    paths: [path.join(repoRoot, "packages", "engine")]
  });
  const clientStdioPath = requireFromScript.resolve("@modelcontextprotocol/sdk/client/stdio.js", {
    paths: [path.join(repoRoot, "packages", "engine")]
  });
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(clientIndexPath).href),
    import(pathToFileURL(clientStdioPath).href)
  ]);
  return { Client, StdioClientTransport };
}

async function resolveInstalledCli(prefix) {
  const binPath = cliPath(prefix);
  await assertExists(binPath);
  if (process.platform === "win32") {
    return { command: binPath, args: [] };
  }

  const realPath = await fs.realpath(binPath).catch(() => binPath);
  return { command: process.execPath, args: [realPath] };
}

function readToolText(result) {
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  assert.ok(typeof text === "string" && text.length > 0, "MCP tool returned no text content");
  return text;
}

async function writeSummary(status, error) {
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        ...state,
        status,
        error,
        finishedAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
