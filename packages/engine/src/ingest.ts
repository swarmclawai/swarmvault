import fs from "node:fs/promises";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import mime from "mime-types";
import TurndownService from "turndown";
import { inferCodeLanguage } from "./code-analysis.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { appendLogEntry } from "./logs.js";
import type { InboxImportResult, ResolvedPaths, SourceAttachment, SourceManifest } from "./types.js";
import { ensureDir, fileExists, listFilesRecursive, readJsonFile, sha256, slugify, toPosix, writeJsonFile } from "./utils.js";

type PreparedAttachment = {
  relativePath: string;
  mimeType: string;
  originalPath?: string;
  bytes: Buffer;
};

type PreparedInput = {
  title: string;
  originType: SourceManifest["originType"];
  sourceKind: SourceManifest["sourceKind"];
  language?: SourceManifest["language"];
  originalPath?: string;
  url?: string;
  mimeType: string;
  storedExtension: string;
  payloadBytes: Buffer;
  extractedText?: string;
  attachments?: PreparedAttachment[];
  contentHash?: string;
};

type IngestPersistResult = {
  manifest: SourceManifest;
  isNew: boolean;
};

type InboxAttachmentRef = {
  absolutePath: string;
  relativeRef: string;
};

function inferKind(mimeType: string, filePath: string): SourceManifest["sourceKind"] {
  if (inferCodeLanguage(filePath, mimeType)) {
    return "code";
  }
  if (mimeType.includes("markdown")) {
    return "markdown";
  }
  if (mimeType.startsWith("text/")) {
    return "text";
  }
  if (mimeType === "application/pdf" || filePath.toLowerCase().endsWith(".pdf")) {
    return "pdf";
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.includes("html")) {
    return "html";
  }
  return "binary";
}

function titleFromText(fallback: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback;
}

function guessMimeType(target: string): string {
  return mime.lookup(target) || "application/octet-stream";
}

function buildCompositeHash(payloadBytes: Buffer, attachments: PreparedAttachment[] = []): string {
  if (!attachments.length) {
    return sha256(payloadBytes);
  }

  const attachmentSignature = attachments
    .map((attachment) => `${attachment.relativePath}:${sha256(attachment.bytes)}`)
    .sort()
    .join("|");

  return sha256(`${sha256(payloadBytes)}|${attachmentSignature}`);
}

function sanitizeAssetRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  const segments = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment === ".") {
        return "";
      }
      if (segment === "..") {
        return "_up";
      }
      return segment;
    })
    .filter(Boolean);

  return segments.join("/") || "asset";
}

function normalizeLocalReference(value: string): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  const [withoutTitle] = trimmed.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/, 1);
  const candidate = withoutTitle.split("#")[0]?.split("?")[0]?.trim();
  if (!candidate) {
    return null;
  }

  const lowered = candidate.toLowerCase();
  if (
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("data:") ||
    lowered.startsWith("mailto:") ||
    lowered.startsWith("#") ||
    path.isAbsolute(candidate)
  ) {
    return null;
  }

  return candidate.replace(/\\/g, "/");
}

function extractMarkdownReferences(content: string): string[] {
  const references: string[] = [];
  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;

  for (const match of content.matchAll(linkPattern)) {
    const normalized = normalizeLocalReference(match[1] ?? "");
    if (normalized) {
      references.push(normalized);
    }
  }

  return references;
}

async function convertHtmlToMarkdown(html: string, url: string): Promise<{ markdown: string; title: string }> {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const body = article?.content ?? dom.window.document.body.innerHTML;
  const markdown = turndown.turndown(body);
  return {
    markdown,
    title: article?.title?.trim() || new URL(url).hostname
  };
}

async function readManifestByHash(manifestsDir: string, contentHash: string): Promise<SourceManifest | null> {
  const entries = await fs.readdir(manifestsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const manifest = await readJsonFile<SourceManifest>(path.join(manifestsDir, entry.name));
    if (manifest?.contentHash === contentHash) {
      return manifest;
    }
  }
  return null;
}

