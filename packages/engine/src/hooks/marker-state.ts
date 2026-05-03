// NOTE: This file is bundled by tsup as a standalone hook script
// (`dist/hooks/marker-state.js`) and installed into user projects. It must
// only import Node builtins — no engine imports. The helpers below share
// the "has the session seen the graph report" tracking across the per-agent
// hook scripts so each agent can manage its own per-cwd state directory.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface MarkerState {
  dir: string;
  markerPath: string;
}

export function markerState(cwd: string, agentKey: string): MarkerState {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex");
  const dir = path.join(os.tmpdir(), "swarmvault-agent-hooks", agentKey, hash);
  return {
    dir,
    markerPath: path.join(dir, "report-read")
  };
}

export function isReportPath(value: unknown, cwd: string): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const reportSuffix = path.join("wiki", "graph", "report.md");
  const normalized = value.replaceAll("\\", "/");
  const reportNormalized = reportSuffix.replaceAll("\\", "/");
  if (normalized.endsWith(reportNormalized)) {
    return true;
  }
  return path.resolve(cwd, value) === path.resolve(cwd, reportSuffix);
}

export function collectCandidatePaths(node: unknown, acc: string[] = []): string[] {
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
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (["path", "filePath", "file_path", "paths", "target", "targets"].includes(key)) {
      collectCandidatePaths(value, acc);
      continue;
    }
    collectCandidatePaths(value, acc);
  }
  return acc;
}

interface HookInputCwdShape {
  cwd?: unknown;
  directory?: unknown;
  workspace?: { cwd?: unknown };
  toolInput?: { cwd?: unknown };
}

export function resolveInputCwd(input: unknown): string {
  const shaped = (input ?? {}) as HookInputCwdShape;
  const candidate =
    (typeof shaped.cwd === "string" && shaped.cwd) ||
    (typeof shaped.directory === "string" && shaped.directory) ||
    (typeof shaped.workspace?.cwd === "string" && shaped.workspace.cwd) ||
    (typeof shaped.toolInput?.cwd === "string" && shaped.toolInput.cwd) ||
    process.cwd();
  return path.resolve(candidate);
}

interface HookInputToolNameShape {
  toolName?: unknown;
  tool_name?: unknown;
  tool?: { name?: unknown };
  name?: unknown;
}

export function resolveToolName(input: unknown): string {
  const shaped = (input ?? {}) as HookInputToolNameShape;
  return String(shaped.toolName ?? shaped.tool_name ?? shaped.tool?.name ?? shaped.name ?? "");
}

export async function hasReport(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, "wiki", "graph", "report.md"));
    return true;
  } catch {
    return false;
  }
}

export async function markReportRead(cwd: string, agentKey: string): Promise<void> {
  const state = markerState(cwd, agentKey);
  await fs.mkdir(state.dir, { recursive: true });
  await fs.writeFile(state.markerPath, "seen\n", "utf8");
}

export async function hasSeenReport(cwd: string, agentKey: string): Promise<boolean> {
  const state = markerState(cwd, agentKey);
  try {
    await fs.access(state.markerPath);
    return true;
  } catch {
    return false;
  }
}

export async function resetSession(cwd: string, agentKey: string): Promise<void> {
  const state = markerState(cwd, agentKey);
  await fs.rm(state.dir, { recursive: true, force: true });
}

export function isBroadSearchTool(toolName: string): boolean {
  return /grep|glob|search|find/i.test(toolName);
}

function collectCommandCandidates(node: unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== "object") {
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectCommandCandidates(item, acc);
    }
    return acc;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (["command", "cmd", "script", "bash", "shell"].includes(key) && typeof value === "string") {
      acc.push(value);
      continue;
    }
    collectCommandCandidates(value, acc);
  }
  return acc;
}

function commandLooksLikeBroadSearch(command: string): boolean {
  const tokens = command
    .replace(/[;&|()]/g, " ")
    .split(/\s+/)
    .map((token) => path.basename(token.replace(/^['"]|['"]$/g, "")))
    .filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["rg", "grep", "find", "fd", "ag", "ack"].includes(token)) {
      return true;
    }
    if (token === "git" && tokens[index + 1] === "grep") {
      return true;
    }
  }
  return false;
}

export function isBroadSearchInput(input: unknown): boolean {
  const toolName = resolveToolName(input);
  if (isBroadSearchTool(toolName)) {
    return true;
  }
  return collectCommandCandidates(input).some(commandLooksLikeBroadSearch);
}

export async function readHookInput(): Promise<unknown> {
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

export const REPORT_NOTE = "SwarmVault graph report exists at wiki/graph/report.md. Read it before broad grep/glob searching.";
