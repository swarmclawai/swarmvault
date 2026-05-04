import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { resolveArtifactRootDir } from "./config.js";
import { buildContextPack, readContextPack, renderContextPackLlms, renderContextPackMarkdown } from "./context-packs.js";
import { estimateTokens } from "./token-estimation.js";
import type {
  AgentMemoryResumeFormat,
  AgentMemoryTask,
  AgentMemoryTaskResult,
  AgentMemoryTaskSummary,
  FinishMemoryTaskOptions,
  GraphEdge,
  GraphNode,
  GraphPage,
  ResumeMemoryTaskOptions,
  ResumeMemoryTaskResult,
  StartMemoryTaskOptions,
  UpdateMemoryTaskOptions
} from "./types.js";
import {
  ensureDir,
  fileExists,
  isPathWithin,
  normalizeWhitespace,
  readJsonFile,
  sha256,
  slugify,
  toPosix,
  truncate,
  uniqueBy,
  writeJsonFile
} from "./utils.js";

const DEFAULT_MEMORY_CONTEXT_BUDGET = 8000;

const memoryTaskStatusSchema = z.enum(["active", "blocked", "completed", "archived"]);

const memoryNoteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.string().min(1)
});

const memoryDecisionSchema = memoryNoteSchema;

const memoryTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  status: memoryTaskStatusSchema,
  target: z.string().optional(),
  agent: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  contextPackIds: z.array(z.string()).default([]),
  sessionIds: z.array(z.string()).default([]),
  sourceIds: z.array(z.string()).default([]),
  pageIds: z.array(z.string()).default([]),
  nodeIds: z.array(z.string()).default([]),
  changedPaths: z.array(z.string()).default([]),
  gitRefs: z.array(z.string()).default([]),
  notes: z.array(memoryNoteSchema).default([]),
  decisions: z.array(memoryDecisionSchema).default([]),
  outcome: z.string().optional(),
  followUps: z.array(z.string()).default([]),
  artifactPath: z.string().min(1),
  markdownPath: z.string().min(1)
});

type MemoryDirs = {
  stateDir: string;
  tasksStateDir: string;
  wikiDir: string;
  tasksWikiDir: string;
  indexPath: string;
};

export type MemoryTaskStoredPage = {
  task: AgentMemoryTask;
  page: GraphPage;
  content: string;
  contentHash: string;
};

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.map((value) => value.trim()).filter(Boolean), (value) => value);
}

function memoryDirs(rootDir: string): MemoryDirs {
  const artifactRootDir = resolveArtifactRootDir(rootDir);
  const stateDir = path.join(artifactRootDir, "state", "memory");
  const wikiDir = path.join(artifactRootDir, "wiki", "memory");
  return {
    stateDir,
    tasksStateDir: path.join(stateDir, "tasks"),
    wikiDir,
    tasksWikiDir: path.join(wikiDir, "tasks"),
    indexPath: path.join(wikiDir, "index.md")
  };
}

function titleForGoal(goal: string): string {
  return `Memory Task: ${truncate(normalizeWhitespace(goal), 72)}`;
}

