#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const manifestPath = path.join(repoRoot, "validation", "oss-corpus.json");
const packageJsonPath = path.join(repoRoot, "packages", "cli", "package.json");
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;

await loadEnvFile(path.join(workspaceRoot, ".env.local"));
await loadEnvFile(path.join(repoRoot, ".env.local"));

const args = parseArgs(process.argv.slice(2));
const manifest = await readManifest(args.manifest ?? manifestPath);

if (args.list) {
  for (const repo of manifest.repos) {
    console.log(
      `${repo.id} gated=${repo.gated} category=${repo.category} repo=${repo.slug} commit=${repo.commit}${repo.canary ? " canary=true" : ""}`
    );
  }
  process.exit(0);
}

const lane = args.lane ?? "heuristic";
const version = args.version ?? (await readPackageVersion());
const installSpecs = args.installSpecs?.length ? args.installSpecs : [`@swarmvaultai/cli@${version}`];
const keepArtifacts = args.keepArtifacts ?? process.env.KEEP_OSS_CORPUS_ARTIFACTS === "1";
const artifactDir =
  args.artifactDir ??
  path.join(repoRoot, ".oss-corpus-artifacts", `${lane}-${new Date().toISOString().replaceAll(":", "-")}`);
const prefixDir = path.join(artifactDir, "global-prefix");
const npmCacheDir = path.join(artifactDir, "npm-cache");
const reposRootDir = path.join(artifactDir, "repos");
const summaryPath = path.join(artifactDir, "summary.json");
const summaryMarkdownPath = path.join(artifactDir, "summary.md");

const selectedRepos = selectRepos(manifest.repos, {
  ids: args.repos ?? [],
  includeCanary: args.includeCanary ?? false
});

if (!selectedRepos.length) {
  throw new Error("No OSS corpus repositories selected.");
}

const state = {
  lane,
  version,
  artifactDir,
  prefixDir,
  startedAt: new Date().toISOString(),
  repos: []
};

let installedCli;

await fs.mkdir(artifactDir, { recursive: true });
await fs.mkdir(npmCacheDir, { recursive: true });
await fs.mkdir(reposRootDir, { recursive: true });

