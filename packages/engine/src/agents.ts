import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { initWorkspace } from "./config.js";
import type { AgentType, InstallAgentOptions, InstallAgentResult } from "./types.js";
import { ensureDir, fileExists } from "./utils.js";

const managedStart = "<!-- swarmvault:managed:start -->";
const managedEnd = "<!-- swarmvault:managed:end -->";
const legacyManagedStart = "<!-- vault:managed:start -->";
const legacyManagedEnd = "<!-- vault:managed:end -->";

const claudeHookMatcher = "Glob|Grep";
const claudeHookCommand =
  "if [ -f wiki/graph/report.md ]; then echo 'swarmvault: Graph report exists. Read wiki/graph/report.md before broad raw-file searching.'; fi";

const geminiSessionMatcher = "startup";
const geminiSearchMatcher = "glob|grep|search|find";
const copilotHookVersion = 1;

type JsonWarningResult<T> = {
  data: T;
  warnings: string[];
};

type ClaudeSettings = {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
  };
};

type GeminiSettings = {
  hooks?: {
    SessionStart?: Array<{
      matcher?: string;
      hooks?: Array<{ name?: string; type?: string; command?: string }>;
    }>;
    BeforeTool?: Array<{
      matcher?: string;
      hooks?: Array<{ name?: string; type?: string; command?: string }>;
    }>;
  };
};

type CopilotHookConfig = {
  version?: number;
  hooks?: {
    sessionStart?: Array<{
      type?: string;
      bash?: string;
      powershell?: string;
      cwd?: string;
      timeoutSec?: number;
    }>;
    preToolUse?: Array<{
      matcher?: string;
      type?: string;
      bash?: string;
      powershell?: string;
      cwd?: string;
      timeoutSec?: number;
    }>;
  };
};

const agentFileKinds = {
  agents: "AGENTS.md",
  claude: "CLAUDE.md",
  gemini: "GEMINI.md",
  cursor: ".cursor/rules/swarmvault.mdc",
  aider: "CONVENTIONS.md",
  copilot: ".github/copilot-instructions.md"
} as const;

function buildManagedBlock(target: keyof typeof agentFileKinds): string {
  const heading =
    target === "aider" ? "# SwarmVault Conventions" : target === "copilot" ? "# SwarmVault Repository Instructions" : "# SwarmVault Rules";
  return [
    managedStart,
    heading,
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
}

function supportsAgentHook(agent: AgentType): boolean {
  return agent === "claude" || agent === "opencode" || agent === "gemini" || agent === "copilot";
}

function primaryTargetPathForAgent(rootDir: string, agent: AgentType): string {
  switch (agent) {
    case "codex":
    case "goose":
    case "pi":
    case "opencode":
      return path.join(rootDir, agentFileKinds.agents);
    case "claude":
      return path.join(rootDir, agentFileKinds.claude);
    case "gemini":
      return path.join(rootDir, agentFileKinds.gemini);
    case "cursor":
      return path.join(rootDir, agentFileKinds.cursor);
    case "aider":
      return path.join(rootDir, agentFileKinds.aider);
    case "copilot":
      return path.join(rootDir, agentFileKinds.copilot);
    default:
      throw new Error(`Unsupported agent ${String(agent)}`);
  }
}

function hookScriptPathForAgent(rootDir: string, agent: AgentType): string | null {
  switch (agent) {
    case "opencode":
      return path.join(rootDir, ".opencode", "plugins", "swarmvault-graph-first.js");
    case "gemini":
      return path.join(rootDir, ".gemini", "hooks", "swarmvault-graph-first.js");
    case "copilot":
      return path.join(rootDir, ".github", "hooks", "swarmvault-graph-first.js");
    default:
      return null;
  }
}

function hookConfigPathForAgent(rootDir: string, agent: AgentType): string | null {
  switch (agent) {
    case "claude":
      return path.join(rootDir, ".claude", "settings.json");
    case "gemini":
      return path.join(rootDir, ".gemini", "settings.json");
    case "copilot":
      return path.join(rootDir, ".github", "hooks", "swarmvault-graph-first.json");
    default:
      return null;
  }
}

function targetsForAgent(rootDir: string, agent: AgentType, options: InstallAgentOptions = {}): string[] {
  const targets = [primaryTargetPathForAgent(rootDir, agent)];

  if (agent === "copilot") {
    targets.push(path.join(rootDir, agentFileKinds.agents));
  }

  if (agent === "aider") {
    targets.push(path.join(rootDir, ".aider.conf.yml"));
  }

  if (options.hook && supportsAgentHook(agent)) {
    const configPath = hookConfigPathForAgent(rootDir, agent);
    const scriptPath = hookScriptPathForAgent(rootDir, agent);
    if (configPath) {
      targets.push(configPath);
    }
    if (scriptPath) {
      targets.push(scriptPath);
    }
  }

  return [...new Set(targets)];
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

async function writeOwnedFile(filePath: string, content: string, executable = false): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, {
    encoding: "utf8",
    mode: executable ? 0o755 : 0o644
  });
  if (executable) {
    await fs.chmod(filePath, 0o755);
  }
}