function normalizePathRef(value: string): string {
  return toPosix(
    value
      .trim()
      .replace(/^wiki\//, "")
      .replace(/^\.\//, "")
  );
}

function taskSummary(task: AgentMemoryTask): AgentMemoryTaskSummary {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    target: task.target,
    agent: task.agent,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    contextPackIds: task.contextPackIds,
    changedPaths: task.changedPaths,
    decisionCount: task.decisions.length,
    followUpCount: task.followUps.length,
    artifactPath: task.artifactPath,
    markdownPath: task.markdownPath
  };
}

async function uniqueMemoryTaskPaths(
  rootDir: string,
  createdAt: string,
  goal: string
): Promise<{ id: string; artifactPath: string; markdownPath: string }> {
  const dirs = memoryDirs(rootDir);
  await ensureDir(dirs.tasksStateDir);
  await ensureDir(dirs.tasksWikiDir);

  const timestamp = createdAt.replace(/[:.]/g, "-");
  const base = `${timestamp}-${slugify(goal)}`;
  let id = base;
  let artifactPath = path.join(dirs.tasksStateDir, `${id}.json`);
  let markdownPath = path.join(dirs.tasksWikiDir, `${id}.md`);
  let counter = 2;
  while ((await fileExists(artifactPath)) || (await fileExists(markdownPath))) {
    id = `${base}-${counter}`;
    artifactPath = path.join(dirs.tasksStateDir, `${id}.json`);
    markdownPath = path.join(dirs.tasksWikiDir, `${id}.md`);
    counter++;
  }
  return { id, artifactPath, markdownPath };
}

function noteId(prefix: "note" | "decision", createdAt: string, count: number): string {
  return `${prefix}:${createdAt.replace(/[:.]/g, "-")}:${count + 1}`;
}

function normalizeTask(raw: unknown): AgentMemoryTask {
  const parsed = memoryTaskSchema.parse(raw);
  return {
    ...parsed,
    contextPackIds: uniqueStrings(parsed.contextPackIds),
    sessionIds: uniqueStrings(parsed.sessionIds),
    sourceIds: uniqueStrings(parsed.sourceIds),
    pageIds: uniqueStrings(parsed.pageIds),
    nodeIds: uniqueStrings(parsed.nodeIds),
    changedPaths: uniqueStrings(parsed.changedPaths.map(normalizePathRef)),
    gitRefs: uniqueStrings(parsed.gitRefs),
    notes: parsed.notes,
    decisions: parsed.decisions,
    followUps: uniqueStrings(parsed.followUps)
  };
}

function frontmatterForTask(task: AgentMemoryTask): Record<string, unknown> {
  return {
    page_id: `memory:${task.id}`,
    kind: "memory_task",
    title: task.title,
    tags: ["agent-task", "agent-memory", "memory-task", `status/${task.status}`],
    source_ids: task.sourceIds,
    project_ids: [],
    node_ids: [`memory:${task.id}`, ...task.decisions.map((decision) => `decision:${task.id}:${decision.id}`), ...task.nodeIds],
    freshness: task.status === "completed" || task.status === "archived" ? "fresh" : "stale",
    status: task.status,
    confidence: 1,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    compiled_from: task.contextPackIds,
    managed_by: "system",
    backlinks: [],
    schema_hash: "",
    source_hashes: {},
    source_semantic_hashes: {},
    memory_task_id: task.id,
    memory_status: task.status,
    task_id: task.id,
    task_status: task.status,
    goal: task.goal,
    target: task.target,
    agent: task.agent,
    context_pack_ids: task.contextPackIds,
    related_page_ids: task.pageIds,
    related_node_ids: task.nodeIds,
    related_source_ids: task.sourceIds,
    git_refs: task.gitRefs,
    changed_paths: task.changedPaths
  };
}

function markdownList(values: string[], empty = "- none"): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : empty;
}

function datedList(values: Array<{ text: string; createdAt: string }>, empty = "- none"): string {
  return values.length ? values.map((value) => `- ${value.text} (${value.createdAt})`).join("\n") : empty;
}

export function renderMemoryTaskMarkdown(task: AgentMemoryTask): string {
  const body = [
    `# ${task.title}`,
    "",
    `Goal: ${task.goal}`,
    `Status: ${task.status}`,
    task.target ? `Target: ${task.target}` : undefined,
    task.agent ? `Agent: ${task.agent}` : undefined,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
    "",
    "## Context Packs",
    "",
    markdownList(task.contextPackIds),
    "",
    "## Decisions",
    "",
    datedList(task.decisions),
    "",
    "## Notes",
    "",
    datedList(task.notes),
    "",
    "## Changed Paths",
    "",
    markdownList(task.changedPaths),
    "",
    "## Graph Evidence",
    "",
    task.sourceIds.length ? `Sources:\n${markdownList(task.sourceIds)}` : "Sources:\n- none",
    "",
    task.pageIds.length ? `Pages:\n${markdownList(task.pageIds)}` : "Pages:\n- none",
    "",
    task.nodeIds.length ? `Nodes:\n${markdownList(task.nodeIds)}` : "Nodes:\n- none",
    "",
    "## Outcome",
    "",
    task.outcome ?? "Not finished yet.",
    "",
    "## Follow-Ups",
    "",
    markdownList(task.followUps),
    ""
  ].filter((line): line is string => line !== undefined);
  return matter.stringify(body.join("\n"), frontmatterForTask(task));
}