try {
  await runStep("install-published-cli", async () => {
    console.log(`[oss-corpus] installing ${installSpecs.join(", ")} into ${prefixDir}`);
    await runCommand(
      path.join(artifactDir, "logs"),
      "npm-install",
      "npm",
      ["install", "-g", "--prefix", prefixDir, ...installSpecs],
      {
        cwd: artifactDir,
        env: {
          npm_config_cache: npmCacheDir,
          npm_config_update_notifier: "false",
          npm_config_audit: "false",
          npm_config_fund: "false"
        },
        timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS
      }
    );
    installedCli = await resolveInstalledCli(prefixDir);
    const versionResult = await runInstalledCliCommand("cli-version", ["--version"], {
      cwd: artifactDir,
      logsDir: path.join(artifactDir, "logs"),
      timeoutMs: 15_000
    });
    assert.equal(versionResult.stdout.trim(), version, "installed CLI version mismatch");
  });

  for (const repo of selectedRepos) {
    const repoArtifactDir = path.join(reposRootDir, repo.id);
    const repoLogsDir = path.join(repoArtifactDir, "logs");
    const cloneDir = path.join(repoArtifactDir, "clone");
    const vaultDir = path.join(repoArtifactDir, "vault");
    const exportsDir = path.join(vaultDir, "exports");
    const repoSummaryPath = path.join(repoArtifactDir, "result.json");
    const repoSummaryMarkdownPath = path.join(repoArtifactDir, "result.md");
    await fs.mkdir(repoLogsDir, { recursive: true });
    await fs.mkdir(exportsDir, { recursive: true });

    const result = {
      id: repo.id,
      slug: repo.slug,
      category: repo.category,
      gated: repo.gated,
      canary: repo.canary ?? false,
      commit: repo.commit,
      cloneDir,
      vaultDir,
      exportPath: path.join(exportsDir, `${repo.id}.html`),
      status: "passed",
      startedAt: new Date().toISOString()
    };

    try {
      console.log(`[oss-corpus][${repo.id}] cloning ${repo.slug}@${repo.commit.slice(0, 12)}`);
      await clonePinnedRepo(repo, cloneDir, repoLogsDir);

      console.log(`[oss-corpus][${repo.id}] init`);
      await runInstalledCliCommand(`${repo.id}-init`, ["--json", "init"], {
        cwd: vaultDir,
        logsDir: repoLogsDir,
        timeoutMs: 30_000
      });

      if (lane !== "heuristic") {
        await configureProviderLane(vaultDir, lane);
      }

      const repoInputPath = repo.subdir ? path.join(cloneDir, repo.subdir) : cloneDir;
      const ingestArgs = ["--json", "ingest", repoInputPath, "--repo-root", cloneDir, ...(repo.ingestArgs ?? [])];
      console.log(`[oss-corpus][${repo.id}] ingest ${repoInputPath}`);
      const ingest = JSON.parse(
        (await runInstalledCliCommand(`${repo.id}-ingest`, ingestArgs, { cwd: vaultDir, logsDir: repoLogsDir, timeoutMs: DEFAULT_TIMEOUT_MS }))
          .stdout
      );
      assert.ok(
        Array.isArray(ingest.imported) ||
          Array.isArray(ingest.created) ||
          Array.isArray(ingest.updated) ||
          Array.isArray(ingest.unchanged) ||
          typeof ingest.sourceId === "string",
        "ingest did not return a manifest payload"
      );

      console.log(`[oss-corpus][${repo.id}] compile`);
      const compile = JSON.parse(
        (
          await runInstalledCliCommand(`${repo.id}-compile`, ["--json", "compile"], {
            cwd: vaultDir,
            logsDir: repoLogsDir,
            timeoutMs: repo.compileTimeoutMs ?? DEFAULT_TIMEOUT_MS
          })
        ).stdout
      );
      console.log(`[oss-corpus][${repo.id}] benchmark`);
      const benchmark = JSON.parse(
        (
          await runInstalledCliCommand(
            `${repo.id}-benchmark`,
            ["--json", "benchmark", "--question", repo.prompts.graph],
            { cwd: vaultDir, logsDir: repoLogsDir, timeoutMs: 60_000 }
          )
        ).stdout
      );
      console.log(`[oss-corpus][${repo.id}] graph query`);
      const graphQuery = JSON.parse(
        (
          await runInstalledCliCommand(
            `${repo.id}-graph-query`,
            ["--json", "graph", "query", repo.prompts.graph],
            { cwd: vaultDir, logsDir: repoLogsDir, timeoutMs: 60_000 }
          )
        ).stdout
      );
      console.log(`[oss-corpus][${repo.id}] query`);
      const query = JSON.parse(
        (
          await runInstalledCliCommand(`${repo.id}-query`, ["--json", "query", repo.prompts.query], {
            cwd: vaultDir,
            logsDir: repoLogsDir,
            timeoutMs: 60_000
          })
        ).stdout
      );
      console.log(`[oss-corpus][${repo.id}] graph export`);
      const exportResult = JSON.parse(
        (
          await runInstalledCliCommand(
            `${repo.id}-graph-export`,
            ["--json", "graph", "export", "--html", result.exportPath],
            { cwd: vaultDir, logsDir: repoLogsDir, timeoutMs: 60_000 }
          )
        ).stdout
      );

      const graph = await readJson(path.join(vaultDir, "state", "graph.json"));
      const report = await readJson(path.join(vaultDir, "wiki", "graph", "report.json"));
      const benchmarkArtifact = await readJson(path.join(vaultDir, "state", "benchmark.json"));

      const counts = summarizeGraph(graph);
      const graphQueryPages = graphQuery.pageIds
        .map((pageId) => graph.pages.find((page) => page.id === pageId))
        .filter((page) => Boolean(page));

      applyAssertions(repo, {
        compile,
        benchmark,
        benchmarkArtifact,
        graph,
        report,
        counts,
        graphQuery,
        graphQueryPages,
        query,
        exportResult
      });

      Object.assign(result, {
        status: "passed",
        finishedAt: new Date().toISOString(),
        counts,
        compile,
        benchmark: {
          corpusTokens: benchmark.corpusTokens,
          avgQueryTokens: benchmark.avgQueryTokens,
          reductionRatio: benchmark.reductionRatio,
          questionCount: benchmark.sampleQuestions?.length ?? 0
        },
        graphQuery: {
          pageCount: graphQuery.pageIds.length,
          nodeCount: graphQuery.visitedNodeIds.length,
          edgeCount: graphQuery.visitedEdgeIds.length,
          pagePaths: graphQueryPages.map((page) => page.path),
          summary: graphQuery.summary
        },
        query: {
          citations: query.citations.length,
          savedPath: query.savedPath,
          answerPreview: truncate(normalizeWhitespace(query.answer), 220)
        }
      });
      console.log(`[oss-corpus][${repo.id}] passed`);
    } catch (error) {
      result.status = repo.gated ? "failed" : "canary_failed";
      result.finishedAt = new Date().toISOString();
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`[oss-corpus][${repo.id}] ${result.status}: ${result.error}`);
    }

    await fs.mkdir(repoArtifactDir, { recursive: true });
    await fs.writeFile(repoSummaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    await fs.writeFile(repoSummaryMarkdownPath, renderRepoResultMarkdown(result), "utf8");
    state.repos.push(result);
  }

  const gatedFailures = state.repos.filter((repo) => repo.gated && repo.status !== "passed");
  const summary = {
    ...state,
    finishedAt: new Date().toISOString(),
    status: gatedFailures.length ? "failed" : "passed"
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(summaryMarkdownPath, renderSummaryMarkdown(summary), "utf8");

  if (gatedFailures.length) {
    throw new Error(`OSS corpus validation failed for: ${gatedFailures.map((repo) => repo.id).join(", ")}`);
  }

  console.log(`[oss-corpus] ${lane} corpus passed for @swarmvaultai/cli@${version}`);
  console.log(`[oss-corpus] kept artifacts at ${artifactDir}`);
} catch (error) {
  const summary = {
    ...state,
    finishedAt: new Date().toISOString(),
    status: "failed",
    error: error instanceof Error ? error.message : String(error)
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(summaryMarkdownPath, renderSummaryMarkdown(summary), "utf8");
  console.error(`[oss-corpus] ${lane} corpus failed. Artifacts kept at ${artifactDir}`);
  throw error;
} finally {
  if (!keepArtifacts) {
    const hasFailures = state.repos.some((repo) => repo.status !== "passed");
    if (!hasFailures) {
      await fs.rm(artifactDir, { recursive: true, force: true });
    }
  }
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
    if (value === "--install-spec") {
      parsed.installSpecs ??= [];
      parsed.installSpecs.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--repo") {
      parsed.repos ??= [];
      parsed.repos.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--manifest") {
      parsed.manifest = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--include-canary") {
      parsed.includeCanary = true;
      continue;
    }
    if (value === "--keep-artifacts") {
      parsed.keepArtifacts = true;
      continue;
    }
    if (value === "--list") {
      parsed.list = true;
    }
  }
  return parsed;
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

async function readPackageVersion() {
  const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  return pkg.version;
}

async function readManifest(filePath) {
  const manifest = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.equal(manifest.version, 1, "Unsupported OSS corpus manifest version.");
  assert.ok(Array.isArray(manifest.repos) && manifest.repos.length > 0, "OSS corpus manifest must define repos.");
  for (const repo of manifest.repos) {
    assert.ok(typeof repo.id === "string" && repo.id.length > 0, "Each repo needs an id.");
    assert.ok(typeof repo.slug === "string" && repo.slug.length > 0, `Repo ${repo.id} needs a slug.`);
    assert.ok(typeof repo.cloneUrl === "string" && repo.cloneUrl.length > 0, `Repo ${repo.id} needs a cloneUrl.`);
    assert.ok(/^[0-9a-f]{40}$/u.test(repo.commit), `Repo ${repo.id} must pin a 40-char commit SHA.`);
    assert.ok(repo.prompts?.graph && repo.prompts?.query, `Repo ${repo.id} must define graph and query prompts.`);
  }
  return manifest;
}

function selectRepos(repos, options) {
  const requestedIds = new Set(options.ids ?? []);
  if (requestedIds.size > 0) {
    return repos.filter((repo) => requestedIds.has(repo.id));
  }
  return repos.filter((repo) => repo.gated || options.includeCanary);
}

async function runStep(_name, fn) {
  return await fn();
}

async function clonePinnedRepo(repo, cloneDir, logsDir) {
  await fs.rm(cloneDir, { recursive: true, force: true });
  await runCommand(logsDir, `${repo.id}-git-init`, "git", ["init", cloneDir], { cwd: artifactDirFor(cloneDir), timeoutMs: 15_000 });
  await runCommand(logsDir, `${repo.id}-git-remote`, "git", ["remote", "add", "origin", repo.cloneUrl], {
    cwd: cloneDir,
    timeoutMs: 15_000
  });
  await runCommand(logsDir, `${repo.id}-git-fetch`, "git", ["fetch", "--depth", "1", "origin", repo.commit], {
    cwd: cloneDir,
    timeoutMs: 60_000
  });
  await runCommand(logsDir, `${repo.id}-git-checkout`, "git", ["-c", "advice.detachedHead=false", "checkout", "--detach", "FETCH_HEAD"], {
    cwd: cloneDir,
    timeoutMs: 15_000
  });
}

function artifactDirFor(targetPath) {
  return path.dirname(targetPath);
}

async function configureProviderLane(vaultDir, lane) {
  const configPath = path.join(vaultDir, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (lane === "openai") {
    assert.ok(process.env.OPENAI_API_KEY, "OPENAI_API_KEY is required for the openai corpus lane");
    config.providers.live = {
      type: "openai",
      model: process.env.SWARMVAULT_OPENAI_MODEL ?? "gpt-4.1-mini",
      apiKeyEnv: "OPENAI_API_KEY"
    };
  } else if (lane === "ollama") {
    assert.ok(process.env.OLLAMA_API_KEY, "OLLAMA_API_KEY is required for the ollama corpus lane");
    config.providers.live = {
      type: "ollama",
      model: process.env.SWARMVAULT_OLLAMA_MODEL ?? "gpt-oss:20b-cloud",
      apiKeyEnv: "OLLAMA_API_KEY",
      baseUrl: process.env.SWARMVAULT_OLLAMA_BASE_URL ?? "https://ollama.com/v1",
      apiStyle: process.env.SWARMVAULT_OLLAMA_API_STYLE ?? "chat"
    };
  } else if (lane === "anthropic") {
    assert.ok(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is required for the anthropic corpus lane");
    config.providers.live = {
      type: "anthropic",
      model: process.env.SWARMVAULT_ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      apiKeyEnv: "ANTHROPIC_API_KEY"
    };
  } else {
    throw new Error(`Unsupported corpus lane: ${lane}`);
  }
  config.tasks = {
    ...(config.tasks ?? {}),
    compileProvider: "live",
    queryProvider: "live",
    lintProvider: "live",
    visionProvider: "live"
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function summarizeGraph(graph) {
  const pageKindCounts = Object.create(null);
  for (const page of graph.pages ?? []) {
    pageKindCounts[page.kind] = (pageKindCounts[page.kind] ?? 0) + 1;
  }
  return {
    sourceCount: graph.sources?.length ?? 0,
    pageCount: graph.pages?.length ?? 0,
    nodeCount: graph.nodes?.length ?? 0,
    edgeCount: graph.edges?.length ?? 0,
    modulePageCount: pageKindCounts.module ?? 0,
    sourcePageCount: pageKindCounts.source ?? 0,
    graphReportCount: pageKindCounts.graph_report ?? 0,
    communitySummaryCount: pageKindCounts.community_summary ?? 0
  };
}

function applyAssertions(repo, input) {
  const assertions = repo.assertions ?? {};
  assert.ok(input.compile.sourceCount >= (assertions.minSources ?? 1), `${repo.id}: sourceCount below expected minimum`);
  assert.ok(input.compile.pageCount >= (assertions.minPages ?? 1), `${repo.id}: pageCount below expected minimum`);
  assert.ok(input.counts.modulePageCount >= (assertions.minModulePages ?? 0), `${repo.id}: module page count below expected minimum`);
  assert.ok(input.counts.sourcePageCount >= (assertions.minSourcePages ?? 0), `${repo.id}: source page count below expected minimum`);
  assert.ok(
    (input.report.sourceClassBreakdown?.first_party?.sources ?? 0) >= (assertions.expectedFirstPartySourceMin ?? 1),
    `${repo.id}: first-party source count below expected minimum`
  );
  assert.ok(Array.isArray(input.benchmark.sampleQuestions) && input.benchmark.sampleQuestions.length > 0, `${repo.id}: benchmark produced no questions`);
  assert.ok(input.benchmarkArtifact.summary?.uniqueVisitedNodes >= 1, `${repo.id}: benchmark visited no nodes`);
  assert.ok(Array.isArray(input.graphQuery.pageIds) && input.graphQuery.pageIds.length > 0, `${repo.id}: graph query returned no pages`);
  if (Array.isArray(assertions.expectedGraphQueryKinds) && assertions.expectedGraphQueryKinds.length > 0) {
    const matchedKinds = new Set(input.graphQueryPages.map((page) => page.kind));
    assert.ok(
      assertions.expectedGraphQueryKinds.some((kind) => matchedKinds.has(kind)),
      `${repo.id}: graph query did not touch the expected page kinds`
    );
  }
  assert.ok(typeof input.query.answer === "string" && input.query.answer.trim().length > 0, `${repo.id}: query answer was empty`);
  assert.ok(input.query.citations.length >= (assertions.expectedQueryCitationMin ?? 1), `${repo.id}: query produced too few citations`);
  assert.ok(typeof input.query.savedPath === "string" && input.query.savedPath.length > 0, `${repo.id}: query did not save an output page`);
  assert.ok(Array.isArray(input.report.surprisingConnections), `${repo.id}: report.json is missing surprisingConnections`);
  assert.ok(Array.isArray(input.report.groupPatterns), `${repo.id}: report.json is missing groupPatterns`);
  assert.ok(typeof input.exportResult.outputPath === "string" && input.exportResult.outputPath.length > 0, `${repo.id}: export did not return outputPath`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function runInstalledCliCommand(label, args, options = {}) {
  assert.ok(installedCli, "installed CLI has not been resolved yet");
  return runCommand(options.logsDir, label, installedCli.command, [...installedCli.args, ...args], options);
}

async function runCommand(logsDir, label, command, args, options = {}) {
  await fs.mkdir(logsDir, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9._-]+/gi, "-");
  const stdoutPath = path.join(logsDir, `${safeLabel}.stdout.log`);
  const stderrPath = path.join(logsDir, `${safeLabel}.stderr.log`);
  const metaPath = path.join(logsDir, `${safeLabel}.meta.json`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ? { ...process.env, ...options.env } : process.env,
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

  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
  }, timeoutMs);

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);

  await Promise.all([
    fs.writeFile(stdoutPath, stdout, "utf8"),
    fs.writeFile(stderrPath, stderr, "utf8"),
    fs.writeFile(metaPath, JSON.stringify({ command, args, cwd: options.cwd ?? repoRoot, timeoutMs, timedOut, exit }, null, 2), "utf8")
  ]);

  if (timedOut) {
    throw new Error(`Command timed out after ${timeoutMs}ms (${command} ${args.join(" ")})`);
  }
  if (exit.code !== 0) {
    throw new Error(`Command failed (${command} ${args.join(" ")}): exit=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`);
  }

  return { stdout, stderr };
}

async function resolveInstalledCli(prefix) {
  const binPath = process.platform === "win32" ? path.join(prefix, "swarmvault.cmd") : path.join(prefix, "bin", "swarmvault");
  await fs.access(binPath);
  if (process.platform === "win32") {
    return { command: binPath, args: [] };
  }
  const realPath = await fs.realpath(binPath).catch(() => binPath);
  return { command: process.execPath, args: [realPath] };
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function renderRepoResultMarkdown(result) {
  return [
    `# ${result.slug}`,
    "",
    `- Status: ${result.status}`,
    `- Category: ${result.category}`,
    `- Commit: ${result.commit}`,
    ...(result.error ? [`- Error: ${result.error}`] : []),
    ...(result.counts
      ? [
          `- Sources: ${result.counts.sourceCount}`,
          `- Pages: ${result.counts.pageCount}`,
          `- Module Pages: ${result.counts.modulePageCount}`,
          `- Source Pages: ${result.counts.sourcePageCount}`,
          `- Nodes: ${result.counts.nodeCount}`,
          `- Edges: ${result.counts.edgeCount}`
        ]
      : []),
    ...(result.graphQuery
      ? [
          `- Graph Query Pages: ${result.graphQuery.pageCount}`,
          `- Graph Query Nodes: ${result.graphQuery.nodeCount}`,
          `- Query Citations: ${result.query.citations}`
        ]
      : []),
    ""
  ].join("\n");
}

function renderSummaryMarkdown(summary) {
  const lines = [
    "# OSS Corpus Validation",
    "",
    `- Lane: ${summary.lane}`,
    `- Version: ${summary.version}`,
    `- Status: ${summary.status}`,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt ?? "n/a"}`,
    ...(summary.error ? [`- Error: ${summary.error}`] : []),
    "",
    "| Repo | Status | Sources | Pages | Modules | Graph Query Pages | Query Citations |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const repo of summary.repos ?? []) {
    lines.push(
      `| ${repo.id} | ${repo.status} | ${repo.counts?.sourceCount ?? 0} | ${repo.counts?.pageCount ?? 0} | ${repo.counts?.modulePageCount ?? 0} | ${repo.graphQuery?.pageCount ?? 0} | ${repo.query?.citations ?? 0} |`
    );
  }
  lines.push("", `Artifacts: \`${summary.artifactDir}\``);
  return `${lines.join("\n")}\n`;
}
