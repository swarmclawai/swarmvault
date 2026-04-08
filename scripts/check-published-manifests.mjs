#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const packagesDir = path.join(repoRoot, "packages");
const runtimeDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];

const workspacePackageDirs = await fs.readdir(packagesDir, { withFileTypes: true });
const packageEntries = await Promise.all(
  workspacePackageDirs
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const packageJsonPath = path.join(packagesDir, entry.name, "package.json");
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
      return {
        dir: entry.name,
        path: packageJsonPath,
        json: packageJson
      };
    })
);

const publishedWorkspacePackages = packageEntries.filter((entry) => entry.json.private !== true);
const publishedByName = new Map(publishedWorkspacePackages.map((entry) => [entry.json.name, entry]));
const issues = [];

for (const entry of publishedWorkspacePackages) {
  for (const field of runtimeDependencyFields) {
    const dependencies = entry.json[field];
    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== "string") {
        continue;
      }
      if (specifier.startsWith("workspace:")) {
        issues.push(
          `${path.relative(repoRoot, entry.path)} ${field}.${dependencyName} uses ${JSON.stringify(
            specifier
          )}; published runtime deps must use a real semver`
        );
        continue;
      }
      const workspaceDependency = publishedByName.get(dependencyName);
      if (!workspaceDependency) {
        continue;
      }
      if (specifier !== workspaceDependency.json.version) {
        issues.push(
          `${path.relative(repoRoot, entry.path)} ${field}.${dependencyName} is ${JSON.stringify(
            specifier
          )}; expected exact published version ${JSON.stringify(workspaceDependency.json.version)}`
        );
      }
    }
  }
}

if (issues.length) {
  console.error("Published package manifest check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(
  `Published package manifest check passed for ${publishedWorkspacePackages.length} package${
    publishedWorkspacePackages.length === 1 ? "" : "s"
  }.`
);