function renderMemoryTaskIndex(tasks: AgentMemoryTaskSummary[], generatedAt: string): string {
  const active = tasks.filter((task) => task.status === "active" || task.status === "blocked");
  const completed = tasks.filter((task) => task.status === "completed" || task.status === "archived");
  const section = (title: string, entries: AgentMemoryTaskSummary[]) => [
    `## ${title}`,
    "",
    entries.length
      ? entries.map((task) => `- [${task.title}](tasks/${path.basename(task.markdownPath)}) — ${task.status} — ${task.goal}`).join("\n")
      : "- none",
    ""
  ];
  return matter.stringify(["# Agent Tasks", "", ...section("Open Tasks", active), ...section("Completed Tasks", completed)].join("\n"), {
    page_id: "memory:index",
    kind: "index",
    title: "Agent Tasks",
    tags: ["index", "agent-task", "agent-memory"],
    source_ids: [],
    project_ids: [],
    node_ids: tasks.map((task) => `memory:${task.id}`),
    freshness: "fresh",
    status: "active",
    confidence: 1,
    created_at: generatedAt,
    updated_at: generatedAt,
    compiled_from: tasks.map((task) => task.id),
    managed_by: "system",
    backlinks: [],
    schema_hash: "",
    source_hashes: {},
    source_semantic_hashes: {}
  });
}

export async function ensureMemoryLedger(rootDir: string): Promise<{ changed: string[] }> {
  const dirs = memoryDirs(rootDir);
  await ensureDir(dirs.tasksStateDir);
  await ensureDir(dirs.tasksWikiDir);
  const summaries = await listMemoryTasks(rootDir);
  const content = renderMemoryTaskIndex(summaries, new Date().toISOString());
  const changed: string[] = [];
  if (!(await fileExists(dirs.indexPath))) {
    await fs.writeFile(dirs.indexPath, content, "utf8");
    changed.push(toPosix(path.relative(rootDir, dirs.indexPath)));
  }
  return { changed };
}

async function persistMemoryTask(rootDir: string, task: AgentMemoryTask): Promise<AgentMemoryTaskResult> {
  const normalized = normalizeTask(task);
  await writeJsonFile(normalized.artifactPath, normalized);
  await ensureDir(path.dirname(normalized.markdownPath));
  await fs.writeFile(normalized.markdownPath, renderMemoryTaskMarkdown(normalized), "utf8");
  await refreshMemoryIndex(rootDir);
  return {
    task: normalized,
    artifactPath: normalized.artifactPath,
    markdownPath: normalized.markdownPath
  };
}

async function refreshMemoryIndex(rootDir: string): Promise<void> {
  const dirs = memoryDirs(rootDir);
  await ensureDir(dirs.wikiDir);
  const summaries = await listMemoryTasks(rootDir);
  await fs.writeFile(dirs.indexPath, renderMemoryTaskIndex(summaries, new Date().toISOString()), "utf8");
}

async function hydrateTaskFromContextPack(rootDir: string, task: AgentMemoryTask, contextPackId: string): Promise<AgentMemoryTask> {
  const pack = await readContextPack(rootDir, contextPackId);
  if (!pack) {
    return {
      ...task,
      contextPackIds: uniqueStrings([...task.contextPackIds, contextPackId])
    };
  }
  return {
    ...task,
    contextPackIds: uniqueStrings([...task.contextPackIds, pack.id]),
    sourceIds: uniqueStrings([...task.sourceIds, ...pack.relatedSourceIds]),
    pageIds: uniqueStrings([...task.pageIds, ...pack.relatedPageIds]),
    nodeIds: uniqueStrings([...task.nodeIds, ...pack.relatedNodeIds])
  };
}

