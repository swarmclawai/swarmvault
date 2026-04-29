#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const desktopRoot = path.join(workspaceRoot, "desktop");
const defaultGithubRepo = "swarmclawai/swarmvault";
const npmPackages = [
  { name: "@swarmvaultai/viewer", dir: "packages/viewer" },
  { name: "@swarmvaultai/engine", dir: "packages/engine" },
  { name: "@swarmvaultai/cli", dir: "packages/cli" }
];

function parseArgs(argv) {
  const args = {
    allowDirty: false,
    dryRun: false,
    githubRepo: defaultGithubRepo,
    npmTag: "latest",
    otp: undefined,
    skipBrowserSmoke: false,
    skipDesktop: false,
    skipExistingCheck: false,
    skipGithubRelease: false,
    skipLiveSmoke: false,
    skipNpm: false,
    skipOssCorpus: false,
    skipPreflight: false,
    skipSkill: false,
    skipSkillInspect: false,
    version: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--allow-dirty") {
      args.allowDirty = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--github-repo") {
      args.githubRepo = readRequiredValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--npm-tag") {
      args.npmTag = readRequiredValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--otp") {
      args.otp = readRequiredValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--skip-browser-smoke") {
      args.skipBrowserSmoke = true;
      continue;
    }
    if (token === "--skip-desktop") {
      args.skipDesktop = true;
      continue;
    }
    if (token === "--skip-existing-check") {
      args.skipExistingCheck = true;
      continue;
    }
    if (token === "--skip-github-release") {
      args.skipGithubRelease = true;
      continue;
    }
    if (token === "--skip-live-smoke") {
      args.skipLiveSmoke = true;
      continue;
    }
    if (token === "--skip-npm") {
      args.skipNpm = true;
      continue;
    }
    if (token === "--skip-oss-corpus") {
      args.skipOssCorpus = true;
      continue;
    }
    if (token === "--skip-preflight") {
      args.skipPreflight = true;
      continue;
    }
    if (token === "--skip-skill") {
      args.skipSkill = true;
      args.skipSkillInspect = true;
      continue;
    }
    if (token === "--skip-skill-inspect") {
      args.skipSkillInspect = true;
      continue;
    }
    if (token === "--version") {
      args.version = readRequiredValue(argv, index, token);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function readRequiredValue(argv, index, token) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${token} requires a value`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage: pnpm release:publish -- [options]

Publishes the full SwarmVault release sequence from the OSS repo.

Options:
  --version <version>        Release version. Defaults to package.json version.
  --npm-tag <tag>            npm dist-tag to publish. Defaults to latest.
  --otp <code>               npm one-time password when 2FA requires it.
  --dry-run                  Print the release sequence without changing remote state.
  --allow-dirty              Allow dirty OSS or desktop worktrees before publishing.
  --skip-preflight           Skip pnpm release:preflight.
  --skip-npm                 Skip npm package publishing.
  --skip-live-smoke          Skip live smoke checks against the published npm package.
  --skip-browser-smoke       Skip the browser live smoke lane.
  --skip-oss-corpus          Skip the live OSS corpus lane.
  --skip-skill               Skip ClawHub skill publish and inspect.
  --skip-skill-inspect       Publish the ClawHub skill but skip post-publish inspect.
  --skip-desktop             Skip desktop lock refresh, commit, tag, and push.
  --skip-github-release      Skip GitHub release creation.
  --skip-existing-check      Do not call npm view before npm publish.
  --github-repo <owner/repo> GitHub repo for gh release. Defaults to ${defaultGithubRepo}.
`);
}

