import fs from "node:fs/promises";
import path from "node:path";
import { initWorkspace } from "./config.js";
import type { AgentType, InstallAgentOptions } from "./types.js";
import { ensureDir, fileExists } from "./utils.js";

const managedStart = "<!-- swarmvault:managed:start -->";
const managedEnd = "<!-- swarmvault:managed:end -->";
const legacyManagedStart = "<!-- vault:managed:start -->";
const legacyManagedEnd = "<!-- vault:managed:end -->";

function buildManagedBlock(target: "agents" | "claude" | "gemini" | "cursor"): string {
  const body = [
    managedStart,
    "# SwarmVault Rules",
    "",
    "- Read `swarmvault.schema.md` before compile or query style work. It is the canonical schema path.",
    "- Treat `raw/` as immutable source input.",
    "- Treat `wiki/` as generated markdown owned by the agent and compiler workflow.",
    "- Read `wiki/graph/report.md` before broad file searching when it exists; otherwise start with `wiki/index.md`.",
    "- For graph questions, prefer `swarmvault graph query`, `swarmvault graph path`, and `swarmvault graph explain` before broad grep/glob searching.",
    "- Preserve frontmatter fields including `page_id`, `source_ids`, `node_ids`, `freshness`, and `source_hashes`.",
    "- Save high-value answers back into `wiki/outputs/` instead of leaving them only in chat.",
    "- Prefer `swarmvault ingest`, `swarmvault compile`, `swarmvault query`, and `swarmvault lint` for SwarmVault maintenance tasks.",
    managedEnd,
    ""
  ].join("\n");

  if (target === "cursor") {
    return body;
  }

  return body;
}

const claudeHookMatcher = "Glob|Grep";
const claudeHookCommand =
  "if [ -f wiki/graph/report.md ]; then echo 'swarmvault: Graph report exists. Read wiki/graph/report.md before broad raw-file searching.'; fi";

type ClaudeSettings = {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
  };
};

async function installClaudeHook(rootDir: string): Promise<string> {
  const settingsPath = path.join(rootDir, ".claude", "settings.json");
  await ensureDir(path.dirname(settingsPath));

  let settings: ClaudeSettings = {};
  if (await fileExists(settingsPath)) {
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as ClaudeSettings;
    } catch {
      settings = {};
    }
  }

  const hooks = settings.hooks ?? {};
  const preToolUse = hooks.PreToolUse ?? [];
  const exists = preToolUse.some((entry) => entry.matcher === claudeHookMatcher && JSON.stringify(entry).includes("swarmvault:"));
  if (!exists) {
    preToolUse.push({
      matcher: claudeHookMatcher,
      hooks: [{ type: "command", command: claudeHookCommand }]
    });
  }

  settings.hooks = { ...hooks, PreToolUse: preToolUse };
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settingsPath;
}

function targetPathForAgent(rootDir: string, agent: AgentType): string {
  switch (agent) {
    case "codex":
    case "goose":
    case "pi":
    case "opencode":
      return path.join(rootDir, "AGENTS.md");
    case "claude":
      return path.join(rootDir, "CLAUDE.md");
    case "gemini":
      return path.join(rootDir, "GEMINI.md");
    case "cursor":
      return path.join(rootDir, ".cursor", "rules", "swarmvault.mdc");
    default:
      throw new Error(`Unsupported agent ${String(agent)}`);
  }
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

export async function installAgent(rootDir: string, agent: AgentType, options: InstallAgentOptions = {}): Promise<string> {
  await initWorkspace(rootDir);
  const target = targetPathForAgent(rootDir, agent);

  switch (agent) {
    case "codex":
    case "goose":
    case "pi":
    case "opencode":
      await upsertManagedBlock(target, buildManagedBlock("agents"));
      return target;
    case "claude": {
      await upsertManagedBlock(target, buildManagedBlock("claude"));
      if (options.claudeHook) {
        await installClaudeHook(rootDir);
      }
      return target;
    }
    case "gemini": {
      await upsertManagedBlock(target, buildManagedBlock("gemini"));
      return target;
    }
    case "cursor": {
      const rulesDir = path.dirname(target);
      await ensureDir(rulesDir);
      await fs.writeFile(target, `${buildManagedBlock("cursor")}\n`, "utf8");
      return target;
    }
    default:
      throw new Error(`Unsupported agent ${String(agent)}`);
  }
}

export async function installConfiguredAgents(rootDir: string): Promise<string[]> {
  const { config } = await initWorkspace(rootDir);
  const dedupedTargets = new Map<string, AgentType>();
  for (const agent of config.agents) {
    const target = targetPathForAgent(rootDir, agent);
    if (!dedupedTargets.has(target)) {
      dedupedTargets.set(target, agent);
    }
  }
  return Promise.all(
    [...dedupedTargets.values()].map((agent) =>
      installAgent(rootDir, agent, {
        claudeHook: agent === "claude"
      })
    )
  );
}
