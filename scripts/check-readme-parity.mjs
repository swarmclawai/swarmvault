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
  "swarmvault source session transcript-or-session-id",
  "swarmvault source list",
  "swarmvault source session file-customer-call-srt-12345678",
  "swarmvault source reload --all",
  "swarmvault ingest ./src --repo-root .",
  "swarmvault add https://arxiv.org/abs/2401.12345",
  "swarmvault compile",
  "swarmvault query \"What is the auth flow?\"",
  "swarmvault chat \"How should the next agent use this vault?\"",
  "swarmvault export ai --out ./exports/ai",
  "swarmvault graph serve",
  "swarmvault check-update ./src",
  "swarmvault update ./src",
  "swarmvault cluster-only",
  "swarmvault tree --output ./exports/tree.html",
  "swarmvault graph export --neo4j ./exports/graph.cypher",
  "swarmvault merge-graphs ./exports/graph.json ./other-graph.json --out ./exports/merged-graph.json",
  "swarmvault clone https://github.com/owner/repo --no-viz",
  "swarmvault graph push neo4j --dry-run",
  "swarmvault install --agent claude --hook",
  "swarmvault install --agent codex --hook",
  "swarmvault install --agent copilot --hook",
  "swarmvault install --agent gemini --hook",
  "swarmvault install --agent kiro",
  "swarmvault install --agent hermes",
  "swarmvault install --agent antigravity",
  "swarmvault install --agent vscode",
  "swarmvault init --lite",
  "swarmvault mcp",
  "clawhub install swarmvault",
  "LLM Wiki",
  "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f",
  ".epub",
  ".csv .tsv",
  ".xlsx",
  ".pptx",
  ".ipynb",
  ".odt .odp .ods",
  "\"type\": \"openai\"",
  "OPENAI_API_KEY",
  "https://www.swarmvault.ai/images/screenshots/graph-workspace.png",
  "https://www.swarmvault.ai/docs",
  "https://www.swarmvault.ai/docs/providers",
  "https://www.swarmvault.ai/docs/getting-started/troubleshooting",
  "https://www.npmjs.com/package/@swarmvaultai/cli",
  "https://github.com/swarmclawai/swarmvault",
  "wiki/outputs/source-sessions/",
  "worked/book-reading/",
  "worked/research-deep-dive/",
  "worked/personal-knowledge-base/",
  "templates/llm-wiki-schema.md",
  "Memex"
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
