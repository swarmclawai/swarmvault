import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

export function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export async function writeFileIfChanged(filePath: string, content: string): Promise<boolean> {
  await ensureDir(path.dirname(filePath));
  if (await fileExists(filePath)) {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  }
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

export function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function firstSentences(value: string, count = 3): string {
  const sentences = value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  return sentences.slice(0, count).join(" ").trim();
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) {
      continue;
    }
    seen.add(itemKey);
    result.push(item);
  }

  return result;
}

export function extractJson(text: string): string {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const start = text.indexOf("{");
  if (start !== -1) {
    let end = text.lastIndexOf("}");
    while (end > start) {
      const candidate = text.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        end = text.lastIndexOf("}", end - 1);
      }
    }
  }

  throw new Error("Could not locate JSON object in provider response.");
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength < 4) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}