function shellQuote(value) {
  const text = String(value);
  const safeCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/:=.,@%+-";
  if ([...text].every((character) => safeCharacters.includes(character))) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function runCommand(command, commandArgs, options = {}) {
  if (releaseArgs.dryRun && options.dryRun !== false) {
    console.log(`[dry-run] ${formatCommand(command, commandArgs)}`);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: "inherit"
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

function captureCommand(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code: code ?? 0, stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} exited with code ${code}\n${stderr}`));
    });
    child.on("error", reject);
  });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertClean(cwd, label) {
  const status = await captureCommand("git", ["status", "--porcelain"], { cwd });
  if (!status.stdout.trim()) return;
  if (releaseArgs.allowDirty) {
    console.warn(`[release-publish] ${label} worktree is dirty; continuing because --allow-dirty was set.`);
    return;
  }
  throw new Error(`${label} worktree has uncommitted changes. Commit/stash them or rerun with --allow-dirty.`);
}

async function assertTagPushed(cwd, tagName, label) {
  const local = await captureCommand("git", ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], {
    cwd,
    allowFailure: true
  });
  if (local.code !== 0) {
    throw new Error(`${label} tag ${tagName} does not exist locally.`);
  }
  if (releaseArgs.dryRun) return;
  const remote = await captureCommand("git", ["ls-remote", "--exit-code", "origin", `refs/tags/${tagName}`], {
    cwd,
    allowFailure: true
  });
  if (remote.code !== 0) {
    throw new Error(`${label} tag ${tagName} is not available on origin.`);
  }
}

async function validateVersions(version) {
  const rootPackage = await readJson(path.join(repoRoot, "package.json"));
  assertVersion(rootPackage.version, version, "root package.json");

  for (const npmPackage of npmPackages) {
    const packageJson = await readJson(path.join(repoRoot, npmPackage.dir, "package.json"));
    assertVersion(packageJson.version, version, `${npmPackage.name} package.json`);
    assertNoWorkspaceRuntimeDeps(packageJson, npmPackage.name);
  }

  const cliPackage = await readJson(path.join(repoRoot, "packages", "cli", "package.json"));
  if (cliPackage.dependencies?.["@swarmvaultai/engine"] !== version) {
    throw new Error(`@swarmvaultai/cli must depend on @swarmvaultai/engine ${version}.`);
  }

  if (await pathExists(path.join(desktopRoot, "package.json"))) {
    const desktopPackage = await readJson(path.join(desktopRoot, "package.json"));
    assertVersion(desktopPackage.version, version, "desktop package.json");
    if (desktopPackage.dependencies?.["@swarmvaultai/cli"] !== version) {
      throw new Error(`desktop package must depend on @swarmvaultai/cli ${version}.`);
    }
  }
}

function assertVersion(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is version ${actual}, expected ${expected}.`);
  }
}

function assertNoWorkspaceRuntimeDeps(packageJson, packageName) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependencyName, spec] of Object.entries(packageJson[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        throw new Error(`${packageName} has runtime dependency ${dependencyName}=${spec}.`);
      }
    }
  }
}

async function readChangelogEntry(version) {
  const content = await fs.readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const lines = content.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    throw new Error(`Could not find CHANGELOG.md entry for ${version}.`);
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }

  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) {
    throw new Error(`CHANGELOG.md entry for ${version} is empty.`);
  }
  return body;
}

async function npmPackageExists(packageName, version) {
  if (releaseArgs.skipExistingCheck || releaseArgs.dryRun) return false;
  const result = await captureCommand("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    cwd: repoRoot,
    allowFailure: true
  });
  if (result.code === 0) {
    const publishedVersion = result.stdout.trim().replaceAll('"', "");
    return publishedVersion === version;
  }

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  if (combinedOutput.includes("E404") || combinedOutput.includes("404 Not Found")) {
    return false;
  }
  console.warn(`[release-publish] Could not verify whether ${packageName}@${version} already exists; attempting publish.`);
  return false;
}

async function publishNpmPackages(version) {
  if (releaseArgs.skipNpm) {
    console.log("[release-publish] Skipping npm publish.");
    return;
  }

  for (const npmPackage of npmPackages) {
    if (await npmPackageExists(npmPackage.name, version)) {
      console.log(`[release-publish] ${npmPackage.name}@${version} already exists on npm; skipping.`);
      continue;
    }

    const publishArgs = ["publish", `./${npmPackage.dir}`, "--access", "public", "--tag", releaseArgs.npmTag];
    if (releaseArgs.otp) {
      publishArgs.push("--otp", releaseArgs.otp);
    }
    await runCommand("npm", publishArgs, { cwd: repoRoot });
  }
}

async function runPreflight() {
  if (releaseArgs.skipPreflight) {
    console.log("[release-publish] Skipping local release preflight.");
    return;
  }
  await runCommand("pnpm", ["release:preflight"], { cwd: repoRoot });
}

async function runLivePublishedSmoke(version) {
  if (releaseArgs.skipLiveSmoke) {
    console.log("[release-publish] Skipping live published-package smoke.");
    return;
  }

  await runCommand("pnpm", ["live:smoke:heuristic", "--", "--version", version], { cwd: repoRoot });
  if (!releaseArgs.skipBrowserSmoke) {
    await runCommand("pnpm", ["live:smoke:heuristic:browser", "--", "--version", version], { cwd: repoRoot });
  }
  if (!releaseArgs.skipOssCorpus) {
    await runCommand("pnpm", ["live:oss:corpus", "--", "--version", version], { cwd: repoRoot });
  }
}

async function publishSkill(version) {
  if (releaseArgs.skipSkill) {
    console.log("[release-publish] Skipping ClawHub skill publish.");
    return;
  }
  await runCommand("pnpm", ["skill:publish", "--", "--version", version], { cwd: repoRoot });
  if (!releaseArgs.skipSkillInspect) {
    await runCommand("pnpm", ["skill:inspect"], { cwd: repoRoot });
  }
}

