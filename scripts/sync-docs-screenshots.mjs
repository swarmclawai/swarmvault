#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const artifactRoot = path.join(repoRoot, ".live-smoke-artifacts");
const targetDir = path.join(workspaceRoot, "web", "public", "images", "screenshots");
const targetPath = path.join(targetDir, "graph-workspace.png");

const args = parseArgs(process.argv.slice(2));
const sourcePath = args.source ?? (await findLatestBrowserScreenshot());
assert.ok(sourcePath, "No browser gut-check screenshot found. Pass --source <path> or generate one first.");

await fs.mkdir(targetDir, { recursive: true });
await fs.copyFile(sourcePath, targetPath);
console.log(`Synced ${path.relative(workspaceRoot, sourcePath)} -> ${path.relative(workspaceRoot, targetPath)}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source") {
      parsed.source = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return parsed;
}

async function findLatestBrowserScreenshot() {
  let entries = [];
  try {
    entries = await fs.readdir(artifactRoot);
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.startsWith("browser-gut-check-") && entry.endsWith(".png"))
    .sort((left, right) => right.localeCompare(left));

  return candidates.length ? path.join(artifactRoot, candidates[0]) : null;
}
