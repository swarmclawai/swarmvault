#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const cliSourcePath = path.join(repoRoot, "packages", "cli", "src", "index.ts");
const defaultCliPath = path.join(repoRoot, "packages", "cli", "dist", "index.js");

const SURFACE_MANIFEST = {
  add: "behavior",
  benchmark: "behavior",
  candidate: "help",
  "candidate archive": "help",
  "candidate auto-promote": "behavior",
  "candidate list": "behavior",
  "candidate preview-scores": "behavior",
  "candidate promote": "help",
  "check-update": "behavior",
  clone: "behavior",
  "cluster-only": "behavior",
  compile: "behavior",
  consolidate: "behavior",
  context: "help",
  "context build": "behavior",
  "context delete": "behavior",
  "context list": "behavior",
  "context show": "behavior",
  demo: "help",
  diff: "help",
  doctor: "behavior",
  explore: "help",
  graph: "help",
  "graph blast": "behavior",
  "graph cluster": "behavior",
  "graph clusters": "alias",
  "graph explain": "behavior",
  "graph export": "behavior",
  "graph god-nodes": "behavior",
  "graph merge": "behavior",
  "graph path": "behavior",
  "graph push": "help",
  "graph push neo4j": "external",
  "graph query": "behavior",
  "graph refresh": "alias",
  "graph serve": "long-running",
  "graph share": "behavior",
  "graph stats": "behavior",
  "graph status": "behavior",
  "graph supersession": "help",
  "graph tree": "behavior",
  "graph update": "behavior",
  "graph validate": "behavior",
  hook: "help",
  "hook install": "git-mutating",
  "hook status": "behavior",
  "hook uninstall": "git-mutating",
  inbox: "help",
  "inbox import": "behavior",
  ingest: "behavior",
  init: "behavior",
  install: "behavior",
  lint: "behavior",
  "merge-graphs": "behavior",
  mcp: "long-running",
  memory: "help",
  "memory finish": "behavior",
  "memory list": "behavior",
  "memory resume": "behavior",
  "memory show": "behavior",
  "memory start": "behavior",
  "memory update": "behavior",
  migrate: "behavior",
  provider: "help",
  "provider setup": "behavior",
  query: "behavior",
  retrieval: "help",
  "retrieval doctor": "behavior",
  "retrieval rebuild": "behavior",
  "retrieval status": "behavior",
  review: "help",
  "review accept": "help",
  "review list": "behavior",
  "review reject": "help",
  "review show": "help",
  scan: "behavior",
  schedule: "help",
  "schedule list": "behavior",
  "schedule run": "help",
  "schedule serve": "long-running",
  source: "help",
  "source add": "behavior",
  "source delete": "behavior",
  "source guide": "behavior",
  "source list": "behavior",
  "source reload": "behavior",
  "source review": "behavior",
  "source session": "behavior",
  task: "help",
  "task finish": "behavior",
  "task list": "behavior",
  "task resume": "behavior",
  "task show": "behavior",
  "task start": "behavior",
  "task update": "behavior",
  tree: "behavior",
  update: "behavior",
  watch: "long-running",
  "watch add-root": "behavior",
  "watch list-roots": "behavior",
  "watch remove-root": "behavior",
  "watch status": "behavior",
  "watch-status": "behavior"
};

const args = parseArgs(process.argv.slice(2));
const cliPath = args.cli ? path.resolve(args.cli) : defaultCliPath;
const tempDirs = [];
const summary = {
  cliPath,
  commandCount: 0,
  helpChecks: 0,
  behaviorChecks: []
};