export async function startMemoryTask(rootDir: string, options: StartMemoryTaskOptions): Promise<AgentMemoryTaskResult> {
  const goal = normalizeWhitespace(options.goal);
  if (!goal) {
    throw new Error("Task goal is required.");
  }
  const createdAt = new Date().toISOString();
  const paths = await uniqueMemoryTaskPaths(rootDir, createdAt, goal);
  let task: AgentMemoryTask = {
    id: paths.id,
    title: titleForGoal(goal),
    goal,
    status: "active",
    target: options.target,
    agent: options.agent,
    createdAt,
    updatedAt: createdAt,
    contextPackIds: [],
    sessionIds: [],
    sourceIds: [],
    pageIds: [],
    nodeIds: [],
    changedPaths: [],
    gitRefs: [],
    notes: [],
    decisions: [],
    followUps: [],
    artifactPath: paths.artifactPath,
    markdownPath: paths.markdownPath
  };

  if (options.contextPackId) {
    task = await hydrateTaskFromContextPack(rootDir, task, options.contextPackId);
  } else {
    const pack = await buildContextPack(rootDir, {
      goal,
      target: options.target,
      budgetTokens: options.budgetTokens ?? DEFAULT_MEMORY_CONTEXT_BUDGET,
      format: "markdown"
    });
    task = await hydrateTaskFromContextPack(rootDir, task, pack.pack.id);
  }

  return await persistMemoryTask(rootDir, task);
}

async function resolveMemoryTaskArtifactPath(rootDir: string, target: string): Promise<string | null> {
  const dirs = memoryDirs(rootDir);
  const direct = path.resolve(rootDir, target);
  if (isPathWithin(dirs.tasksStateDir, direct) && direct.endsWith(".json") && (await fileExists(direct))) {
    return direct;
  }
  const byId = path.resolve(dirs.tasksStateDir, `${target.replace(/\.json$/, "")}.json`);
  if (isPathWithin(dirs.tasksStateDir, byId) && (await fileExists(byId))) {
    return byId;
  }
  const summaries = await listMemoryTasks(rootDir);
  const match = summaries.find((summary) => summary.id === target || path.basename(summary.artifactPath, ".json") === target);
  return match?.artifactPath ?? null;
}

export async function readMemoryTask(rootDir: string, target: string): Promise<AgentMemoryTask | null> {
  const artifactPath = await resolveMemoryTaskArtifactPath(rootDir, target);
  const raw = artifactPath ? await readJsonFile<unknown>(artifactPath) : null;
  return raw ? normalizeTask(raw) : null;
}

export async function listMemoryTasks(rootDir: string): Promise<AgentMemoryTaskSummary[]> {
  const dirs = memoryDirs(rootDir);
  const entries = await fs.readdir(dirs.tasksStateDir, { withFileTypes: true }).catch(() => []);
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const raw = await readJsonFile<unknown>(path.join(dirs.tasksStateDir, entry.name));
        return raw ? normalizeTask(raw) : null;
      })
  );
  return tasks
    .filter((task): task is AgentMemoryTask => Boolean(task))
    .map(taskSummary)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title));
}

export async function updateMemoryTask(rootDir: string, target: string, options: UpdateMemoryTaskOptions): Promise<AgentMemoryTaskResult> {
  const task = await readMemoryTask(rootDir, target);
  if (!task) {
    throw new Error(`Task not found: ${target}`);
  }
  const updatedAt = new Date().toISOString();
  const nextStatus = options.status ? memoryTaskStatusSchema.parse(options.status) : task.status;
  let next: AgentMemoryTask = {
    ...task,
    status: nextStatus,
    updatedAt,
    sessionIds: uniqueStrings([...task.sessionIds, options.sessionId ?? ""]),
    sourceIds: uniqueStrings([...task.sourceIds, options.sourceId ?? ""]),
    pageIds: uniqueStrings([...task.pageIds, options.pageId ?? ""]),
    nodeIds: uniqueStrings([...task.nodeIds, options.nodeId ?? ""]),
    changedPaths: uniqueStrings([...task.changedPaths, options.changedPath ? normalizePathRef(options.changedPath) : ""]),
    gitRefs: uniqueStrings([...task.gitRefs, options.gitRef ?? ""]),
    notes: options.note
      ? [...task.notes, { id: noteId("note", updatedAt, task.notes.length), text: normalizeWhitespace(options.note), createdAt: updatedAt }]
      : task.notes,
    decisions: options.decision
      ? [
          ...task.decisions,
          { id: noteId("decision", updatedAt, task.decisions.length), text: normalizeWhitespace(options.decision), createdAt: updatedAt }
        ]
      : task.decisions
  };
  if (options.contextPackId) {
    next = await hydrateTaskFromContextPack(rootDir, next, options.contextPackId);
  }
  return await persistMemoryTask(rootDir, next);
}

