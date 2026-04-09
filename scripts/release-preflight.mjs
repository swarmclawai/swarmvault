#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

  if (!args.skipCheck) {
    await run("pnpm", ["check"], { cwd: repoRoot });
  }
  if (!args.skipTest) {
    await run("pnpm", ["test"], { cwd: repoRoot });
  }
  if (!args.skipBuild) {
    await run("pnpm", ["build"], { cwd: repoRoot });
  }
  if (!args.skipWeb) {
    await run("pnpm", ["build"], { cwd: webRoot });
  }
  if (!args.skipSkill) {
    await run("pnpm", ["skill:publish", "--", "--dry-run"], { cwd: repoRoot });
  }

  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), `swarmvault-preflight-${version}-`));
  const engineTarball = path.join(packDir, `swarmvaultai-engine-${version}.tgz`);
  const cliTarball = path.join(packDir, `swarmvaultai-cli-${version}.tgz`);
  try {
    await run("pnpm", ["pack", "--pack-destination", packDir], { cwd: path.join(repoRoot, "packages", "engine") });
    await run("pnpm", ["pack", "--pack-destination", packDir], { cwd: path.join(repoRoot, "packages", "cli") });

    const smokeArgs = ["./scripts/live-smoke.mjs", "--lane", "heuristic", "--install-spec", engineTarball, "--install-spec", cliTarball];
    const corpusArgs = ["./scripts/live-oss-corpus.mjs", "--lane", "heuristic", "--install-spec", engineTarball, "--install-spec", cliTarball];
    if (args.keepArtifacts) {
      smokeArgs.push("--keep-artifacts");
      corpusArgs.push("--keep-artifacts");
    }

    await run("node", smokeArgs, { cwd: repoRoot });
    if (!args.noBrowser) {
      await run("node", [...smokeArgs, "--browser-check"], { cwd: repoRoot });
    }
    if (!args.noOssCorpus) {
      await run("node", corpusArgs, { cwd: repoRoot });
    }
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
  }
}

await main();