async function persistPreparedInput(rootDir: string, prepared: PreparedInput, paths: ResolvedPaths): Promise<IngestPersistResult> {
  await ensureDir(paths.rawSourcesDir);
  await ensureDir(paths.rawAssetsDir);
  await ensureDir(paths.manifestsDir);
  await ensureDir(paths.extractsDir);

  const attachments = prepared.attachments ?? [];
  const contentHash = prepared.contentHash ?? buildCompositeHash(prepared.payloadBytes, attachments);
  const existing = await readManifestByHash(paths.manifestsDir, contentHash);
  if (existing) {
    return { manifest: existing, isNew: false };
  }

  const now = new Date().toISOString();
  const sourceId = `${slugify(prepared.title)}-${contentHash.slice(0, 8)}`;
  const storedPath = path.join(paths.rawSourcesDir, `${sourceId}${prepared.storedExtension}`);
  await fs.writeFile(storedPath, prepared.payloadBytes);

  let extractedTextPath: string | undefined;
  if (prepared.extractedText) {
    extractedTextPath = path.join(paths.extractsDir, `${sourceId}.md`);
    await fs.writeFile(extractedTextPath, prepared.extractedText, "utf8");
  }

  const manifestAttachments: SourceAttachment[] = [];
  for (const attachment of attachments) {
    const absoluteAttachmentPath = path.join(paths.rawAssetsDir, sourceId, attachment.relativePath);
    await ensureDir(path.dirname(absoluteAttachmentPath));
    await fs.writeFile(absoluteAttachmentPath, attachment.bytes);
    manifestAttachments.push({
      path: toPosix(path.relative(rootDir, absoluteAttachmentPath)),
      mimeType: attachment.mimeType,
      originalPath: attachment.originalPath
    });
  }

  const manifest: SourceManifest = {
    sourceId,
    title: prepared.title,
    originType: prepared.originType,
    sourceKind: prepared.sourceKind,
    language: prepared.language,
    originalPath: prepared.originalPath,
    url: prepared.url,
    storedPath: toPosix(path.relative(rootDir, storedPath)),
    extractedTextPath: extractedTextPath ? toPosix(path.relative(rootDir, extractedTextPath)) : undefined,
    mimeType: prepared.mimeType,
    contentHash,
    createdAt: now,
    updatedAt: now,
    attachments: manifestAttachments.length ? manifestAttachments : undefined
  };

  await writeJsonFile(path.join(paths.manifestsDir, `${sourceId}.json`), manifest);
  await appendLogEntry(rootDir, "ingest", prepared.title, [
    `source_id=${sourceId}`,
    `kind=${prepared.sourceKind}`,
    `attachments=${manifestAttachments.length}`
  ]);

  return { manifest, isNew: true };
}

async function prepareFileInput(_rootDir: string, absoluteInput: string): Promise<PreparedInput> {
  const payloadBytes = await fs.readFile(absoluteInput);
  const mimeType = guessMimeType(absoluteInput);
  const sourceKind = inferKind(mimeType, absoluteInput);
  const language = inferCodeLanguage(absoluteInput, mimeType);
  const storedExtension = path.extname(absoluteInput) || `.${mime.extension(mimeType) || "bin"}`;

  let title: string;
  let extractedText: string | undefined;
  if (sourceKind === "markdown" || sourceKind === "text" || sourceKind === "code") {
    extractedText = payloadBytes.toString("utf8");
    title = titleFromText(path.basename(absoluteInput, path.extname(absoluteInput)), extractedText);
  } else {
    title = path.basename(absoluteInput, path.extname(absoluteInput));
  }

  return {
    title,
    originType: "file",
    sourceKind,
    language,
    originalPath: toPosix(absoluteInput),
    mimeType,
    storedExtension,
    payloadBytes,
    extractedText
  };
}

