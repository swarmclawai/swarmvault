import fs from "node:fs/promises";
import path from "node:path";
import { initWorkspace } from "./config.js";
import { ensureDir, fileExists } from "./utils.js";

const managedStart = "<!-- swarmvault:managed:start -->";
const managedEnd = "<!-- swarmvault:managed:end -->";
const legacyManagedStart = "<!-- vault:managed:start -->";
const legacyManagedEnd = "<!-- vault:managed:end -->";

function buildManagedBlock(agent: "codex" | "claude" | "cursor"): string {
  const body = [
    managedStart,
    `# SwarmVault Rules (${agent})`,
    "",
    "- Read `swarmvault.schema.md` before compile or query style work. It is the canonical schema path.",
    "- Treat `raw/` as immutable source input.",
    "- Treat `wiki/` as generated markdown owned by the agent and compiler workflow.",
    "- Read `wiki/index.md` before broad file searching when answering SwarmVault questions.",
    "- Preserve frontmatter fields including `page_id`, `source_ids`, `node_ids`, `freshness`, and `source_hashes`.",
    "- Save high-value answers back into `wiki/outputs/` instead of leaving them only in chat.",
    "- Prefer `swarmvault ingest`, `swarmvault compile`, `swarmvault query`, and `swarmvault lint` for SwarmVault maintenance tasks.",
    managedEnd,
    ""
  ].join("\n");

  if (agent === "cursor") {
    return body;
  }

  return body;
}

async function upsertManagedBlock(filePath: string, block: string): Promise<void> {
  const existing = (await fileExists(filePath)) ? await fs.readFile(filePath, "utf8") : "";
  if (!existing) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, `${block}\n`, "utf8");
    return;
  }

  const startIndex = existing.includes(managedStart) ? existing.indexOf(managedStart) : existing.indexOf(legacyManagedStart);
  const endIndex = existing.includes(managedEnd) ? existing.indexOf(managedEnd) : existing.indexOf(legacyManagedEnd);
  if (startIndex !== -1 && endIndex !== -1) {
    const next = `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex + managedEnd.length)}`;
    await fs.writeFile(filePath, next, "utf8");
    return;
  }

  await fs.writeFile(filePath, `${existing.trimEnd()}\n\n${block}\n`, "utf8");
}

export async function installAgent(rootDir: string, agent: "codex" | "claude" | "cursor"): Promise<string> {
  await initWorkspace(rootDir);
  const block = buildManagedBlock(agent);

  switch (agent) {
    case "codex": {
      const target = path.join(rootDir, "AGENTS.md");
      await upsertManagedBlock(target, block);
      return target;
    }
    case "claude": {
      const target = path.join(rootDir, "CLAUDE.md");
      await upsertManagedBlock(target, block);
      return target;
    }
    case "cursor": {
      const rulesDir = path.join(rootDir, ".cursor", "rules");
      await ensureDir(rulesDir);
      const target = path.join(rulesDir, "swarmvault.mdc");
      await fs.writeFile(target, `${block}\n`, "utf8");
      return target;
    }
    default:
      throw new Error(`Unsupported agent ${String(agent)}`);
  }
}

export async function installConfiguredAgents(rootDir: string): Promise<string[]> {
  const { config } = await initWorkspace(rootDir);
  return Promise.all(config.agents.map((agent) => installAgent(rootDir, agent)));
}