export async function finishMemoryTask(rootDir: string, target: string, options: FinishMemoryTaskOptions): Promise<AgentMemoryTaskResult> {
  const outcome = normalizeWhitespace(options.outcome);
  if (!outcome) {
    throw new Error("Task outcome is required.");
  }
  const task = await readMemoryTask(rootDir, target);
  if (!task) {
    throw new Error(`Task not found: ${target}`);
  }
  const updatedAt = new Date().toISOString();
  return await persistMemoryTask(rootDir, {
    ...task,
    status: "completed",
    updatedAt,
    outcome,
    followUps: uniqueStrings([...task.followUps, options.followUp ? normalizeWhitespace(options.followUp) : ""])
  });
}

function renderMemoryResumeMarkdown(task: AgentMemoryTask, contextSections: string[]): string {
  return [
    `# Agent Task Resume: ${task.title}`,
    "",
    `Goal: ${task.goal}`,
    `Status: ${task.status}`,
    task.target ? `Target: ${task.target}` : undefined,
    task.agent ? `Agent: ${task.agent}` : undefined,
    "",
    "## Outcome",
    "",
    task.outcome ?? "Not finished yet.",
    "",
    "## Decisions",
    "",
    datedList(task.decisions),
    "",
    "## Follow-Ups",
    "",
    markdownList(task.followUps),
    "",
    "## Changed Paths",
    "",
    markdownList(task.changedPaths),
    "",
    "## Linked Context",
    "",
    contextSections.length ? contextSections.join("\n\n---\n\n") : "- none",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function resumeMemoryTask(
  rootDir: string,
  target: string,
  options: ResumeMemoryTaskOptions = {}
): Promise<ResumeMemoryTaskResult> {
  const task = await readMemoryTask(rootDir, target);
  if (!task) {
    throw new Error(`Task not found: ${target}`);
  }
  const format: AgentMemoryResumeFormat = options.format ?? "markdown";
  if (format === "json") {
    return { task, rendered: JSON.stringify(task, null, 2) };
  }
  const packs = (
    await Promise.all(
      task.contextPackIds.map(async (id) => {
        const pack = await readContextPack(rootDir, id);
        if (!pack) {
          return null;
        }
        return format === "llms" ? renderContextPackLlms(pack) : renderContextPackMarkdown(pack);
      })
    )
  ).filter((value): value is string => Boolean(value));
  return {
    task,
    rendered: renderMemoryResumeMarkdown(task, packs)
  };
}

export function memoryTaskPageRecord(rootDir: string, task: AgentMemoryTask): MemoryTaskStoredPage {
  const content = renderMemoryTaskMarkdown(task);
  const artifactRootDir = resolveArtifactRootDir(rootDir);
  const page: GraphPage = {
    id: `memory:${task.id}`,
    path: toPosix(path.relative(path.join(artifactRootDir, "wiki"), task.markdownPath)),
    title: task.title,
    kind: "memory_task",
    sourceIds: task.sourceIds,
    projectIds: [],
    nodeIds: [`memory:${task.id}`, ...task.decisions.map((decision) => `decision:${task.id}:${decision.id}`), ...task.nodeIds],
    freshness: task.status === "completed" || task.status === "archived" ? "fresh" : "stale",
    status: task.status,
    confidence: 1,
    backlinks: [],
    schemaHash: "",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: task.pageIds,
    relatedNodeIds: task.nodeIds,
    relatedSourceIds: task.sourceIds,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    compiledFrom: task.contextPackIds,
    managedBy: "system"
  };
  return { task, page, content, contentHash: sha256(content) };
}

export async function loadMemoryTaskPages(rootDir: string): Promise<MemoryTaskStoredPage[]> {
  const dirs = memoryDirs(rootDir);
  const entries = await fs.readdir(dirs.tasksStateDir, { withFileTypes: true }).catch(() => []);
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const raw = await readJsonFile<unknown>(path.join(dirs.tasksStateDir, entry.name));
        return raw ? normalizeTask(raw) : null;
      })
  );
  return tasks
    .filter((task): task is AgentMemoryTask => Boolean(task))
    .map((task) => memoryTaskPageRecord(rootDir, task))
    .sort((left, right) => left.page.path.localeCompare(right.page.path));
}