async function updateDesktopRelease(version, tagName) {
  if (releaseArgs.skipDesktop) {
    console.log("[release-publish] Skipping desktop release refresh.");
    return;
  }
  if (!(await pathExists(desktopRoot))) {
    throw new Error(`Desktop repo not found at ${desktopRoot}.`);
  }

  await assertClean(desktopRoot, "Desktop");

  if (releaseArgs.dryRun) {
    await runCommand("pnpm", ["install"], { cwd: desktopRoot });
    await runCommand("pnpm", ["install", "--frozen-lockfile"], { cwd: desktopRoot });
    await runCommand("pnpm", ["typecheck"], { cwd: desktopRoot });
    await runCommand("git", ["add", "package.json", "pnpm-lock.yaml", "README.md"], { cwd: desktopRoot });
    await runCommand("git", ["commit", "-m", `chore: refresh desktop lockfile for SwarmVault ${version}`], { cwd: desktopRoot });
    await runCommand("git", ["tag", "-a", tagName, "-m", `SwarmVault Desktop ${version}`], { cwd: desktopRoot });
    await runCommand("git", ["push", "origin", "main"], { cwd: desktopRoot });
    await runCommand("git", ["push", "origin", tagName], { cwd: desktopRoot });
    return;
  }

  await runCommand("pnpm", ["install"], { cwd: desktopRoot });
  await runCommand("pnpm", ["install", "--frozen-lockfile"], { cwd: desktopRoot });
  await runCommand("pnpm", ["typecheck"], { cwd: desktopRoot });

  const status = await captureCommand("git", ["status", "--porcelain"], { cwd: desktopRoot });
  if (status.stdout.trim()) {
    await runCommand("git", ["add", "package.json", "pnpm-lock.yaml", "README.md"], { cwd: desktopRoot });
    const diff = await captureCommand("git", ["diff", "--cached", "--quiet"], {
      cwd: desktopRoot,
      allowFailure: true
    });
    if (diff.code === 1) {
      await runCommand("git", ["commit", "-m", `chore: refresh desktop lockfile for SwarmVault ${version}`], {
        cwd: desktopRoot
      });
    }
  }

  const localTag = await captureCommand("git", ["rev-parse", "-q", "--verify", `refs/tags/${tagName}`], {
    cwd: desktopRoot,
    allowFailure: true
  });
  if (localTag.code !== 0) {
    await runCommand("git", ["tag", "-a", tagName, "-m", `SwarmVault Desktop ${version}`], { cwd: desktopRoot });
  } else {
    console.log(`[release-publish] Desktop tag ${tagName} already exists locally; skipping tag creation.`);
  }

  await runCommand("git", ["push", "origin", "main"], { cwd: desktopRoot });
  await runCommand("git", ["push", "origin", tagName], { cwd: desktopRoot });
}

async function createGithubRelease(version, tagName) {
  if (releaseArgs.skipGithubRelease) {
    console.log("[release-publish] Skipping GitHub release creation.");
    return;
  }

  if (releaseArgs.dryRun) {
    await readChangelogEntry(version);
    await runCommand(
      "gh",
      [
        "release",
        "create",
        tagName,
        "--repo",
        releaseArgs.githubRepo,
        "--title",
        `SwarmVault ${version}`,
        "--notes-file",
        "<generated-release-notes.md>"
      ],
      { cwd: repoRoot }
    );
    return;
  }

  const existingRelease = await captureCommand("gh", ["release", "view", tagName, "--repo", releaseArgs.githubRepo], {
    cwd: repoRoot,
    allowFailure: true
  });
  if (existingRelease.code === 0) {
    console.log(`[release-publish] GitHub release ${tagName} already exists in ${releaseArgs.githubRepo}; skipping.`);
    return;
  }

  const notes = await readChangelogEntry(version);
  const notesPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), `swarmvault-release-${version}-`)), "notes.md");
  await fs.writeFile(notesPath, `${notes}\n`, "utf8");
  try {
    await runCommand(
      "gh",
      ["release", "create", tagName, "--repo", releaseArgs.githubRepo, "--title", `SwarmVault ${version}`, "--notes-file", notesPath],
      { cwd: repoRoot }
    );
  } finally {
    await fs.rm(path.dirname(notesPath), { recursive: true, force: true });
  }
}

const releaseArgs = parseArgs(process.argv.slice(2));
if (releaseArgs.help) {
  printUsage();
  process.exit(0);
}

const rootPackage = await readJson(path.join(repoRoot, "package.json"));
const version = releaseArgs.version ?? rootPackage.version;
const tagName = `v${version}`;

console.log(`[release-publish] Preparing SwarmVault ${version}.`);
await validateVersions(version);
await assertClean(repoRoot, "OSS");
await assertTagPushed(repoRoot, tagName, "OSS");
await runPreflight();
await publishNpmPackages(version);
await runLivePublishedSmoke(version);
await publishSkill(version);
await updateDesktopRelease(version, tagName);
await createGithubRelease(version, tagName);
console.log(`[release-publish] Release ${version} publish sequence complete.`);
