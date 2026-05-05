#!/usr/bin/env node

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const engineRoot = path.join(repoRoot, "packages", "engine");
const requireFromEngine = createRequire(path.join(engineRoot, "package.json"));
const outDir = path.join(engineRoot, "dist", "vendor");

const assets = [
  {
    packageName: "tree-sitter-julia",
    sourceFile: "tree-sitter-julia.wasm",
    targetFile: "tree-sitter-julia.wasm"
  },
  {
    packageName: "tree-sitter-systemverilog",
    sourceFile: "tree-sitter-systemverilog.wasm",
    targetFile: "tree-sitter-systemverilog.wasm"
  }
];

await fs.mkdir(outDir, { recursive: true });

for (const asset of assets) {
  const packageRoot = path.dirname(requireFromEngine.resolve(`${asset.packageName}/package.json`));
  const sourcePath = path.join(packageRoot, asset.sourceFile);
  const targetPath = path.join(outDir, asset.targetFile);
  await fs.copyFile(sourcePath, targetPath);
}