async function prepareUrlInput(input: string): Promise<PreparedInput> {
  const response = await fetch(input);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${input}: ${response.status} ${response.statusText}`);
  }

  let payloadBytes = Buffer.from(await response.arrayBuffer());
  let mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || guessMimeType(input);
  let sourceKind = inferKind(mimeType, input);
  const language = inferCodeLanguage(input, mimeType);
  let storedExtension = ".bin";
  let title = new URL(input).hostname + new URL(input).pathname;
  let extractedText: string | undefined;

  if (sourceKind === "html" || mimeType.startsWith("text/html")) {
    const html = payloadBytes.toString("utf8");
    const converted = await convertHtmlToMarkdown(html, input);
    title = converted.title;
    extractedText = converted.markdown;
    payloadBytes = Buffer.from(converted.markdown, "utf8");
    mimeType = "text/markdown";
    sourceKind = "markdown";
    storedExtension = ".md";
  } else {
    const extension = path.extname(new URL(input).pathname);
    storedExtension = extension || `.${mime.extension(mimeType) || "bin"}`;
    if (sourceKind === "markdown" || sourceKind === "text" || sourceKind === "code") {
      extractedText = payloadBytes.toString("utf8");
      title = titleFromText(title || new URL(input).hostname, extractedText);
    }
  }

  return {
    title,
    originType: "url",
    sourceKind,
    language,
    url: input,
    mimeType,
    storedExtension,
    payloadBytes,
    extractedText
  };
}

async function collectInboxAttachmentRefs(inputDir: string, files: string[]): Promise<Map<string, InboxAttachmentRef[]>> {
  const refsBySource = new Map<string, InboxAttachmentRef[]>();

  for (const absolutePath of files) {
    const mimeType = guessMimeType(absolutePath);
    const sourceKind = inferKind(mimeType, absolutePath);
    if (sourceKind !== "markdown") {
      continue;
    }

    const content = await fs.readFile(absolutePath, "utf8");
    const refs = extractMarkdownReferences(content);
    if (!refs.length) {
      continue;
    }

    const sourceRefs: InboxAttachmentRef[] = [];
    for (const ref of refs) {
      const resolved = path.resolve(path.dirname(absolutePath), ref);
      if (!resolved.startsWith(inputDir) || !(await fileExists(resolved))) {
        continue;
      }

      sourceRefs.push({
        absolutePath: resolved,
        relativeRef: ref
      });
    }

    if (sourceRefs.length) {
      refsBySource.set(
        absolutePath,
        sourceRefs.filter(
          (ref, index, items) =>
            index ===
            items.findIndex((candidate) => candidate.absolutePath === ref.absolutePath && candidate.relativeRef === ref.relativeRef)
        )
      );
    }
  }

  return refsBySource;
}

function rewriteMarkdownReferences(content: string, replacements: Map<string, string>): string {
  return content.replace(/(!?\[[^\]]*]\()([^)]+)(\))/g, (fullMatch, prefix, target, suffix) => {
    const normalized = normalizeLocalReference(target);
    if (!normalized) {
      return fullMatch;
    }

    const replacement = replacements.get(normalized);
    if (!replacement) {
      return fullMatch;
    }

    return `${prefix}${replacement}${suffix}`;
  });
}

async function prepareInboxMarkdownInput(absolutePath: string, attachmentRefs: InboxAttachmentRef[]): Promise<PreparedInput> {
  const originalBytes = await fs.readFile(absolutePath);
  const originalText = originalBytes.toString("utf8");
  const title = titleFromText(path.basename(absolutePath, path.extname(absolutePath)), originalText);

  const attachments: PreparedAttachment[] = [];
  for (const attachmentRef of attachmentRefs) {
    const bytes = await fs.readFile(attachmentRef.absolutePath);
    attachments.push({
      relativePath: sanitizeAssetRelativePath(attachmentRef.relativeRef),
      mimeType: guessMimeType(attachmentRef.absolutePath),
      originalPath: toPosix(attachmentRef.absolutePath),
      bytes
    });
  }

  const contentHash = buildCompositeHash(originalBytes, attachments);
  const sourceId = `${slugify(title)}-${contentHash.slice(0, 8)}`;
  const replacements = new Map(
    attachmentRefs.map((attachmentRef) => [
      attachmentRef.relativeRef.replace(/\\/g, "/"),
      `../assets/${sourceId}/${sanitizeAssetRelativePath(attachmentRef.relativeRef)}`
    ])
  );
  const rewrittenText = rewriteMarkdownReferences(originalText, replacements);

  return {
    title,
    originType: "file",
    sourceKind: "markdown",
    originalPath: toPosix(absolutePath),
    mimeType: "text/markdown",
    storedExtension: path.extname(absolutePath) || ".md",
    payloadBytes: Buffer.from(rewrittenText, "utf8"),
    extractedText: rewrittenText,
    attachments,
    contentHash
  };
}

function isSupportedInboxKind(sourceKind: SourceManifest["sourceKind"]): boolean {
  return ["markdown", "text", "html", "pdf", "image"].includes(sourceKind);
}

export async function ingestInput(rootDir: string, input: string): Promise<SourceManifest> {
  const { paths } = await initWorkspace(rootDir);
  const prepared = /^https?:\/\//i.test(input)
    ? await prepareUrlInput(input)
    : await prepareFileInput(rootDir, path.resolve(rootDir, input));

  const result = await persistPreparedInput(rootDir, prepared, paths);
  return result.manifest;
}

export async function importInbox(rootDir: string, inputDir?: string): Promise<InboxImportResult> {
  const { paths } = await initWorkspace(rootDir);
  const effectiveInputDir = path.resolve(rootDir, inputDir ?? paths.inboxDir);
  if (!(await fileExists(effectiveInputDir))) {
    throw new Error(`Inbox directory not found: ${effectiveInputDir}`);
  }

  const files = (await listFilesRecursive(effectiveInputDir)).sort();
  const refsBySource = await collectInboxAttachmentRefs(effectiveInputDir, files);
  const claimedAttachments = new Set([...refsBySource.values()].flatMap((refs) => refs.map((ref) => ref.absolutePath)));

  const imported: SourceManifest[] = [];
  const skipped: InboxImportResult["skipped"] = [];
  let attachmentCount = 0;

  for (const absolutePath of files) {
    const basename = path.basename(absolutePath);
    if (basename.startsWith(".")) {
      skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "hidden_file" });
      continue;
    }

    if (claimedAttachments.has(absolutePath)) {
      skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "referenced_attachment" });
      continue;
    }

    const mimeType = guessMimeType(absolutePath);
    const sourceKind = inferKind(mimeType, absolutePath);
    if (!isSupportedInboxKind(sourceKind)) {
      skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: `unsupported_kind:${sourceKind}` });
      continue;
    }

    const prepared =
      sourceKind === "markdown" && refsBySource.has(absolutePath)
        ? await prepareInboxMarkdownInput(absolutePath, refsBySource.get(absolutePath) ?? [])
        : await prepareFileInput(rootDir, absolutePath);

    const result = await persistPreparedInput(rootDir, prepared, paths);
    if (!result.isNew) {
      skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "duplicate_content" });
      continue;
    }

    attachmentCount += result.manifest.attachments?.length ?? 0;
    imported.push(result.manifest);
  }

  await appendLogEntry(rootDir, "inbox_import", toPosix(path.relative(rootDir, effectiveInputDir)) || ".", [
    `scanned=${files.length}`,
    `imported=${imported.length}`,
    `attachments=${attachmentCount}`,
    `skipped=${skipped.length}`
  ]);

  return {
    inputDir: effectiveInputDir,
    scannedCount: files.length,
    attachmentCount,
    imported,
    skipped
  };
}

export async function listManifests(rootDir: string): Promise<SourceManifest[]> {
  const { paths } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.manifestsDir))) {
    return [];
  }

  const entries = await fs.readdir(paths.manifestsDir);
  const manifests = await Promise.all(
    entries.filter((entry) => entry.endsWith(".json")).map((entry) => readJsonFile<SourceManifest>(path.join(paths.manifestsDir, entry)))
  );

  return manifests.filter((manifest): manifest is SourceManifest => Boolean(manifest));
}

export async function readExtractedText(rootDir: string, manifest: SourceManifest): Promise<string | undefined> {
  if (!manifest.extractedTextPath) {
    return undefined;
  }

  const absolutePath = path.resolve(rootDir, manifest.extractedTextPath);
  if (!(await fileExists(absolutePath))) {
    return undefined;
  }

  return fs.readFile(absolutePath, "utf8");
}
