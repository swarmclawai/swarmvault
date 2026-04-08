#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const tinyMatrixFixtureDir = path.join(fixturesDir, "tiny-matrix");
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
const npmCacheDir = path.join(artifactDir, "npm-cache");
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
const MINIMAL_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

await fs.mkdir(logsDir, { recursive: true });
await fs.mkdir(npmCacheDir, { recursive: true });

try {
  await runStep("install-published-cli", async () => {
    await runCommand("npm-install", "npm", ["install", "-g", "--prefix", prefixDir, ...installSpecs], {
      cwd: repoRoot,
      env: {
        npm_config_cache: npmCacheDir
      }
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

  if (lane === "openai" || lane === "ollama" || lane === "anthropic") {
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
      } else if (lane === "ollama") {
        assert.ok(process.env.OLLAMA_API_KEY, "OLLAMA_API_KEY is required for the ollama live-smoke lane");
        config.providers.live = {
          type: "ollama",
          model: process.env.SWARMVAULT_OLLAMA_MODEL ?? "gpt-oss:20b-cloud",
          apiKeyEnv: "OLLAMA_API_KEY",
          baseUrl: process.env.SWARMVAULT_OLLAMA_BASE_URL ?? "https://ollama.com/v1",
          apiStyle: process.env.SWARMVAULT_OLLAMA_API_STYLE ?? "chat"
        };
      } else {
        assert.ok(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is required for the anthropic live-smoke lane");
        config.providers.live = {
          type: "anthropic",
          model: process.env.SWARMVAULT_ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
          apiKeyEnv: "ANTHROPIC_API_KEY"
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

  await runStep("json-notice-suppression", async () => {
    const result = await runInstalledCliCommand("review-list-json", ["review", "list", "--json"], {
      cwd: workspaceDir
    });
    assert.equal(result.stderr.trim(), "", "interactive notices leaked into a --json command");
    JSON.parse(result.stdout);
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

    await runStep("add-url-capture", async () => {
      const server = await startFixtureServer({
        "/article": {
          contentType: "text/html; charset=utf-8",
          body: [
            "<html><head>",
            '<meta property="og:title" content="Research Article Capture" />',
            '<meta name="author" content="Ada Lovelace" />',
            '<meta property="article:published_time" content="2026-04-08T09:00:00Z" />',
            '<meta name="keywords" content="graphs, benchmarks" />',
            "</head><body>",
            "<article><p>Graph reports should explain why connections matter.</p></article>",
            "</body></html>"
          ].join("\n")
        },
        "/capture.md": {
          contentType: "text/plain; charset=utf-8",
          body: ["# Captured Link", "", "SwarmVault add falls back to generic URL ingest for unsupported URLs."].join("\n")
        }
      });
      try {
        const articleUrl = `${server.baseUrl}/article`;
        const article = await runCliJson(["add", articleUrl, "--contributor", "Smoke"]);
        assert.equal(article.captureType, "article", "article capture did not report article");
        assert.equal(article.fallback, false, "article capture unexpectedly fell back");
        const articleSource = await fs.readFile(path.join(workspaceDir, article.manifest.storedPath), "utf8");
        assert.ok(articleSource.includes("source_type: article"), "article capture did not record source_type");
        assert.ok(articleSource.includes("canonical_url:"), "article capture did not record canonical_url");
        assert.ok(articleSource.includes(articleUrl), "article capture did not preserve canonical_url");

        const result = await runCliJson(["add", `${server.baseUrl}/capture.md`, "--author", "Wayde"]);
        assert.equal(result.captureType, "url", "add fallback did not report url capture");
        assert.equal(result.fallback, true, "add fallback did not report fallback=true");
        await assertExists(path.join(workspaceDir, result.manifest.storedPath));
      } finally {
        await server.close();
      }
    });

    await runStep("mixed-corpus-extraction", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "vision-provider.mjs"),
        [
          "export async function createAdapter(id, config) {",
          "  return {",
          "    id,",
          "    type: 'custom',",
          "    model: config.model,",
          "    capabilities: new Set(config.capabilities ?? ['structured', 'vision']),",
          "    async generateText() {",
          "      return { text: 'vision-provider-text' };",
          "    },",
          "    async generateStructured(_request, schema) {",
          "      return schema.parse({",
          "        title: 'Smoke Diagram',",
          "        summary: 'The image shows a queue-backed workflow.',",
          "        text: 'Browser -> API -> Queue -> Worker',",
          "        concepts: [{ name: 'Queue', description: 'The visible queue between the API and worker.' }],",
          "        entities: [{ name: 'API', description: 'The visible API node.' }],",
          "        claims: [{ text: 'The workflow routes work through a queue.', confidence: 0.9, polarity: 'positive' }],",
          "        questions: ['What drains the queue?']",
          "      });",
          "    }",
          "  };",
          "}"
        ].join("\n"),
        "utf8"
      );

      await updateConfig((config) => {
        config.providers.visionTest = {
          type: "custom",
          model: "vision-test",
          module: "./vision-provider.mjs",
          capabilities: ["structured", "vision"]
        };
        config.tasks.visionProvider = "visionTest";
      });

      await fs.writeFile(path.join(workspaceDir, "diagram.png"), MINIMAL_PNG);
      await fs.writeFile(path.join(workspaceDir, "paper.pdf"), createSimplePdf("SwarmVault PDF extraction keeps documents searchable."));

      const imageManifest = await runCliJson(["ingest", "diagram.png"]);
      const pdfManifest = await runCliJson(["ingest", "paper.pdf"]);
      assert.ok(imageManifest.extractedMetadataPath, "image ingest did not record extraction metadata");
      assert.ok(imageManifest.extractedTextPath, "image ingest did not write extracted markdown");
      assert.ok(pdfManifest.extractedMetadataPath, "pdf ingest did not record extraction metadata");
      assert.ok(pdfManifest.extractedTextPath, "pdf ingest did not write extracted markdown");

      const imageArtifact = JSON.parse(await fs.readFile(path.join(workspaceDir, imageManifest.extractedMetadataPath), "utf8"));
      const pdfArtifact = JSON.parse(await fs.readFile(path.join(workspaceDir, pdfManifest.extractedMetadataPath), "utf8"));
      assert.equal(imageArtifact.extractor, "image_vision", "image extraction did not use the vision extractor");
      assert.equal(pdfArtifact.extractor, "pdf_text", "pdf extraction did not use the pdf extractor");
      assert.equal(pdfArtifact.pageCount, 1, "pdf extraction did not record the page count");

      const pdfExtract = await fs.readFile(path.join(workspaceDir, pdfManifest.extractedTextPath), "utf8");
      assert.ok(pdfExtract.includes("SwarmVault PDF extraction"), "pdf extraction did not preserve document text");

      await runCliJson(["compile"]);
      const imageAnalysis = JSON.parse(await fs.readFile(path.join(workspaceDir, "state", "analyses", `${imageManifest.sourceId}.json`), "utf8"));
      assert.ok(imageAnalysis.summary.includes("queue-backed workflow"), "image analysis did not use the vision extraction summary");
    });

    await runStep("tiny-language-matrix", async () => {
      const repoDir = path.join(workspaceDir, "tiny-matrix");
      await fs.cp(tinyMatrixFixtureDir, repoDir, { recursive: true });

      const ingest = await runCliJson(["ingest", repoDir, "--repo-root", repoDir]);
      assert.ok(Array.isArray(ingest.imported) && ingest.imported.length >= 10, "tiny matrix did not import the expected sources");

      await runCliJson(["compile"]);

      const manifestDir = path.join(workspaceDir, "state", "manifests");
      const manifests = await Promise.all(
        (await fs.readdir(manifestDir)).map(async (name) => JSON.parse(await fs.readFile(path.join(manifestDir, name), "utf8")))
      );
      const tinyManifests = manifests.filter((manifest) => manifest.originalPath?.includes("/tiny-matrix/"));
      const sourceKinds = new Set(tinyManifests.map((manifest) => manifest.sourceKind));
      for (const sourceKind of ["markdown", "text", "html", "pdf", "image", "code"]) {
        assert.ok(sourceKinds.has(sourceKind), `tiny matrix missing source kind ${sourceKind}`);
      }

      const codeIndex = JSON.parse(await fs.readFile(path.join(workspaceDir, "state", "code-index.json"), "utf8"));
      const tinySourceIds = new Set(tinyManifests.map((manifest) => manifest.sourceId));
      const indexedLanguages = new Set(
        codeIndex.entries
          .filter((entry) => tinySourceIds.has(entry.sourceId))
          .map((entry) => entry.language)
      );
      for (const language of [
        "javascript",
        "jsx",
        "typescript",
        "tsx",
        "python",
        "go",
        "rust",
        "java",
        "csharp",
        "c",
        "cpp",
        "php",
        "ruby",
        "powershell"
      ]) {
        assert.ok(indexedLanguages.has(language), `tiny matrix missing indexed language ${language}`);
      }

      const htmlManifest = tinyManifests.find((manifest) => manifest.repoRelativePath === "docs/page.html");
      assert.ok(htmlManifest?.extractedTextPath, "tiny matrix html file did not record extracted text");
      const htmlExtract = await fs.readFile(path.join(workspaceDir, htmlManifest.extractedTextPath), "utf8");
      assert.ok(htmlExtract.includes("Local HTML files should extract readable text before analysis."), "tiny matrix html extract was empty");

      const pdfManifest = tinyManifests.find((manifest) => manifest.repoRelativePath === "docs/paper.pdf");
      const pdfArtifact = JSON.parse(await fs.readFile(path.join(workspaceDir, pdfManifest.extractedMetadataPath), "utf8"));
      assert.equal(pdfArtifact.extractor, "pdf_text", "tiny matrix pdf did not use pdf_text extraction");
      const htmlSourcePagePath = path.join(workspaceDir, "wiki", "sources", `${htmlManifest.sourceId}.md`);
      const htmlSourcePage = await fs.readFile(htmlSourcePagePath, "utf8");
      assert.ok(htmlSourcePage.includes("Tiny HTML Source"), "tiny matrix source page did not include html title");
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

  await runStep("benchmark", async () => {
    const autoBenchmarkPath = path.join(workspaceDir, "state", "benchmark.json");
    await assertExists(autoBenchmarkPath);
    const autoBenchmark = JSON.parse(await fs.readFile(autoBenchmarkPath, "utf8"));
    assert.ok(autoBenchmark.graphHash, "compile did not write graphHash into benchmark.json");
    assert.ok(autoBenchmark.summary?.reductionRatio >= 0, "compile benchmark summary missing reduction ratio");

    const graphReportJsonPath = path.join(workspaceDir, "wiki", "graph", "report.json");
    await assertExists(graphReportJsonPath);
    const graphReportArtifact = JSON.parse(await fs.readFile(graphReportJsonPath, "utf8"));
    assert.equal(graphReportArtifact.benchmark?.stale, true, "graph report benchmark should go stale after query-save changes the graph");
    assert.ok(Array.isArray(graphReportArtifact.suggestedQuestions), "graph report did not include suggested questions");

    const result = await runCliJson(["benchmark", "--question", "How does this vault describe durable outputs?"]);
    assert.ok(result.avgQueryTokens > 0, "benchmark did not compute avgQueryTokens");
    const graphReport = await fs.readFile(path.join(workspaceDir, "wiki", "graph", "report.md"), "utf8");
    assert.ok(graphReport.includes("## Benchmark Summary"), "graph report did not include benchmark summary");
    assert.ok(graphReport.includes("## Suggested Questions"), "graph report did not include suggested questions");
    const refreshedGraphReportArtifact = JSON.parse(await fs.readFile(graphReportJsonPath, "utf8"));
    assert.equal(refreshedGraphReportArtifact.benchmark?.stale, false, "benchmark rerun did not refresh graph report freshness");
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

      await fs.mkdir(path.join(workspaceDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, ".gitignore"), "apps/alpha/vendor/\n", "utf8");
      await fs.mkdir(path.join(workspaceDir, "apps", "alpha", "src"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "apps", "alpha", "vendor"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "apps", "alpha", "Pods"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "apps", "alpha", "App.xcassets"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, "apps", "alpha", "dist"), { recursive: true });
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
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "helpers.py"),
        [
          "from util import format_label",
          "",
          "def render(name: str) -> str:",
          "    return format_label(name)"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "Widget.cs"),
        [
          "namespace Alpha.App;",
          "",
          "public interface IRenderable",
          "{",
          "    string Render();",
          "}",
          "",
          "public class Widget : IRenderable",
          "{",
          "    public string Render() => \"alpha\";",
          "}"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "widget.php"),
        [
          "<?php",
          "namespace Alpha\\\\App;",
          "",
          "interface Renderable {",
          "    public function render(): string;",
          "}",
          "",
          "class Widget implements Renderable {",
          "    public function render(): string {",
          "        return 'alpha';",
          "    }",
          "}"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "util.h"),
        [
          "#ifndef ALPHA_UTIL_H",
          "#define ALPHA_UTIL_H",
          "",
          "struct Renderable {",
          "  virtual const char* render() = 0;",
          "};",
          "",
          "#endif"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "main.c"),
        [
          '#include "util.h"',
          "",
          "int main(void) {",
          "  return 0;",
          "}"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "src", "main.cpp"),
        [
          '#include "util.h"',
          "",
          "class Widget : public Renderable {",
          "public:",
          "  const char* render() override {",
          '    return "alpha";',
          "  }",
          "};"
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(path.join(workspaceDir, "apps", "alpha", "Pods", "vendor.ts"), "export const vendorValue = 1;\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "apps", "alpha", "App.xcassets", "Reference.pdf"), createSimplePdf("Bundled PDF resource"));
      await fs.writeFile(path.join(workspaceDir, "apps", "alpha", "dist", "generated.js"), "console.log('generated');\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "apps", "alpha", "vendor", "ignored.py"), "print('ignored')\n", "utf8");

      const directoryIngest = await runCliJson(["ingest", "apps/alpha", "--repo-root", "."]);
      assert.ok(Array.isArray(directoryIngest.imported) && directoryIngest.imported.length >= 7, "directory ingest did not import the repo tree");
      assert.ok(
        Array.isArray(directoryIngest.skipped) &&
          directoryIngest.skipped.some(
            (entry) =>
              (entry.path.endsWith("apps/alpha/vendor") || entry.path.endsWith("apps/alpha/vendor/ignored.py")) &&
              (entry.reason === "gitignore" || entry.reason === "built_in_ignore:vendor")
          ),
        "directory ingest did not respect ignore rules"
      );
      assert.ok(
        Array.isArray(directoryIngest.skipped) &&
          directoryIngest.skipped.some(
            (entry) => entry.path.endsWith("apps/alpha/Pods/vendor.ts") && entry.reason === "source_class:third_party"
          ),
        "directory ingest did not classify Pods content as third-party"
      );
      assert.ok(
        Array.isArray(directoryIngest.skipped) &&
          directoryIngest.skipped.some(
            (entry) => entry.path.endsWith("apps/alpha/App.xcassets/Reference.pdf") && entry.reason === "source_class:resource"
          ),
        "directory ingest did not classify xcassets PDFs as resources"
      );
      assert.ok(
        Array.isArray(directoryIngest.skipped) &&
          directoryIngest.skipped.some(
            (entry) => entry.path.endsWith("apps/alpha/dist/generated.js") && entry.reason === "source_class:generated"
          ),
        "directory ingest did not classify build output as generated"
      );

      const expandedIngest = await runCliJson([
        "ingest",
        "apps/alpha",
        "--repo-root",
        ".",
        "--include-third-party",
        "--include-resources",
        "--include-generated"
      ]);
      const expandedByRepoPath = new Map(
        [...expandedIngest.imported, ...expandedIngest.updated].map((manifest) => [manifest.repoRelativePath, manifest])
      );
      assert.equal(expandedByRepoPath.get("apps/alpha/Pods/vendor.ts")?.sourceClass, "third_party", "expanded repo ingest did not retain the third-party source class");
      assert.equal(expandedByRepoPath.get("apps/alpha/App.xcassets/Reference.pdf")?.sourceClass, "resource", "expanded repo ingest did not retain the resource source class");
      assert.equal(expandedByRepoPath.get("apps/alpha/dist/generated.js")?.sourceClass, "generated", "expanded repo ingest did not retain the generated source class");

      const manifestByRepoPath = new Map(directoryIngest.imported.map((manifest) => [manifest.repoRelativePath, manifest]));
      const util = manifestByRepoPath.get("apps/alpha/src/util.ts");
      const widget = manifestByRepoPath.get("apps/alpha/src/widget.ts");
      const python = manifestByRepoPath.get("apps/alpha/src/helpers.py");
      const csharp = manifestByRepoPath.get("apps/alpha/src/Widget.cs");
      const php = manifestByRepoPath.get("apps/alpha/src/widget.php");
      const cSource = manifestByRepoPath.get("apps/alpha/src/main.c");
      const cppSource = manifestByRepoPath.get("apps/alpha/src/main.cpp");
      assert.ok(util && widget && python && csharp && php && cSource && cppSource, "directory ingest missed one or more expected code files");
      assert.equal(util.sourceKind, "code", "util ingest did not classify as code");
      assert.equal(util.language, "typescript", "util ingest did not classify as typescript");
      assert.equal(widget.sourceKind, "code", "widget ingest did not classify as code");

      await runCliJson(["compile"]);

      widgetModulePath = `code/${widget.sourceId}.md`;
      await assertExists(path.join(workspaceDir, "wiki", widgetModulePath));
      await assertExists(path.join(workspaceDir, "state", "code-index.json"));
      await assertExists(path.join(workspaceDir, "wiki", "projects", "index.md"));
      await assertExists(path.join(workspaceDir, "wiki", "projects", "alpha", "index.md"));
      const modulePage = await fs.readFile(path.join(workspaceDir, "wiki", widgetModulePath), "utf8");
      assert.ok(modulePage.includes("Repo Path: `apps/alpha/src/widget.ts`"), "module page did not include repo-relative path metadata");
      assert.ok(modulePage.includes("## Imports"), "module page did not include imports");
      assert.ok(modulePage.includes("formatLabel"), "module page did not include imported symbol");
      assert.ok(modulePage.includes(`[[code/${util.sourceId}|`), "module page did not link the resolved local import");

      for (const manifest of [python, csharp, php, cSource, cppSource]) {
        await assertExists(path.join(workspaceDir, "wiki", "code", `${manifest.sourceId}.md`));
      }

      const codeIndex = JSON.parse(await fs.readFile(path.join(workspaceDir, "state", "code-index.json"), "utf8"));
      assert.ok(Array.isArray(codeIndex.entries), "code-index did not contain entries");
      assert.ok(
        codeIndex.entries.some((entry) => entry.repoRelativePath === "apps/alpha/src/widget.ts" && entry.language === "typescript"),
        "code-index did not record the TypeScript widget module"
      );
      assert.ok(codeIndex.entries.some((entry) => entry.language === "python"), "code-index did not record the Python module");
      assert.ok(codeIndex.entries.some((entry) => entry.language === "csharp"), "code-index did not record the C# module");
      assert.ok(codeIndex.entries.some((entry) => entry.language === "php"), "code-index did not record the PHP module");
      assert.ok(codeIndex.entries.some((entry) => entry.language === "c"), "code-index did not record the C module");
      assert.ok(codeIndex.entries.some((entry) => entry.language === "cpp"), "code-index did not record the C++ module");

      const graphReportArtifact = JSON.parse(await fs.readFile(path.join(workspaceDir, "wiki", "graph", "report.json"), "utf8"));
      assert.ok(graphReportArtifact.firstPartyOverview.nodes < graphReportArtifact.overview.nodes, "graph report did not focus first-party content separately");
      assert.ok(graphReportArtifact.sourceClassBreakdown.third_party.sources > 0, "graph report did not count third-party sources");
      assert.ok(graphReportArtifact.sourceClassBreakdown.resource.sources > 0, "graph report did not count resource sources");
      assert.ok(graphReportArtifact.sourceClassBreakdown.generated.sources > 0, "graph report did not count generated sources");
      assert.ok(Array.isArray(graphReportArtifact.warnings) && graphReportArtifact.warnings.length > 0, "graph report did not emit large-repo/source-class warnings");

      const graphConfig = JSON.parse(await fs.readFile(path.join(workspaceDir, ".obsidian", "graph.json"), "utf8"));
      assert.ok(
        Array.isArray(graphConfig.colorGroups) && graphConfig.colorGroups.some((group) => group.query === "tag:#project/alpha"),
        "obsidian graph config did not include project tag colors"
      );
    });

    await runStep("semantic-graph-query", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "semantic-provider.mjs"),
        [
          "export async function createAdapter(id, config) {",
          "  function vectorFor(text) {",
          "    const normalized = String(text).toLowerCase();",
          "    if (normalized.includes('durable memory') || normalized.includes('persistent context') || normalized.includes('compounding memory')) {",
          "      return [1, 0, 0];",
          "    }",
          "    if (normalized.includes('review queue')) {",
          "      return [0, 1, 0];",
          "    }",
          "    return [0, 0, 1];",
          "  }",
          "  return {",
          "    id,",
          "    type: 'custom',",
          "    model: config.model,",
          "    capabilities: new Set(config.capabilities ?? ['chat', 'structured', 'embeddings']),",
          "    async generateText() { return { text: 'ok' }; },",
          "    async generateStructured(_request, schema) {",
          "      return schema.parse({",
          "        title: 'semantic',",
          "        summary: 'semantic',",
          "        concepts: [],",
          "        entities: [],",
          "        claims: [],",
          "        questions: []",
          "      });",
          "    },",
          "    async embedTexts(texts) {",
          "      return texts.map((text) => vectorFor(text));",
          "    }",
          "  };",
          "}"
        ].join("\n"),
        "utf8"
      );

      await updateConfig((config) => {
        config.providers.semanticTest = {
          type: "custom",
          model: "semantic-test",
          module: "./semantic-provider.mjs",
          capabilities: ["chat", "structured", "embeddings"]
        };
        config.tasks.embeddingProvider = "semanticTest";
      });

      await fs.writeFile(path.join(workspaceDir, "semantic-alpha.md"), "# Semantic Alpha\n\nDurable memory keeps agent context alive.\n", "utf8");
      await fs.writeFile(path.join(workspaceDir, "semantic-beta.md"), "# Semantic Beta\n\nPersistent context helps an agent resume prior work.\n", "utf8");
      await runCliJson(["ingest", "semantic-alpha.md"]);
      await runCliJson(["ingest", "semantic-beta.md"]);
      await runCliJson(["compile"]);

      await assertExists(path.join(workspaceDir, "state", "embeddings.json"));
      const graph = JSON.parse(await fs.readFile(path.join(workspaceDir, "state", "graph.json"), "utf8"));
      assert.ok(
        graph.edges.some((edge) => edge.relation === "semantically_similar_to" && edge.similarityBasis === "embeddings"),
        "compile did not record an embedding-backed similarity edge"
      );

      const semanticQuery = await runCliJson(["graph", "query", "compounding memory"]);
      assert.ok(
        Array.isArray(semanticQuery.pageIds) &&
          semanticQuery.pageIds.some((pageId) => pageId.startsWith("source:semantic-alpha-") || pageId.startsWith("source:semantic-beta-")) &&
          Array.isArray(semanticQuery.visitedEdgeIds) &&
          semanticQuery.visitedEdgeIds.some((edgeId) => edgeId.startsWith("similar-embed:")),
        "semantic graph query did not surface embedding-backed source pages and edges"
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
      const svgPath = path.join(exportDir, "graph.svg");
      const graphMlPath = path.join(exportDir, "graph.graphml");
      const cypherPath = path.join(exportDir, "graph.cypher");
      await fs.mkdir(exportDir, { recursive: true });
      const result = await runCliJson(["graph", "export", "--html", outputPath]);
      assert.equal(result.outputPath, outputPath, "graph export returned an unexpected output path");
      await assertExists(outputPath);
      const html = await fs.readFile(outputPath, "utf8");
      assert.ok(html.includes("data:"), "graph export did not embed local asset data");

      const svg = await runCliJson(["graph", "export", "--svg", svgPath]);
      const graphml = await runCliJson(["graph", "export", "--graphml", graphMlPath]);
      const cypher = await runCliJson(["graph", "export", "--cypher", cypherPath]);
      assert.equal(svg.outputPath, svgPath, "svg export returned an unexpected output path");
      assert.equal(graphml.outputPath, graphMlPath, "graphml export returned an unexpected output path");
      assert.equal(cypher.outputPath, cypherPath, "cypher export returned an unexpected output path");
      assert.ok((await fs.readFile(svgPath, "utf8")).includes("<svg"), "svg export did not contain svg markup");
      assert.ok((await fs.readFile(graphMlPath, "utf8")).includes("<graphml"), "graphml export did not contain graphml markup");
      assert.ok((await fs.readFile(cypherPath, "utf8")).includes("MERGE (n:SwarmNode"), "cypher export did not contain Cypher nodes");
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

      const watchStatus = await fetchJson(`http://127.0.0.1:${port}/api/watch-status`);
      assert.ok(Array.isArray(watchStatus.pendingSemanticRefresh), "watch-status API did not return pending semantic refresh entries");

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

    await runStep("watch-status", async () => {
      await fs.writeFile(
        path.join(workspaceDir, "apps", "alpha", "notes.md"),
        ["# Alpha Notes", "", "Repo watch should flag this for semantic refresh instead of auto-ingesting it."].join("\n"),
        "utf8"
      );
      const cycle = await runCliJson(["watch", "--repo", "--once"]);
      assert.ok(
        (cycle.pendingSemanticRefreshPaths ?? []).some((entry) => entry === "apps/alpha/notes.md"),
        "watch --repo --once did not report the pending semantic refresh path"
      );
      const status = await runCliJson(["watch", "status"]);
      assert.ok(Array.isArray(status.pendingSemanticRefresh), "watch status did not return pendingSemanticRefresh");
      assert.ok(
        status.pendingSemanticRefresh.some((entry) => entry.path === "apps/alpha/notes.md"),
        "watch status did not include the pending semantic refresh entry"
      );
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
      const codex = await runCliJson(["install", "--agent", "codex"]);
      const claude = await runCliJson(["install", "--agent", "claude"]);
      const opencode = await runCliJson(["install", "--agent", "opencode", "--hook"]);
      const gemini = await runCliJson(["install", "--agent", "gemini", "--hook"]);
      const copilot = await runCliJson(["install", "--agent", "copilot", "--hook"]);
      const aider = await runCliJson(["install", "--agent", "aider"]);

      assert.equal(codex.agent, "codex", "install command returned wrong codex agent");
      assert.equal(claude.agent, "claude", "install command returned wrong claude agent");
      assert.equal(opencode.agent, "opencode", "install command returned wrong opencode agent");
      assert.equal(gemini.agent, "gemini", "install command returned wrong gemini agent");
      assert.equal(copilot.agent, "copilot", "install command returned wrong copilot agent");
      assert.equal(aider.agent, "aider", "install command returned wrong aider agent");

      assert.equal(codex.target, path.join(workspaceDir, "AGENTS.md"), "codex target path mismatch");
      assert.equal(claude.target, path.join(workspaceDir, "CLAUDE.md"), "claude target path mismatch");
      assert.equal(opencode.target, path.join(workspaceDir, "AGENTS.md"), "opencode target path mismatch");
      assert.equal(gemini.target, path.join(workspaceDir, "GEMINI.md"), "gemini target path mismatch");
      assert.equal(copilot.target, path.join(workspaceDir, ".github", "copilot-instructions.md"), "copilot target path mismatch");
      assert.equal(aider.target, path.join(workspaceDir, "CONVENTIONS.md"), "aider target path mismatch");

      await assertExists(path.join(workspaceDir, "AGENTS.md"));
      await assertExists(path.join(workspaceDir, "CLAUDE.md"));
      await assertExists(path.join(workspaceDir, "GEMINI.md"));
      await assertExists(path.join(workspaceDir, "CONVENTIONS.md"));
      await assertExists(path.join(workspaceDir, ".gemini", "settings.json"));
      await assertExists(path.join(workspaceDir, ".gemini", "hooks", "swarmvault-graph-first.js"));
      await assertExists(path.join(workspaceDir, ".opencode", "plugins", "swarmvault-graph-first.js"));
      await assertExists(path.join(workspaceDir, ".github", "copilot-instructions.md"));
      await assertExists(path.join(workspaceDir, ".github", "hooks", "swarmvault-graph-first.json"));
      await assertExists(path.join(workspaceDir, ".github", "hooks", "swarmvault-graph-first.js"));
      await assertExists(path.join(workspaceDir, ".aider.conf.yml"));
      const agentsContent = await fs.readFile(path.join(workspaceDir, "AGENTS.md"), "utf8");
      const claudeContent = await fs.readFile(path.join(workspaceDir, "CLAUDE.md"), "utf8");
      const geminiContent = await fs.readFile(path.join(workspaceDir, "GEMINI.md"), "utf8");
      const copilotContent = await fs.readFile(path.join(workspaceDir, ".github", "copilot-instructions.md"), "utf8");
      const conventionsContent = await fs.readFile(path.join(workspaceDir, "CONVENTIONS.md"), "utf8");
      assert.ok(agentsContent.includes("# SwarmVault Rules"), "AGENTS.md missing managed rules");
      assert.ok(claudeContent.includes("# SwarmVault Rules"), "CLAUDE.md missing managed rules");
      assert.ok(geminiContent.includes("# SwarmVault Rules"), "GEMINI.md missing managed rules");
      assert.ok(copilotContent.includes("# SwarmVault Repository Instructions"), "copilot instructions missing managed rules");
      assert.ok(conventionsContent.includes("# SwarmVault Conventions"), "CONVENTIONS.md missing managed rules");
      assert.ok(Array.isArray(opencode.targets) && opencode.targets.includes(path.join(workspaceDir, ".opencode", "plugins", "swarmvault-graph-first.js")));
      assert.ok(Array.isArray(gemini.targets) && gemini.targets.includes(path.join(workspaceDir, ".gemini", "settings.json")));
      assert.ok(Array.isArray(copilot.targets) && copilot.targets.includes(path.join(workspaceDir, "AGENTS.md")));
      assert.ok(Array.isArray(aider.targets) && aider.targets.includes(path.join(workspaceDir, ".aider.conf.yml")));
    });

    await runStep("agent-clis", async () => {
      const prompt =
        "Reply with exactly two lines. First line: file=<workspace instruction file you used>. Second line: command=<one SwarmVault command recommended by that file>.";

      if (await commandOnPath("codex")) {
        const codexOutputPath = path.join(artifactDir, "codex-smoke.txt");
        await runCommand(
          "codex-agent-smoke",
          "codex",
          ["exec", "-C", workspaceDir, "--skip-git-repo-check", "-s", "workspace-write", "-o", codexOutputPath, prompt],
          {
            cwd: workspaceDir,
            env: inheritedEnv(),
            timeoutMs: 120_000
          }
        );
        const codexOutput = await fs.readFile(codexOutputPath, "utf8");
        assert.ok(codexOutput.includes("AGENTS.md"), "codex smoke did not use AGENTS.md");
        assert.ok(codexOutput.includes("swarmvault "), "codex smoke did not recommend a SwarmVault command");
      }

      if (await commandOnPath("claude") && process.env.ANTHROPIC_API_KEY) {
        const claudeResult = await runCommand(
          "claude-agent-smoke",
          "claude",
          [
            "-p",
            "--output-format",
            "text",
            "--permission-mode",
            "bypassPermissions",
            "--model",
            process.env.SWARMVAULT_CLAUDE_CODE_MODEL ?? "claude-sonnet-4-6",
            prompt
          ],
          {
            cwd: workspaceDir,
            env: inheritedEnv(),
            timeoutMs: 120_000
          }
        );
        assert.ok(claudeResult.stdout.includes("CLAUDE.md"), "claude smoke did not use CLAUDE.md");
        assert.ok(claudeResult.stdout.includes("swarmvault "), "claude smoke did not recommend a SwarmVault command");
      }

      if (await commandOnPath("opencode") && process.env.OLLAMA_API_KEY) {
        const opencodeModel = process.env.SWARMVAULT_OPENCODE_OLLAMA_MODEL ?? process.env.SWARMVAULT_OLLAMA_MODEL ?? "gpt-oss:20b-cloud";
        await fs.writeFile(
          path.join(workspaceDir, "opencode.json"),
          `${JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              provider: {
                ollama: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Ollama Cloud",
                  options: {
                    baseURL: process.env.SWARMVAULT_OLLAMA_BASE_URL ?? "https://ollama.com/v1",
                    apiKey: "{env:OLLAMA_API_KEY}"
                  },
                  models: {
                    [opencodeModel]: {
                      name: opencodeModel
                    }
                  }
                }
              }
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        const opencodePrompt =
          "Read AGENTS.md from the workspace and reply with exactly two lines. First line: file=AGENTS.md. Second line: command=<one swarmvault command that AGENTS.md recommends>.";
        const opencodeResult = await runCommand(
          "opencode-agent-smoke",
          "opencode",
          ["run", "--dir", workspaceDir, "--model", `ollama/${opencodeModel}`, opencodePrompt],
          {
            cwd: workspaceDir,
            env: inheritedEnv(),
            timeoutMs: 120_000
          }
        );
        const opencodeTranscript = `${opencodeResult.stdout}\n${opencodeResult.stderr}`;
        assert.ok(opencodeTranscript.includes("AGENTS.md"), "opencode smoke did not use AGENTS.md");
        assert.ok(opencodeTranscript.includes("swarmvault "), "opencode smoke did not recommend a SwarmVault command");
      }

      if (await commandOnPath("gemini") && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
        const geminiResult = await runCommand(
          "gemini-agent-smoke",
          "gemini",
          ["-p", "Read GEMINI.md from the workspace and reply with exactly two lines. First line: file=GEMINI.md. Second line: command=<one swarmvault command that GEMINI.md recommends>."],
          {
            cwd: workspaceDir
          }
        );
        const geminiTranscript = `${geminiResult.stdout}\n${geminiResult.stderr}`;
        assert.ok(geminiTranscript.includes("GEMINI.md"), "gemini smoke did not use GEMINI.md");
        assert.ok(geminiTranscript.includes("swarmvault "), "gemini smoke did not recommend a SwarmVault command");
      }
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

function createSimplePdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
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
  const normalizedLabel = label.replace(/[^a-z0-9._-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const truncatedLabel = normalizedLabel.slice(0, 80);
  const labelHash = createHash("sha1").update(label).digest("hex").slice(0, 10);
  const safeLabel = `${String(commandIndex).padStart(2, "0")}-${truncatedLabel || "command"}-${labelHash}`;
  const stdoutPath = path.join(logsDir, `${safeLabel}.stdout.log`);
  const stderrPath = path.join(logsDir, `${safeLabel}.stderr.log`);
  const metaPath = path.join(logsDir, `${safeLabel}.meta.json`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let timedOut = false;
  let terminateTimer = null;
  let killTimer = null;
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    terminateTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
    }, options.timeoutMs);
  }

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
  if (terminateTimer) {
    clearTimeout(terminateTimer);
  }
  if (killTimer) {
    clearTimeout(killTimer);
  }

  await Promise.all([
    fs.writeFile(stdoutPath, stdout, "utf8"),
    fs.writeFile(stderrPath, stderr, "utf8"),
    fs.writeFile(metaPath, JSON.stringify({ command, args, cwd: options.cwd ?? repoRoot, exit }, null, 2), "utf8")
  ]);

  if (exit.code !== 0) {
    const timeoutSuffix = timedOut ? " timed_out=true" : "";
    throw new Error(`Command failed (${command} ${args.join(" ")}): exit=${exit.code ?? "null"} signal=${exit.signal ?? "none"}${timeoutSuffix}`);
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

async function commandOnPath(name) {
  const pathValue = process.env.PATH ?? "";
  const entries = pathValue.split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const entry of entries) {
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `${name}${suffix}`);
      try {
        await fs.access(candidate);
        return true;
      } catch {}
    }
  }
  return false;
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
