import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { initWorkspace } from "./config.js";
import type { WatchRunRecord } from "./types.js";
import { appendJsonLine, ensureDir, fileExists, slugify, writeFileIfChanged } from "./utils.js";

type SessionOperation = "compile" | "query" | "explore" | "lint" | "watch" | "review" | "candidate";

export interface SessionRecordInput {
  operation: SessionOperation;
  title: string;
  startedAt: string;
  finishedAt?: string;
  providerId?: string;
  success?: boolean;
  error?: string;
  relatedSourceIds?: string[];
  relatedPageIds?: string[];
  relatedNodeIds?: string[];
  changedPages?: string[];
  citations?: string[];
  lintFindingCount?: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  lines?: string[];
}

async function resolveUniqueSessionPath(rootDir: string, operation: SessionOperation, title: string, startedAt: string): Promise<string> {
  const { paths } = await initWorkspace(rootDir);
  await ensureDir(paths.sessionsDir);
  const timestamp = startedAt.replace(/[:.]/g, "-");
  const baseName = `${timestamp}-${operation}-${slugify(title)}`;
  let candidate = path.join(paths.sessionsDir, `${baseName}.md`);
  let counter = 2;

  while (await fileExists(candidate)) {
    candidate = path.join(paths.sessionsDir, `${baseName}-${counter}.md`);
    counter++;
  }

  return candidate;
}

export async function appendLogEntry(rootDir: string, action: string, title: string, lines: string[] = []): Promise<void> {
  const { paths } = await initWorkspace(rootDir);
  await ensureDir(paths.wikiDir);
  const logPath = path.join(paths.wikiDir, "log.md");
  const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
  const entry = [`## [${timestamp}] ${action} | ${title}`, ...lines.map((line) => `- ${line}`), ""].join("\n");
  const existing = (await fileExists(logPath)) ? await fs.readFile(logPath, "utf8") : "# Log\n\n";
  await fs.writeFile(logPath, `${existing}${entry}\n`, "utf8");
}

export async function recordSession(rootDir: string, input: SessionRecordInput): Promise<{ sessionPath: string; sessionId: string }> {
  const { paths } = await initWorkspace(rootDir);
  await ensureDir(paths.wikiDir);

  const startedAtIso = new Date(input.startedAt).toISOString();
  const finishedAtIso = new Date(input.finishedAt ?? input.startedAt).toISOString();
  const durationMs = Math.max(0, new Date(finishedAtIso).getTime() - new Date(startedAtIso).getTime());
  const sessionPath = await resolveUniqueSessionPath(rootDir, input.operation, input.title, startedAtIso);
  const sessionId = path.basename(sessionPath, ".md");
  const relativeSessionPath = path.relative(rootDir, sessionPath).split(path.sep).join(path.posix.sep);
  const frontmatter = Object.fromEntries(
    Object.entries({
      session_id: sessionId,
      operation: input.operation,
      title: input.title,
      started_at: startedAtIso,
      finished_at: finishedAtIso,
      duration_ms: durationMs,
      provider: input.providerId,
      success: input.success ?? true,
      error: input.error,
      related_source_ids: input.relatedSourceIds ?? [],
      related_page_ids: input.relatedPageIds ?? [],
      related_node_ids: input.relatedNodeIds ?? [],
      changed_pages: input.changedPages ?? [],
      citations: input.citations ?? [],
      lint_finding_count: input.lintFindingCount,
      token_usage: input.tokenUsage
    }).filter(([, value]) => value !== undefined)
  );

  const content = matter.stringify(
    [
      `# ${input.operation[0]?.toUpperCase() ?? ""}${input.operation.slice(1)} Session`,
      "",
      `Title: ${input.title}`,
      "",
      "## Summary",
      "",
      ...(input.lines?.length ? input.lines.map((line) => `- ${line}`) : ["- No additional notes recorded."]),
      "",
      "## Related",
      "",
      `- Sources: ${(input.relatedSourceIds ?? []).join(", ") || "none"}`,
      `- Pages: ${(input.relatedPageIds ?? []).join(", ") || "none"}`,
      `- Nodes: ${(input.relatedNodeIds ?? []).join(", ") || "none"}`,
      `- Changed pages: ${(input.changedPages ?? []).join(", ") || "none"}`,
      `- Citations: ${(input.citations ?? []).join(", ") || "none"}`,
      input.lintFindingCount === undefined ? undefined : `- Lint findings: ${input.lintFindingCount}`,
      input.providerId ? `- Provider: ${input.providerId}` : undefined,
      input.success === undefined ? undefined : `- Success: ${input.success}`,
      input.error ? `- Error: ${input.error}` : undefined,
      input.tokenUsage?.inputTokens !== undefined || input.tokenUsage?.outputTokens !== undefined
        ? `- Tokens: in=${input.tokenUsage?.inputTokens ?? "n/a"}, out=${input.tokenUsage?.outputTokens ?? "n/a"}`
        : undefined,
      ""
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    frontmatter
  );
  await writeFileIfChanged(sessionPath, content);

  const logPath = path.join(paths.wikiDir, "log.md");
  const timestamp = startedAtIso.slice(0, 19).replace("T", " ");
  const entry = [
    `## [${timestamp}] ${input.operation} | ${input.title}`,
    `- session: \`${relativeSessionPath}\``,
    ...(input.lines ?? []).map((line) => `- ${line}`),
    ""
  ].join("\n");
  const existing = (await fileExists(logPath)) ? await fs.readFile(logPath, "utf8") : "# Log\n\n";
  await fs.writeFile(logPath, `${existing}${entry}\n`, "utf8");
  return { sessionPath, sessionId };
}

export async function appendWatchRun(rootDir: string, run: WatchRunRecord): Promise<void> {
  const { paths } = await initWorkspace(rootDir);
  await appendJsonLine(paths.jobsLogPath, run);
}
