import fs from "node:fs/promises";
import path from "node:path";
import { loadVaultConfig } from "./config.js";
import type { GuidedSourceSessionRecord, GuidedSourceSessionStatus } from "./types.js";
import { ensureDir, readJsonFile } from "./utils.js";

function sessionStatePathFor(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"], sessionId: string): string {
  return path.join(paths.sourceSessionsDir, `${sessionId}.json`);
}

export async function listGuidedSourceSessions(rootDir: string): Promise<GuidedSourceSessionRecord[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const entries = await fs.readdir(paths.sourceSessionsDir, { withFileTypes: true }).catch(() => []);
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<GuidedSourceSessionRecord>(path.join(paths.sourceSessionsDir, entry.name)))
  );
  return sessions
    .filter((session): session is GuidedSourceSessionRecord => Boolean(session))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readGuidedSourceSession(rootDir: string, sessionId: string): Promise<GuidedSourceSessionRecord | null> {
  const { paths } = await loadVaultConfig(rootDir);
  return await readJsonFile<GuidedSourceSessionRecord>(sessionStatePathFor(paths, sessionId));
}

export async function findLatestGuidedSourceSessionByScope(rootDir: string, scopeId: string): Promise<GuidedSourceSessionRecord | null> {
  const sessions = await listGuidedSourceSessions(rootDir);
  return sessions.find((session) => session.scopeId === scopeId) ?? null;
}

export async function writeGuidedSourceSession(rootDir: string, session: GuidedSourceSessionRecord): Promise<string> {
  const { paths } = await loadVaultConfig(rootDir);
  await ensureDir(paths.sourceSessionsDir);
  const next = {
    ...session,
    updatedAt: session.updatedAt || new Date().toISOString()
  };
  const filePath = sessionStatePathFor(paths, session.sessionId);
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return filePath;
}

export async function updateGuidedSourceSessionStatus(
  rootDir: string,
  sessionId: string,
  status: GuidedSourceSessionStatus
): Promise<GuidedSourceSessionRecord | null> {
  const existing = await readGuidedSourceSession(rootDir, sessionId);
  if (!existing) {
    return null;
  }
  const next: GuidedSourceSessionRecord = {
    ...existing,
    status,
    updatedAt: new Date().toISOString()
  };
  await writeGuidedSourceSession(rootDir, next);
  return next;
}

export async function guidedSourceSessionStatePath(rootDir: string, sessionId: string): Promise<string> {
  const { paths } = await loadVaultConfig(rootDir);
  return sessionStatePathFor(paths, sessionId);
}
