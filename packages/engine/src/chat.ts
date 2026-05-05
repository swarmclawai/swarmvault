import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { loadVaultConfig } from "./config.js";
import type { AskChatOptions, AskChatResult, VaultChatSession, VaultChatSessionSummary, VaultChatTurn } from "./types.js";
import { ensureDir, fileExists, normalizeWhitespace, readJsonFile, safeFrontmatter, slugify, truncate, writeJsonFile } from "./utils.js";
import { queryVault } from "./vault.js";

const DEFAULT_HISTORY_TURNS = 6;

function timestampIdPrefix(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/u, "Z")
    .replace("T", "-");
}

function chatDirs(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"]): { stateDir: string; wikiDir: string } {
  return {
    stateDir: path.join(paths.stateDir, "chat-sessions"),
    wikiDir: path.join(paths.wikiDir, "outputs", "chat-sessions")
  };
}

function sessionStatePath(stateDir: string, id: string): string {
  return path.join(stateDir, `${id}.json`);
}

function sessionMarkdownPath(wikiDir: string, id: string): string {
  return path.join(wikiDir, `${id}.md`);
}

function summarizeSession(session: VaultChatSession): VaultChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    markdownPath: session.markdownPath
  };
}

function renderSessionMarkdown(session: VaultChatSession): string {
  const body = [
    `# ${session.title}`,
    "",
    `Session ID: \`${session.id}\``,
    `Updated: ${session.updatedAt}`,
    "",
    ...session.turns.flatMap((turn, index) => [
      `## Turn ${index + 1} - ${turn.createdAt}`,
      "",
      "### Question",
      "",
      turn.question,
      "",
      "### Answer",
      "",
      turn.answer,
      "",
      turn.citations.length ? "### Citations" : undefined,
      turn.citations.length ? "" : undefined,
      ...turn.citations.map((citation) => `- ${citation}`),
      turn.savedPath ? "" : undefined,
      turn.savedPath ? `Saved output: \`${turn.savedPath}\`` : undefined,
      ""
    ])
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return matter.stringify(
    body,
    safeFrontmatter({
      session_id: session.id,
      title: session.title,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      turn_count: session.turns.length,
      page_id: `chat:${session.id}`,
      freshness: "fresh",
      node_ids: [],
      source_ids: [],
      source_hashes: {}
    })
  );
}

async function persistSession(
  session: VaultChatSession,
  stateDir: string,
  wikiDir: string
): Promise<{ statePath: string; markdownPath: string }> {
  await ensureDir(stateDir);
  await ensureDir(wikiDir);
  const statePath = sessionStatePath(stateDir, session.id);
  const markdownPath = sessionMarkdownPath(wikiDir, session.id);
  const persisted: VaultChatSession = { ...session, markdownPath };
  await writeJsonFile(statePath, persisted);
  await fs.writeFile(markdownPath, renderSessionMarkdown(persisted), "utf8");
  return { statePath, markdownPath };
}

async function resolveSessionId(stateDir: string, idOrPrefix: string): Promise<string> {
  const direct = sessionStatePath(stateDir, idOrPrefix);
  if (await fileExists(direct)) {
    return idOrPrefix;
  }
  const entries = await fs.readdir(stateDir).catch(() => []);
  const matches = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 1) {
    return matches[0] as string;
  }
  if (matches.length > 1) {
    throw new Error(`Chat session prefix "${idOrPrefix}" is ambiguous: ${matches.slice(0, 8).join(", ")}`);
  }
  throw new Error(`Chat session not found: ${idOrPrefix}`);
}

async function loadSession(stateDir: string, idOrPrefix: string): Promise<VaultChatSession> {
  const id = await resolveSessionId(stateDir, idOrPrefix);
  const session = await readJsonFile<VaultChatSession>(sessionStatePath(stateDir, id));
  if (!session) {
    throw new Error(`Chat session not found: ${id}`);
  }
  return session;
}