export function buildMemoryGraphElements(
  tasks: AgentMemoryTask[],
  pages: GraphPage[]
): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const pagesByPath = new Map(pages.map((page) => [page.path, page]));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const pushEdge = (edge: GraphEdge) => {
    if (edges.some((existing) => existing.id === edge.id)) {
      return;
    }
    edges.push(edge);
  };

  for (const task of tasks) {
    const taskNodeId = `memory:${task.id}`;
    nodes.push({
      id: taskNodeId,
      type: "memory_task",
      label: task.title,
      pageId: taskNodeId,
      freshness: task.status === "completed" || task.status === "archived" ? "fresh" : "stale",
      confidence: 1,
      sourceIds: task.sourceIds,
      projectIds: [],
      tags: ["agent-task", "agent-memory", `status/${task.status}`]
    });

    for (const [index, decision] of task.decisions.entries()) {
      const decisionNodeId = `decision:${task.id}:${decision.id}`;
      nodes.push({
        id: decisionNodeId,
        type: "decision",
        label: truncate(decision.text, 80),
        pageId: taskNodeId,
        freshness: "fresh",
        confidence: 1,
        sourceIds: task.sourceIds,
        projectIds: [],
        tags: ["agent-task", "agent-memory", "decision"]
      });
      pushEdge({
        id: `${taskNodeId}->${decisionNodeId}:records_decision:${index + 1}`,
        source: taskNodeId,
        target: decisionNodeId,
        relation: "records_decision",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 1,
        provenance: [task.id]
      });
    }

    for (const [index, nodeId] of task.nodeIds.entries()) {
      if (nodeId === taskNodeId) {
        continue;
      }
      pushEdge({
        id: `${taskNodeId}->${nodeId}:uses_context:${index + 1}`,
        source: taskNodeId,
        target: nodeId,
        relation: "uses_context",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 0.9,
        provenance: [task.id]
      });
    }

    const touchedNodeIds = uniqueStrings(
      task.changedPaths.flatMap((changedPath) => {
        const page = pagesByPath.get(changedPath) ?? [...pagesByPath.values()].find((candidate) => candidate.path.endsWith(changedPath));
        return page?.nodeIds ?? [];
      })
    );
    for (const [index, nodeId] of touchedNodeIds.entries()) {
      pushEdge({
        id: `${taskNodeId}->${nodeId}:touched:${index + 1}`,
        source: taskNodeId,
        target: nodeId,
        relation: "touched",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 0.85,
        provenance: [task.id]
      });
    }

    if (task.outcome) {
      for (const [index, nodeId] of task.nodeIds.slice(0, 12).entries()) {
        pushEdge({
          id: `${taskNodeId}->${nodeId}:produced_output:${index + 1}`,
          source: taskNodeId,
          target: nodeId,
          relation: "produced_output",
          status: "inferred",
          evidenceClass: "inferred",
          confidence: 0.68,
          provenance: [task.id]
        });
      }
    }

    for (const [index, followUp] of task.followUps.entries()) {
      const followUpNodeId = `decision:${task.id}:follow-up-${index + 1}`;
      nodes.push({
        id: followUpNodeId,
        type: "decision",
        label: truncate(`Follow-up: ${followUp}`, 80),
        pageId: taskNodeId,
        freshness: "stale",
        confidence: 0.82,
        sourceIds: task.sourceIds,
        projectIds: [],
        tags: ["agent-task", "agent-memory", "follow-up"]
      });
      pushEdge({
        id: `${taskNodeId}->${followUpNodeId}:follows_up:${index + 1}`,
        source: taskNodeId,
        target: followUpNodeId,
        relation: "follows_up",
        status: "inferred",
        evidenceClass: "inferred",
        confidence: 0.82,
        provenance: [task.id]
      });
    }
  }

  return { nodes, edges };
}

export function memoryTaskHashes(records: MemoryTaskStoredPage[]): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.page.id, record.contentHash]));
}

export function estimateMemoryTaskTokens(task: AgentMemoryTask): number {
  return estimateTokens(renderMemoryTaskMarkdown(task));
}
