import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const readmes = [
  path.join(repoRoot, "README.md"),
  path.join(repoRoot, "README.zh-CN.md"),
  path.join(repoRoot, "README.ja.md")
];

const sectionMarkers = [
  "install",
  "quickstart",
  "provider-setup",
  "agent-setup",
  "input-types",
  "what-you-get",
  "platform-support",
  "worked-examples",
  "providers",
  "packages",
  "help",
  "development",
  "links",
  "license"
];

const requiredSubstrings = [
  "[English](README.md)",
  "[简体中文](README.zh-CN.md)",
  "[日本語](README.ja.md)",
  "npm install -g @swarmvaultai/cli",
  "swarmvault --version",
  "npm install -g @swarmvaultai/cli@latest",
  "swarmvault init --obsidian",
  "swarmvault source add https://github.com/karpathy/micrograd",
  "swarmvault source add https://example.com/docs/getting-started",
  "swarmvault source list",
  "swarmvault source reload --all",
  "swarmvault ingest ./src --repo-root .",
  "swarmvault add https://arxiv.org/abs/2401.12345",
  "swarmvault compile",
  "swarmvault query \"What is the auth flow?\"",
  "swarmvault graph serve",
  "swarmvault graph push neo4j --dry-run",
  "swarmvault install --agent claude --hook",
  "swarmvault install --agent codex",
  "swarmvault install --agent copilot --hook",
  "swarmvault install --agent gemini --hook",
  "swarmvault mcp",
  "clawhub install swarmvault",
  ".js .jsx .ts .tsx .py .go .rs .java .kt .kts .scala .sc .lua .zig .cs .c .cpp .php .rb .ps1",
  "\"type\": \"openai\"",
  "OPENAI_API_KEY",
  "https://www.swarmvault.ai/images/screenshots/graph-workspace.png",
  "https://www.swarmvault.ai/docs",
  "https://www.swarmvault.ai/docs/providers",
  "https://www.swarmvault.ai/docs/getting-started/troubleshooting",
  "https://www.npmjs.com/package/@swarmvaultai/cli",
  "https://github.com/swarmclawai/swarmvault"
];

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const readmePath of readmes) {
  const content = await fs.readFile(readmePath, "utf8");
  const relativePath = path.relative(repoRoot, readmePath);

  assertCondition(
    content.includes("<!-- readme-language-nav:start -->") && content.includes("<!-- readme-language-nav:end -->"),
    `${relativePath} is missing the language navigation markers`
  );

  let lastIndex = -1;
  for (const marker of sectionMarkers) {
    const token = `<!-- readme-section:${marker} -->`;
    const markerIndex = content.indexOf(token);
    assertCondition(markerIndex >= 0, `${relativePath} is missing section marker ${token}`);
    assertCondition(markerIndex > lastIndex, `${relativePath} has section marker ${token} out of order`);
    lastIndex = markerIndex;
  }

  for (const required of requiredSubstrings) {
    assertCondition(content.includes(required), `${relativePath} is missing required content: ${required}`);
  }
}

console.log(`README parity check passed for ${readmes.length} files.`);