function createSession(rootDir: string, wikiDir: string, options: AskChatOptions, now: string): VaultChatSession {
  const title = truncate(options.title?.trim() || normalizeWhitespace(options.question), 80);
  const id = `${timestampIdPrefix()}-${slugify(title)}`;
  return {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    rootDir,
    markdownPath: sessionMarkdownPath(wikiDir, id),
    turns: []
  };
}

function buildPrompt(session: VaultChatSession, question: string, maxHistoryTurns: number): string {
  const recentTurns = session.turns.slice(-maxHistoryTurns);
  if (!recentTurns.length) {
    return question;
  }
  const history = recentTurns
    .map((turn, index) =>
      [
        `Turn ${index + 1}`,
        `User: ${turn.question}`,
        `Assistant: ${truncate(normalizeWhitespace(turn.answer), 1200)}`,
        turn.citations.length ? `Citations: ${turn.citations.join(", ")}` : undefined
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n")
    )
    .join("\n\n");
  return [
    "Continue this SwarmVault chat session using the compiled wiki as the source of truth.",
    "Use prior turns only for conversational continuity. Prefer current vault evidence over prior wording.",
    "",
    "Prior turns:",
    history,
    "",
    "Current question:",
    question
  ].join("\n");
}

export async function listChatSessions(rootDir: string): Promise<VaultChatSessionSummary[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const { stateDir } = chatDirs(paths);
  const entries = await fs.readdir(stateDir).catch(() => []);
  const sessions = await Promise.all(
    entries.filter((entry) => entry.endsWith(".json")).map(async (entry) => readJsonFile<VaultChatSession>(path.join(stateDir, entry)))
  );
  return sessions
    .filter((session): session is VaultChatSession => Boolean(session))
    .map(summarizeSession)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readChatSession(rootDir: string, idOrPrefix: string): Promise<VaultChatSession> {
  const { paths } = await loadVaultConfig(rootDir);
  const { stateDir } = chatDirs(paths);
  return loadSession(stateDir, idOrPrefix);
}

export async function deleteChatSession(rootDir: string, idOrPrefix: string): Promise<VaultChatSessionSummary> {
  const { paths } = await loadVaultConfig(rootDir);
  const { stateDir, wikiDir } = chatDirs(paths);
  const session = await loadSession(stateDir, idOrPrefix);
  await fs.rm(sessionStatePath(stateDir, session.id), { force: true });
  await fs.rm(sessionMarkdownPath(wikiDir, session.id), { force: true });
  return summarizeSession(session);
}

export async function askChatSession(rootDir: string, options: AskChatOptions): Promise<AskChatResult> {
  const question = normalizeWhitespace(options.question);
  if (!question) {
    throw new Error("Chat question is required.");
  }

  const { paths } = await loadVaultConfig(rootDir);
  const { stateDir, wikiDir } = chatDirs(paths);
  const now = new Date().toISOString();
  const resumed = Boolean(options.sessionId);
  const session = options.sessionId ? await loadSession(stateDir, options.sessionId) : createSession(paths.rootDir, wikiDir, options, now);
  const prompt = buildPrompt(session, question, Math.max(0, options.maxHistoryTurns ?? DEFAULT_HISTORY_TURNS));
  const query = await queryVault(paths.rootDir, {
    question: prompt,
    save: options.saveOutput ?? false,
    format: options.format,
    gapFill: options.gapFill
  });

  const turn: VaultChatTurn = {
    id: `${session.turns.length + 1}`,
    createdAt: now,
    question,
    answer: query.answer,
    citations: query.citations,
    relatedPageIds: query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    relatedSourceIds: query.relatedSourceIds,
    outputFormat: query.outputFormat,
    savedPath: query.savedPath
  };
  const updatedSession: VaultChatSession = {
    ...session,
    updatedAt: now,
    markdownPath: sessionMarkdownPath(wikiDir, session.id),
    turns: [...session.turns, turn]
  };
  const persisted = await persistSession(updatedSession, stateDir, wikiDir);

  return {
    session: { ...updatedSession, markdownPath: persisted.markdownPath },
    turn,
    answer: query.answer,
    markdownPath: persisted.markdownPath,
    statePath: persisted.statePath,
    resumed
  };
}