async function readJsonWithWarnings<T extends object>(filePath: string, fallback: T, label: string): Promise<JsonWarningResult<T>> {
  if (!(await fileExists(filePath))) {
    return { data: fallback, warnings: [] };
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as T;
    return { data: parsed, warnings: [] };
  } catch {
    return {
      data: fallback,
      warnings: [`Could not parse ${label}. Left the existing file unchanged.`]
    };
  }
}

async function installClaudeHook(rootDir: string): Promise<{ path: string; warnings: string[] }> {
  const settingsPath = path.join(rootDir, ".claude", "settings.json");
  await ensureDir(path.dirname(settingsPath));

  const { data: settings, warnings } = await readJsonWithWarnings<ClaudeSettings>(settingsPath, {}, ".claude/settings.json");
  if (warnings.length > 0 && (await fileExists(settingsPath))) {
    return { path: settingsPath, warnings };
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
  return { path: settingsPath, warnings: [] };
}

function markerStateSnippet(agentKey: string): string {
  return `
function markerState(cwd) {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex");
  const dir = path.join(os.tmpdir(), "swarmvault-agent-hooks", "${agentKey}", hash);
  return {
    dir,
    markerPath: path.join(dir, "report-read")
  };
}

function isReportPath(value, cwd) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const reportSuffix = path.join("wiki", "graph", "report.md");
  const normalized = value.replaceAll("\\\\", "/");
  const reportNormalized = reportSuffix.replaceAll("\\\\", "/");
  if (normalized.endsWith(reportNormalized)) {
    return true;
  }
  return path.resolve(cwd, value) === path.resolve(cwd, reportSuffix);
}

function collectCandidatePaths(node, acc = []) {
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (!node || typeof node !== "object") {
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectCandidatePaths(item, acc);
    }
    return acc;
  }
  for (const [key, value] of Object.entries(node)) {
    if (["path", "filePath", "file_path", "paths", "target", "targets"].includes(key)) {
      collectCandidatePaths(value, acc);
    }
  }
  return acc;
}

function resolveInputCwd(input) {
  return path.resolve(
    input?.cwd ??
      input?.directory ??
      input?.workspace?.cwd ??
      input?.toolInput?.cwd ??
      process.cwd()
  );
}

function resolveToolName(input) {
  return String(input?.toolName ?? input?.tool_name ?? input?.tool?.name ?? input?.name ?? "");
}

async function hasReport(cwd) {
  try {
    await fs.access(path.join(cwd, "wiki", "graph", "report.md"));
    return true;
  } catch {
    return false;
  }
}

async function markReportRead(cwd) {
  const state = markerState(cwd);
  await fs.mkdir(state.dir, { recursive: true });
  await fs.writeFile(state.markerPath, "seen\\n", "utf8");
}

async function hasSeenReport(cwd) {
  const state = markerState(cwd);
  try {
    await fs.access(state.markerPath);
    return true;
  } catch {
    return false;
  }
}

async function resetSession(cwd) {
  const state = markerState(cwd);
  await fs.rm(state.dir, { recursive: true, force: true });
}

function isBroadSearchTool(toolName) {
  return /grep|glob|search|find/i.test(toolName);
}
`;
}

function buildGeminiHookScript(): string {
  return `#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

${markerStateSnippet("gemini").trim()}

async function readInput() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
  }
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function emit(value) {
  process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
}

const mode = process.argv[2] ?? "";
const input = await readInput();
const cwd = resolveInputCwd(input);
const reportNote = "SwarmVault graph report exists at wiki/graph/report.md. Read it before broad grep/glob searching.";

if (!(await hasReport(cwd))) {
  emit({});
  process.exit(0);
}

if (mode === "session-start") {
  await resetSession(cwd);
  emit({
    systemMessage: reportNote,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "SwarmVault graph report: wiki/graph/report.md"
    }
  });
  process.exit(0);
}

const toolName = resolveToolName(input);
if (collectCandidatePaths(input).some((value) => isReportPath(value, cwd))) {
  await markReportRead(cwd);
  emit({});
  process.exit(0);
}

if (isBroadSearchTool(toolName) && !(await hasSeenReport(cwd))) {
  emit({ systemMessage: reportNote });
  process.exit(0);
}

emit({});
`;
}

function buildCopilotHookScript(): string {
  return `#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

${markerStateSnippet("copilot").trim()}

async function readInput() {
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
  }
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function emit(value) {
  if (value !== undefined) {
    process.stdout.write(\`\${JSON.stringify(value)}\\n\`);
  }
}

const mode = process.argv[2] ?? "";
const input = await readInput();
const cwd = resolveInputCwd(input);
const reportNote = "SwarmVault graph report exists at wiki/graph/report.md. Read it before broad grep/glob searching.";

if (!(await hasReport(cwd))) {
  emit({});
  process.exit(0);
}

if (mode === "session-start") {
  await resetSession(cwd);
  emit({});
  process.exit(0);
}

const toolName = resolveToolName(input);
if (collectCandidatePaths(input).some((value) => isReportPath(value, cwd))) {
  await markReportRead(cwd);
  emit({});
  process.exit(0);
}

if (isBroadSearchTool(toolName) && !(await hasSeenReport(cwd))) {
  emit({
    permissionDecision: "deny",
    permissionDecisionReason: reportNote
  });
  process.exit(0);
}

emit({});
`;
}

function buildOpenCodePlugin(): string {
  return `import path from "node:path";

const reportRelativePath = path.join("wiki", "graph", "report.md");

export const name = "swarmvault-graph-first";

export default async function swarmvaultGraphFirst({ client }) {
  let reportSeen = false;

  async function hasReport(cwd) {
    try {
      await Bun.file(path.join(cwd, reportRelativePath)).arrayBuffer();
      return true;
    } catch {
      return false;
    }
  }

  async function note(message) {
    if (client?.app?.log) {
      await client.app.log({
        level: "info",
        message
      });
    }
  }

  return {
    async "session.created"(input) {
      reportSeen = false;
      const cwd = input?.session?.cwd ?? process.cwd();
      if (await hasReport(cwd)) {
        await note("SwarmVault graph report exists. Read wiki/graph/report.md before broad workspace searching.");
      }
    },
    async "tool.execute.before"(input) {
      const cwd = input?.session?.cwd ?? process.cwd();
      if (!(await hasReport(cwd))) {
        return;
      }

      const argsText = JSON.stringify(input?.args ?? {});
      if (argsText.includes("wiki/graph/report.md")) {
        reportSeen = true;
        return;
      }

      if (!reportSeen && ["glob", "grep"].includes(String(input?.tool ?? ""))) {
        await note("SwarmVault graph report exists. Read wiki/graph/report.md before broad workspace searching.");
      }
    }
  };
}
`;
}

async function installGeminiHook(rootDir: string): Promise<{ paths: string[]; warnings: string[] }> {
  const settingsPath = path.join(rootDir, ".gemini", "settings.json");
  const scriptPath = path.join(rootDir, ".gemini", "hooks", "swarmvault-graph-first.js");
  await writeOwnedFile(scriptPath, buildGeminiHookScript(), true);

  const { data: settings, warnings } = await readJsonWithWarnings<GeminiSettings>(settingsPath, {}, ".gemini/settings.json");
  if (warnings.length > 0 && (await fileExists(settingsPath))) {
    return { paths: [settingsPath, scriptPath], warnings };
  }

  const hooks = settings.hooks ?? {};
  const sessionStart = hooks.SessionStart ?? [];
  const beforeTool = hooks.BeforeTool ?? [];
  const sessionCommand = "node .gemini/hooks/swarmvault-graph-first.js session-start";
  const beforeToolCommand = "node .gemini/hooks/swarmvault-graph-first.js before-tool";

  if (
    !sessionStart.some((entry) => entry.matcher === geminiSessionMatcher && JSON.stringify(entry).includes("swarmvault-graph-first.js"))
  ) {
    sessionStart.push({
      matcher: geminiSessionMatcher,
      hooks: [{ name: "swarmvault-graph-first", type: "command", command: sessionCommand }]
    });
  }

  if (!beforeTool.some((entry) => entry.matcher === geminiSearchMatcher && JSON.stringify(entry).includes("swarmvault-graph-first.js"))) {
    beforeTool.push({
      matcher: geminiSearchMatcher,
      hooks: [{ name: "swarmvault-graph-first", type: "command", command: beforeToolCommand }]
    });
  }

  settings.hooks = {
    ...hooks,
    SessionStart: sessionStart,
    BeforeTool: beforeTool
  };

  await writeOwnedFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { paths: [settingsPath, scriptPath], warnings: [] };
}

async function mergeAiderConfig(rootDir: string): Promise<{ path: string; warnings: string[] }> {
  const configPath = path.join(rootDir, ".aider.conf.yml");
  const readTarget = "CONVENTIONS.md";
  if (!(await fileExists(configPath))) {
    const document = new YAML.Document();
    document.set("read", [readTarget]);
    await writeOwnedFile(configPath, `${document.toString()}`);
    return { path: configPath, warnings: [] };
  }

  try {
    const source = await fs.readFile(configPath, "utf8");
    const document = YAML.parseDocument(source);
    if (document.errors.length > 0) {
      return {
        path: configPath,
        warnings: ["Could not parse .aider.conf.yml. Left the existing file unchanged; add `read: CONVENTIONS.md` manually."]
      };
    }
    const currentRead = document.get("read", true);
    const values =
      typeof currentRead === "string"
        ? [currentRead]
        : Array.isArray(currentRead)
          ? currentRead.filter((item): item is string => typeof item === "string")
          : [];
    if (!values.includes(readTarget)) {
      document.set("read", [...values, readTarget]);
      await writeOwnedFile(configPath, `${document.toString()}`);
    }
    return { path: configPath, warnings: [] };
  } catch {
    return {
      path: configPath,
      warnings: ["Could not parse .aider.conf.yml. Left the existing file unchanged; add `read: CONVENTIONS.md` manually."]
    };
  }
}

async function installCopilotHook(rootDir: string): Promise<{ paths: string[]; warnings: string[] }> {
  const hooksDir = path.join(rootDir, ".github", "hooks");
  const scriptPath = path.join(hooksDir, "swarmvault-graph-first.js");
  const configPath = path.join(hooksDir, "swarmvault-graph-first.json");
  await writeOwnedFile(scriptPath, buildCopilotHookScript(), true);

  const config: CopilotHookConfig = {
    version: copilotHookVersion,
    hooks: {
      sessionStart: [
        {
          type: "command",
          bash: "node .github/hooks/swarmvault-graph-first.js session-start",
          powershell: "node .github/hooks/swarmvault-graph-first.js session-start",
          cwd: ".",
          timeoutSec: 10
        }
      ],
      preToolUse: [
        {
          matcher: "glob|grep",
          type: "command",
          bash: "node .github/hooks/swarmvault-graph-first.js pre-tool-use",
          powershell: "node .github/hooks/swarmvault-graph-first.js pre-tool-use",
          cwd: ".",
          timeoutSec: 10
        }
      ]
    }
  };

  await writeOwnedFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { paths: [configPath, scriptPath], warnings: [] };
}

async function installOpenCodeHook(rootDir: string): Promise<{ paths: string[]; warnings: string[] }> {
  const pluginPath = path.join(rootDir, ".opencode", "plugins", "swarmvault-graph-first.js");
  await writeOwnedFile(pluginPath, buildOpenCodePlugin());
  return { paths: [pluginPath], warnings: [] };
}

function stableKeyForAgent(rootDir: string, agent: AgentType): string {
  if (agent === "codex" || agent === "goose" || agent === "pi") {
    return `shared:${path.join(rootDir, agentFileKinds.agents)}`;
  }
  return `${agent}:${crypto
    .createHash("sha1")
    .update(targetsForAgent(rootDir, agent, { hook: supportsAgentHook(agent) }).join("\n"))
    .digest("hex")}`;
}

export async function installAgent(rootDir: string, agent: AgentType, options: InstallAgentOptions = {}): Promise<InstallAgentResult> {
  await initWorkspace(rootDir);
  const target = primaryTargetPathForAgent(rootDir, agent);
  const warnings: string[] = [];

  switch (agent) {
    case "codex":
    case "goose":
    case "pi":
    case "opencode":
      await upsertManagedBlock(path.join(rootDir, agentFileKinds.agents), buildManagedBlock("agents"));
      break;
    case "claude":
      await upsertManagedBlock(target, buildManagedBlock("claude"));
      break;
    case "gemini":
      await upsertManagedBlock(target, buildManagedBlock("gemini"));
      break;
    case "cursor":
      await writeOwnedFile(target, `${buildManagedBlock("cursor")}\n`);
      break;
    case "aider":
      await upsertManagedBlock(target, buildManagedBlock("aider"));
      break;
    case "copilot":
      await upsertManagedBlock(path.join(rootDir, agentFileKinds.agents), buildManagedBlock("agents"));
      await upsertManagedBlock(target, buildManagedBlock("copilot"));
      break;
    default:
      throw new Error(`Unsupported agent ${String(agent)}`);
  }

  if (agent === "aider") {
    const aiderResult = await mergeAiderConfig(rootDir);
    warnings.push(...aiderResult.warnings);
  }

  if (options.hook && supportsAgentHook(agent)) {
    if (agent === "claude") {
      const result = await installClaudeHook(rootDir);
      warnings.push(...result.warnings);
    }
    if (agent === "opencode") {
      const result = await installOpenCodeHook(rootDir);
      warnings.push(...result.warnings);
    }
    if (agent === "gemini") {
      const result = await installGeminiHook(rootDir);
      warnings.push(...result.warnings);
    }
    if (agent === "copilot") {
      const result = await installCopilotHook(rootDir);
      warnings.push(...result.warnings);
    }
  }

  const targets = targetsForAgent(rootDir, agent, options);
  return warnings.length > 0 ? { agent, target, targets, warnings } : { agent, target, targets };
}

export async function installConfiguredAgents(rootDir: string): Promise<InstallAgentResult[]> {
  const { config } = await initWorkspace(rootDir);
  const dedupedAgents = new Map<string, AgentType>();

  for (const agent of config.agents) {
    const key = stableKeyForAgent(rootDir, agent);
    if (!dedupedAgents.has(key)) {
      dedupedAgents.set(key, agent);
    }
  }

  return Promise.all(
    [...dedupedAgents.values()].map((agent) =>
      installAgent(rootDir, agent, {
        hook: supportsAgentHook(agent)
      })
    )
  );
}
