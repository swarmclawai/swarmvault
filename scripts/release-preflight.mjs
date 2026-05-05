#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPreflightSummary, writePreflightSummary } from "./release-preflight-summary.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const webRoot = path.join(workspaceRoot, "web");

function parseArgs(argv) {
  const args = {
    skipCheck: false,
    skipTest: false,
    skipBuild: false,
    skipWeb: false,
    skipSkill: false,
    noBrowser: false,
    noOssCorpus: false,
    keepArtifacts: false
  };

  for (const token of argv) {
    if (token === "--") continue;
    else if (token === "--skip-check") args.skipCheck = true;
    else if (token === "--skip-test") args.skipTest = true;
    else if (token === "--skip-build") args.skipBuild = true;
    else if (token === "--skip-web") args.skipWeb = true;
    else if (token === "--skip-skill") args.skipSkill = true;
    else if (token === "--no-browser") args.noBrowser = true;
    else if (token === "--no-oss-corpus") args.noOssCorpus = true;
    else if (token === "--keep-artifacts") args.keepArtifacts = true;
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPackageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const version = rootPackageJson.version;
  const startedAt = new Date().toISOString();
  const gates = [];
  const summaryDir = path.join(repoRoot, ".release-preflight");
  const packageSmoke = {
    installSpecs: [],
    packDir: undefined,
    packDirKept: args.keepArtifacts,
    browserSmoke: args.noBrowser ? "skipped" : "not run",
    ossCorpus: args.noOssCorpus ? "skipped" : "not run"
  };
  let packDir;

  async function runGate(id, label, fn, skipReason) {
    const gateStartedAt = Date.now();
    if (skipReason) {
      gates.push({ id, label, status: "skipped", durationMs: 0, detail: skipReason });
      return;
    }
    try {
      await fn();
      gates.push({ id, label, status: "passed", durationMs: Date.now() - gateStartedAt });
    } catch (error) {
      gates.push({
        id,
        label,
        status: "failed",
        durationMs: Date.now() - gateStartedAt,
        detail: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  try {
    await runGate("check", "pnpm check", () => run("pnpm", ["check"], { cwd: repoRoot }), args.skipCheck ? "--skip-check" : undefined);
    await runGate("test", "pnpm test", () => run("pnpm", ["test"], { cwd: repoRoot }), args.skipTest ? "--skip-test" : undefined);
    await runGate("build", "pnpm build", () => run("pnpm", ["build"], { cwd: repoRoot }), args.skipBuild ? "--skip-build" : undefined);
    await runGate("cli-surface", "direct CLI surface smoke", () => run("pnpm", ["live:cli-surface"], { cwd: repoRoot }), args.skipBuild ? "--skip-build" : undefined);
    await runGate("web-build", "web pnpm build", () => run("pnpm", ["build"], { cwd: webRoot }), args.skipWeb ? "--skip-web" : undefined);
    await runGate(
      "skill-dry-run",
      "ClawHub skill dry-run",
      () => run("pnpm", ["skill:publish", "--", "--dry-run"], { cwd: repoRoot }),
      args.skipSkill ? "--skip-skill" : undefined
    );

    packDir = await fs.mkdtemp(path.join(os.tmpdir(), `swarmvault-preflight-${version}-`));
    packageSmoke.packDir = packDir;
    const engineTarball = path.join(packDir, `swarmvaultai-engine-${version}.tgz`);
    const cliTarball = path.join(packDir, `swarmvaultai-cli-${version}.tgz`);
    packageSmoke.installSpecs = [engineTarball, cliTarball];
    await runGate("pack-engine", "pack @swarmvaultai/engine", () =>
      run("pnpm", ["pack", "--pack-destination", packDir], { cwd: path.join(repoRoot, "packages", "engine") })
    );
    await runGate("pack-cli", "pack @swarmvaultai/cli", () =>
      run("pnpm", ["pack", "--pack-destination", packDir], { cwd: path.join(repoRoot, "packages", "cli") })
    );

    const smokeArgs = ["./scripts/live-smoke.mjs", "--lane", "heuristic", "--install-spec", engineTarball, "--install-spec", cliTarball];
    const corpusArgs = ["./scripts/live-oss-corpus.mjs", "--lane", "heuristic", "--install-spec", engineTarball, "--install-spec", cliTarball];
    if (args.keepArtifacts) {
      smokeArgs.push("--keep-artifacts");
      corpusArgs.push("--keep-artifacts");
    }

    await runGate("live-smoke", "installed-package heuristic smoke", () => run("node", smokeArgs, { cwd: repoRoot }));
    await runGate(
      "browser-smoke",
      "installed-package browser smoke",
      async () => {
        await run("node", [...smokeArgs, "--browser-check"], { cwd: repoRoot });
        packageSmoke.browserSmoke = "passed";
      },
      args.noBrowser ? "--no-browser" : undefined
    );
    await runGate(
      "oss-corpus",
      "installed-package OSS corpus",
      async () => {
        await run("node", corpusArgs, { cwd: repoRoot });
        packageSmoke.ossCorpus = "passed";
      },
      args.noOssCorpus ? "--no-oss-corpus" : undefined
    );
  } finally {
    const summary = createPreflightSummary({
      version,
      repoRoot,
      webRoot,
      startedAt,
      gates,
      packageSmoke,
      artifacts: {
        summaryJson: path.join(summaryDir, "summary.json"),
        summaryMarkdown: path.join(summaryDir, "summary.md"),
        liveSmokeRoot: path.join(repoRoot, ".live-smoke-artifacts"),
        ossCorpusRoot: path.join(repoRoot, ".oss-corpus-artifacts")
      }
    });
    try {
      const written = await writePreflightSummary(summary, summaryDir);
      console.log(`[release-preflight] summary written to ${written.markdownPath}`);
    } catch (error) {
      console.warn(`[release-preflight] could not write summary: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (packDir && !args.keepArtifacts) {
      await fs.rm(packDir, { recursive: true, force: true });
    }
  }
}

await main();