try {
  const discovered = discoverCommanderSurface(cliSourcePath);
  const manifestPaths = Object.keys(SURFACE_MANIFEST).sort();
  assert.deepEqual(
    discovered.paths,
    manifestPaths,
    [
      "CLI surface manifest drifted from parser-backed Commander discovery.",
      `Discovered only: ${discovered.paths.filter((item) => !SURFACE_MANIFEST[item]).join(", ") || "none"}`,
      `Manifest only: ${manifestPaths.filter((item) => !discovered.paths.includes(item)).join(", ") || "none"}`
    ].join("\n")
  );

  await assertExecutableCli(cliPath);
  await runCli(["--help"], { cwd: repoRoot, label: "root-help" });
  await runCli(["--version"], { cwd: repoRoot, label: "root-version" });
  for (const commandPath of discovered.paths) {
    await runCli([...commandPath.split(" "), "--help"], {
      cwd: repoRoot,
      label: `help:${commandPath}`
    });
    summary.helpChecks += 1;
  }

  summary.commandCount = discovered.paths.length;
  await runBehaviorSmoke();
  console.log(
    `[cli-surface-smoke] passed ${summary.commandCount} command-surface checks and ${summary.behaviorChecks.length} direct behavior checks`
  );
  if (args.summary) {
    await fs.mkdir(path.dirname(path.resolve(args.summary)), { recursive: true });
    await fs.writeFile(path.resolve(args.summary), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
} finally {
  if (!args.keepArtifacts) {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  } else if (tempDirs.length) {
    console.log(`[cli-surface-smoke] kept artifacts:\n${tempDirs.join("\n")}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    keepArtifacts: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    } else if (token === "--cli") {
      parsed.cli = argv[index + 1];
      index += 1;
    } else if (token === "--summary") {
      parsed.summary = argv[index + 1];
      index += 1;
    } else if (token === "--keep-artifacts") {
      parsed.keepArtifacts = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return parsed;
}

function discoverCommanderSurface(sourcePath) {
  const sourceText = require("node:fs").readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const variablePaths = new Map([["program", []]]);
  const commandPaths = new Map();
  const aliases = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const expressionCommandPath = pathFromExpression(node.initializer);
      if (expressionCommandPath) {
        variablePaths.set(node.name.text, expressionCommandPath);
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      if (methodName === "command") {
        const expressionCommandPath = pathFromExpression(node);
        if (expressionCommandPath?.length) {
          commandPaths.set(expressionCommandPath.join(" "), expressionCommandPath);
        }
      } else if (methodName === "alias") {
        const canonicalPath = pathFromExpression(node.expression.expression);
        const aliasName = firstStringArgument(node);
        if (canonicalPath?.length && aliasName) {
          const aliasPath = [...canonicalPath.slice(0, -1), commandToken(aliasName)];
          aliases.set(aliasPath.join(" "), aliasPath);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  function pathFromExpression(expression) {
    if (ts.isIdentifier(expression)) {
      return variablePaths.get(expression.text) ?? null;
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression)) {
      return pathFromExpression(expression.expression);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return pathFromExpression(expression.expression);
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
      const methodName = expression.expression.name.text;
      const ownerPath = pathFromExpression(expression.expression.expression);
      if (methodName === "command") {
        const spec = firstStringArgument(expression);
        if (!ownerPath || !spec) {
          return null;
        }
        return [...ownerPath, commandToken(spec)];
      }
      return ownerPath;
    }
    return null;
  }

  visit(sourceFile);

  const paths = [...commandPaths.keys(), ...aliases.keys()].sort();
  return { paths };
}

function firstStringArgument(callExpression) {
  const first = callExpression.arguments[0];
  if (!first) return null;
  if (ts.isStringLiteralLike(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return null;
}

function commandToken(spec) {
  return String(spec).trim().split(/\s+/u)[0];
}

async function assertExecutableCli(targetPath) {
  await fs.access(targetPath);
}

async function runBehaviorSmoke() {
  const workspaceDir = await makeTempDir("swarmvault-cli-surface-workspace-");
  const sourceDir = path.join(workspaceDir, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "notes.md"),
    [
      "# Durable Output Notes",
      "",
      "SwarmVault should preserve durable outputs, graph paths, and task handoffs.",
      "",
      "NOTE: parser-backed checks keep the CLI surface honest."
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(sourceDir, "app.ts"),
    [
      "export function durableOutput(name: string): string {",
      "  return `durable:${name}`;",
      "}",
      "",
      "export function renderOutput(): string {",
      "  return durableOutput('graph');",
      "}"
    ].join("\n"),
    "utf8"
  );

  const init = await runJson(["init"], workspaceDir);
  assert.ok(init.rootDir || init.paths, "init JSON did not describe the initialized workspace");

  const ingested = await runJson(["ingest", sourceDir, "--repo-root", sourceDir], workspaceDir);
  assert.ok(Array.isArray(ingested.imported) && ingested.imported.length >= 2, "ingest did not import the smoke sources");

  const compiled = await runJson(["compile"], workspaceDir);
  assert.ok(compiled.sourceCount >= 2, "compile did not report the smoke sources");

  await runJsonCheck(["query", "What does the vault say about durable outputs?", "--no-save"], workspaceDir, "query", (result) => {
    assert.ok(typeof result.answer === "string" && result.answer.length > 0, "query returned no answer");
  });
  await runJsonCheck(["lint"], workspaceDir, "lint", (result) => assert.ok(Array.isArray(result), "lint did not return an array"));
  await runJsonCheck(["benchmark", "--question", "durable outputs"], workspaceDir, "benchmark", (result) => {
    assert.ok(Number.isFinite(result.avgQueryTokens), "benchmark did not return token stats");
  });
  await runJsonCheck(["consolidate", "--dry-run"], workspaceDir, "consolidate", (result) => {
    assert.ok(Array.isArray(result.decisions), "consolidate --dry-run did not return decisions");
  });

  const contextPack = await runJson(["context", "build", "Map durable output flow", "--target", "Durable", "--budget", "900"], workspaceDir);
  const contextPackId = contextPack.pack?.id;
  assert.ok(contextPackId, "context build did not create a context pack id");
  await runJsonCheck(["context", "list"], workspaceDir, "context list", (result) => {
    assert.ok(result.some((entry) => entry.id === contextPackId), "context list did not include the created pack");
  });
  await runJsonCheck(["context", "show", contextPackId], workspaceDir, "context show", (result) => {
    assert.equal(result.id, contextPackId, "context show returned the wrong pack");
  });

  const task = await runJson(["task", "start", "Prove CLI task surfaces", "--context-pack", contextPackId, "--agent", "surface-smoke"], workspaceDir);
  assert.ok(task.task?.id, "task start did not create a task id");
  await runJson(["task", "update", task.task.id, "--note", "direct CLI surface smoke", "--changed-path", "scripts/cli-surface-smoke.mjs"], workspaceDir);
  await runJsonCheck(["task", "show", task.task.id], workspaceDir, "task show", (result) => {
    assert.equal(result.id, task.task.id, "task show returned the wrong task");
  });
  await runJsonCheck(["task", "resume", task.task.id, "--format", "json"], workspaceDir, "task resume", (result) => {
    assert.equal(result.task.id, task.task.id, "task resume returned the wrong task");
  });
  await runJson(["task", "finish", task.task.id, "--outcome", "CLI surfaces exercised"], workspaceDir);
  await runJsonCheck(["task", "list"], workspaceDir, "task list", (result) => {
    assert.ok(result.some((entry) => entry.id === task.task.id), "task list did not include the finished task");
  });

  const memory = await runJson(["memory", "start", "Prove memory compatibility surface", "--context-pack", contextPackId], workspaceDir);
  assert.ok(memory.task?.id, "memory start did not create a task id");
  await runJson(["memory", "update", memory.task.id, "--decision", "memory remains a compatibility alias"], workspaceDir);
  await runJsonCheck(["memory", "show", memory.task.id], workspaceDir, "memory show", (result) => {
    assert.equal(result.id, memory.task.id, "memory show returned the wrong task");
  });
  await runJsonCheck(["memory", "resume", memory.task.id, "--format", "json"], workspaceDir, "memory resume", (result) => {
    assert.equal(result.task.id, memory.task.id, "memory resume returned the wrong task");
  });
  await runJson(["memory", "finish", memory.task.id, "--outcome", "Compatibility surface exercised"], workspaceDir);
  await runJsonCheck(["memory", "list"], workspaceDir, "memory list", (result) => {
    assert.ok(result.some((entry) => entry.id === memory.task.id), "memory list did not include the finished task");
  });

  await runJsonCheck(["graph", "status"], workspaceDir, "graph status", (result) => {
    assert.equal(result.graphExists, true, "graph status did not find the compiled graph");
  });
  await runJsonCheck(["check-update"], workspaceDir, "check-update", (result) => {
    assert.equal(result.graphExists, true, "check-update did not find the compiled graph");
  });
  await runJsonCheck(["graph", "stats"], workspaceDir, "graph stats", (result) => {
    assert.ok(result.counts?.nodes > 0, "graph stats did not report graph nodes");
  });
  await runJsonCheck(["graph", "validate"], workspaceDir, "graph validate", (result) => {
    assert.equal(result.ok, true, "graph validate did not accept the compiled graph");
  });
  await runJsonCheck(["graph", "cluster"], workspaceDir, "graph cluster", (result) => {
    assert.ok(result.nodeCount > 0, "graph cluster did not report graph nodes");
  });
  await runJsonCheck(["graph", "clusters"], workspaceDir, "graph clusters alias", (result) => {
    assert.ok(result.nodeCount > 0, "graph clusters alias did not report graph nodes");
  });
  await runJsonCheck(["cluster-only"], workspaceDir, "cluster-only", (result) => {
    assert.ok(result.nodeCount > 0, "cluster-only did not report graph nodes");
  });
  await runJsonCheck(["graph", "tree", "--output", path.join(workspaceDir, "exports", "tree.html")], workspaceDir, "graph tree", (result) => {
    assert.ok(result.outputPath.endsWith("tree.html"), "graph tree returned the wrong output path");
  });
  await runJsonCheck(["tree", "--output", path.join(workspaceDir, "exports", "tree-alias.html")], workspaceDir, "tree", (result) => {
    assert.ok(result.outputPath.endsWith("tree-alias.html"), "tree alias returned the wrong output path");
  });
  await runJsonCheck(["graph", "share", "--bundle", path.join(workspaceDir, "exports", "share-kit")], workspaceDir, "graph share", (result) => {
    assert.ok(result.bundlePath.endsWith("share-kit"), "graph share did not report the bundle path");
  });
  await runJsonCheck(["graph", "export", "--svg", path.join(workspaceDir, "exports", "graph.svg")], workspaceDir, "graph export", (result) => {
    assert.equal(result.format, "svg", "graph export did not report svg output");
  });
  await runJsonCheck(["graph", "export", "--neo4j", path.join(workspaceDir, "exports", "graph.cypher")], workspaceDir, "graph export --neo4j", (result) => {
    assert.equal(result.format, "cypher", "graph export --neo4j did not report cypher output");
  });
  await runJsonCheck(["graph", "query", "durable outputs", "--relation", "mentions"], workspaceDir, "graph query", (result) => {
    assert.ok(typeof result.summary === "string", "graph query did not return a summary");
  });
  await runJsonCheck(["graph", "explain", "Durable"], workspaceDir, "graph explain", (result) => {
    assert.ok(typeof result.summary === "string", "graph explain did not return a summary");
  });
  await runJsonCheck(["graph", "path", "Durable", "Durable"], workspaceDir, "graph path", (result) => {
    assert.ok(typeof result.summary === "string", "graph path did not return a summary");
  });
  await runJsonCheck(["graph", "god-nodes", "--limit", "3"], workspaceDir, "graph god-nodes", (result) => {
    assert.ok(Array.isArray(result), "graph god-nodes did not return an array");
  });
  await runJsonCheck(["graph", "blast", "app.ts"], workspaceDir, "graph blast", (result) => {
    assert.ok(typeof result.summary === "string", "graph blast did not return a summary");
  });
  const graphPath = path.join(workspaceDir, "state", "graph.json");
  await runJsonCheck(["graph", "merge", graphPath, graphPath, "--out", path.join(workspaceDir, "exports", "merged.json")], workspaceDir, "graph merge", (result) => {
    assert.ok(result.outputPath.endsWith("merged.json"), "graph merge returned the wrong output path");
  });
  await runJsonCheck(["merge-graphs", graphPath, graphPath, "--out", path.join(workspaceDir, "exports", "merged-alias.json")], workspaceDir, "merge-graphs", (result) => {
    assert.ok(result.outputPath.endsWith("merged-alias.json"), "merge-graphs returned the wrong output path");
    assert.equal(result.inputGraphs.length, 2, "merge-graphs did not merge both inputs");
  });
  await runJsonCheck(["graph", "update", sourceDir], workspaceDir, "graph update", (result) => {
    assert.ok(Array.isArray(result.watchedRepoRoots), "graph update did not return watched roots");
  });
  await runJsonCheck(["graph", "refresh", sourceDir], workspaceDir, "graph refresh alias", (result) => {
    assert.ok(Array.isArray(result.watchedRepoRoots), "graph refresh alias did not return watched roots");
  });
  await runJsonCheck(["update", sourceDir], workspaceDir, "update", (result) => {
    assert.ok(Array.isArray(result.watchedRepoRoots), "update did not return watched roots");
  });

  await runJsonCheck(["doctor"], workspaceDir, "doctor", (result) => {
    assert.ok(Array.isArray(result.checks), "doctor did not return checks");
  });
  await runJsonCheck(["retrieval", "status"], workspaceDir, "retrieval status", (result) => {
    assert.ok(typeof result.indexPath === "string", "retrieval status did not return an index path");
  });
  await runJsonCheck(["retrieval", "doctor"], workspaceDir, "retrieval doctor", (result) => {
    assert.ok(result.status, "retrieval doctor did not return status");
  });
  await runJsonCheck(["retrieval", "rebuild"], workspaceDir, "retrieval rebuild", (result) => {
    assert.ok(result.indexExists, "retrieval rebuild did not report an index");
  });
  await runJsonCheck(["review", "list"], workspaceDir, "review list", (result) => {
    assert.ok(Array.isArray(result), "review list did not return an array");
  });
  await runJsonCheck(["candidate", "list"], workspaceDir, "candidate list", (result) => {
    assert.ok(Array.isArray(result), "candidate list did not return an array");
  });
  await runJsonCheck(["candidate", "preview-scores"], workspaceDir, "candidate preview-scores", (result) => {
    assert.ok(Array.isArray(result), "candidate preview-scores did not return an array");
  });
  await runJsonCheck(["candidate", "auto-promote", "--dry-run"], workspaceDir, "candidate auto-promote", (result) => {
    assert.equal(result.dryRun, true, "candidate auto-promote --dry-run did not report dryRun=true");
  });
  await runJsonCheck(["provider", "setup", "--local-whisper"], workspaceDir, "provider setup", (result) => {
    assert.equal(result.apply, false, "provider setup JSON status did not report apply=false");
  });

  const managedDir = path.join(workspaceDir, "managed-source");
  await fs.mkdir(managedDir, { recursive: true });
  await fs.writeFile(path.join(managedDir, "README.md"), "# Managed Source\n\nManaged source smoke.\n", "utf8");
  const managed = await runJson(["source", "add", managedDir, "--no-compile", "--no-brief"], workspaceDir);
  assert.ok(managed.source?.id, "source add did not create a managed source id");
  await runJsonCheck(["source", "list"], workspaceDir, "source list", (result) => {
    assert.ok(result.some((entry) => entry.id === managed.source.id), "source list did not include the managed source");
  });
  await runJsonCheck(["source", "reload", managed.source.id, "--no-compile", "--no-brief"], workspaceDir, "source reload", (result) => {
    assert.ok(result.sources.some((entry) => entry.id === managed.source.id), "source reload did not return the managed source");
  });
  const sourceId = managed.source.sourceIds[0];
  const guide = await runJson(["source", "guide", sourceId], workspaceDir);
  assert.ok(guide.awaitingInput, "source guide did not create an awaiting session");
  await runJsonCheck(["source", "session", guide.sessionId], workspaceDir, "source session", (result) => {
    assert.equal(result.awaitingInput, true, "source session without answers should remain awaiting input");
  });
  await runJsonCheck(["source", "review", sourceId], workspaceDir, "source review", (result) => {
    assert.ok(result.approvalId, "source review did not stage an approval");
  });
  await runJsonCheck(["source", "delete", managed.source.id], workspaceDir, "source delete", (result) => {
    assert.equal(result.removed.id, managed.source.id, "source delete removed the wrong source");
  });

  await runJsonCheck(["inbox", "import"], workspaceDir, "inbox import", (result) => {
    assert.ok(Array.isArray(result.imported), "inbox import did not return imported entries");
  });
  await runJsonCheck(["watch", "list-roots"], workspaceDir, "watch list-roots", (result) => {
    assert.ok(Array.isArray(result.roots), "watch list-roots did not return roots");
  });
  await runJsonCheck(["watch", "add-root", sourceDir], workspaceDir, "watch add-root", (result) => {
    assert.ok(result.added, "watch add-root did not return the added path");
  });
  await runJsonCheck(["watch", "remove-root", sourceDir], workspaceDir, "watch remove-root", (result) => {
    assert.equal(result.removed, true, "watch remove-root did not remove the added path");
  });
  await runJsonCheck(["watch", "status"], workspaceDir, "watch status", (result) => {
    assert.ok(Array.isArray(result.pendingSemanticRefresh), "watch status did not return pending refresh entries");
  });
  await runJsonCheck(["watch-status"], workspaceDir, "watch-status", (result) => {
    assert.ok(Array.isArray(result.pendingSemanticRefresh), "watch-status did not return pending refresh entries");
  });
  await runJsonCheck(["watch", "--once"], workspaceDir, "watch --once", (result) => {
    assert.ok(Number.isFinite(result.importedCount), "watch --once did not return counts");
  });
  await runJsonCheck(["watch", sourceDir, "--once", "--code-only"], workspaceDir, "watch path --once", (result) => {
    assert.ok(Array.isArray(result.watchedRepoRoots), "watch path --once did not return watched roots");
    assert.ok(result.watchedRepoRoots.length >= 1, "watch path --once did not use the positional repo root");
  });
  await runJsonCheck(["hook", "status"], workspaceDir, "hook status", (result) => {
    assert.ok("repoRoot" in result, "hook status did not return repoRoot state");
  });
  await runJsonCheck(["schedule", "list"], workspaceDir, "schedule list", (result) => {
    assert.ok(Array.isArray(result), "schedule list did not return an array");
  });
  await runJsonCheck(["migrate"], workspaceDir, "migrate", (result) => {
    assert.ok(typeof result.toVersion === "string", "migrate did not return a target version");
  });
  await runJsonCheck(["install", "--agent", "codex"], workspaceDir, "install", (result) => {
    assert.equal(result.agent, "codex", "install did not return the requested agent");
  });

  const scanDir = await makeTempDir("swarmvault-cli-surface-scan-");
  const scanInput = path.join(scanDir, "input");
  const scanWorkspace = path.join(scanDir, "workspace");
  await fs.mkdir(scanInput, { recursive: true });
  await fs.mkdir(scanWorkspace, { recursive: true });
  await fs.writeFile(path.join(scanInput, "README.md"), "# Scan Input\n\nScan smoke.\n", "utf8");
  await runJsonCheck(["scan", scanInput, "--no-viz"], scanWorkspace, "scan", (result) => {
    assert.ok(result.compiled?.sourceCount >= 1, "scan --no-viz did not compile the input");
  });

  const cloneWorkspace = path.join(scanDir, "clone-workspace");
  await fs.mkdir(cloneWorkspace, { recursive: true });
  await runJsonCheck(["clone", scanInput, "--no-viz"], cloneWorkspace, "clone", (result) => {
    assert.ok(result.compiled?.sourceCount >= 1, "clone --no-viz did not compile the input");
  });

  await runJsonCheck(["context", "delete", contextPackId], workspaceDir, "context delete", (result) => {
    assert.equal(result.id, contextPackId, "context delete returned the wrong pack");
  });
}

async function makeTempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function runJsonCheck(commandArgs, cwd, label, validate) {
  const result = await runJson(commandArgs, cwd);
  validate(result);
  summary.behaviorChecks.push(label);
  return result;
}

async function runJson(commandArgs, cwd) {
  const result = await runCli(["--json", ...commandArgs], { cwd, label: `json:${commandArgs.join(" ")}` });
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, `no JSON output for command: ${commandArgs.join(" ")}`);
  return JSON.parse(lines.at(-1));
}

async function runCli(commandArgs, options) {
  const command = cliPath.endsWith(".js") ? process.execPath : cliPath;
  const argsForCli = cliPath.endsWith(".js") ? [cliPath, ...commandArgs] : commandArgs;
  const child = spawn(command, argsForCli, {
    cwd: options.cwd,
    env: { ...process.env, SWARMVAULT_NO_NOTICES: "1" },
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
  if (exit.code !== 0) {
    throw new Error(
      [
        `CLI command failed: ${options.label}`,
        `${command} ${argsForCli.join(" ")}`,
        `cwd=${options.cwd}`,
        `exit=${exit.code ?? "null"} signal=${exit.signal ?? "none"}`,
        `stdout=${stdout.slice(-2000)}`,
        `stderr=${stderr.slice(-2000)}`
      ].join("\n")
    );
  }
  return { stdout, stderr, exit };
}
