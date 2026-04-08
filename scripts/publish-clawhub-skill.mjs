import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TAGS = ["latest", "swarmvault", "knowledge-base", "local-first", "markdown", "mcp", "graph"];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const skillDir = path.join(repoRoot, "skills", "swarmvault");

function parseArgs(argv) {
  const args = { dryRun: false, version: undefined, changelog: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--version") {
      args.version = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === "--changelog") {
      args.changelog = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
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

function readChangelogSummary(content, version) {
  const lines = content.split(/\r?\n/);
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) {
    throw new Error(`Could not find changelog heading for ${version}`);
  }

  const bullets = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) bullets.push(line.slice(2).trim());
  }

  if (bullets.length === 0) {
    throw new Error(`Could not find changelog bullet points for ${version}`);
  }

  return bullets.join("; ");
}

const args = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
const version = args.version ?? packageJson.version;
const changelogContent = await fs.readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
const changelog = args.changelog ?? readChangelogSummary(changelogContent, version);

await run("node", [path.join(scriptDir, "check-clawhub-skill.mjs")], { cwd: repoRoot });

const publishArgs = [
  "publish",
  skillDir,
  "--slug",
  "swarmvault",
  "--name",
  "SwarmVault",
  "--version",
  version,
  "--changelog",
  changelog,
  "--tags",
  DEFAULT_TAGS.join(",")
];

if (args.dryRun) {
  console.log(`clawhub ${publishArgs.join(" ")}`);
  process.exit(0);
}

await run("clawhub", publishArgs, { cwd: repoRoot });
