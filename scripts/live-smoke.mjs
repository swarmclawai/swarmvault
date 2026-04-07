#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

await fs.mkdir(logsDir, { recursive: true });

try {
  await runStep("install-published-cli", async () => {
    await runCommand("npm-install", "npm", ["install", "-g", "--prefix", prefixDir, `@swarmvaultai/cli@${version}`], {
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
    await runStep("graph-serve", async () => {
      const port = await reservePort();
      graphServer = await startCliServer("graph-serve", ["graph", "serve", "--port", String(port)], workspaceDir);
      await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
        return Boolean(response?.ok);
      }, 10_000);
      const html = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
      const graph = await fetch(`http://127.0.0.1:${port}/api/graph`).then((response) => response.json());
      assert.ok(html.includes("<!doctype html") || html.includes("<html"), "graph viewer did not return HTML");
      assert.ok(Array.isArray(graph.nodes), "graph API did not return nodes");
      assert.ok(Array.isArray(graph.pages), "graph API did not return pages");
      await stopProcess(graphServer.child, graphServer.label);
      graphServer = undefined;
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

        const queryResult = await client.callTool({
          name: "query_vault",
          arguments: { question: "What is this vault about?", save: false }
        });
        const queryJson = JSON.parse(readToolText(queryResult));
        assert.ok(typeof queryJson.answer === "string" && queryJson.answer.length > 0, "MCP query returned no answer");
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
