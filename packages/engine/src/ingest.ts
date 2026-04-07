import fs from "node:fs/promises";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import mime from "mime-types";
import TurndownService from "turndown";
import { inferCodeLanguage } from "./code-analysis.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { appendLogEntry } from "./logs.js";
import type { InboxImportResult, IngestOptions, ResolvedPaths, SourceAttachment, SourceManifest } from "./types.js";
import { ensureDir, fileExists, listFilesRecursive, readJsonFile, sha256, slugify, toPosix, writeJsonFile } from "./utils.js";

const DEFAULT_MAX_ASSET_SIZE = 10 * 1024 * 1024;

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
  logDetails?: string[];
};

type IngestPersistResult = {
  manifest: SourceManifest;
  isNew: boolean;
};

type InboxAttachmentRef = {
  absolutePath: string;
  relativeRef: string;
};

type NormalizedIngestOptions = {
  includeAssets: boolean;
  maxAssetSize: number;
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

function normalizeIngestOptions(options?: IngestOptions): NormalizedIngestOptions {
  return {
    includeAssets: options?.includeAssets ?? true,
    maxAssetSize: Math.max(0, Math.floor(options?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE))
  };
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

function normalizeRemoteReference(value: string, baseUrl: string): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, "");
  const [withoutTitle] = trimmed.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/, 1);
  const candidate = withoutTitle.split("#")[0]?.trim();
  if (!candidate) {
    return null;
  }

  const lowered = candidate.toLowerCase();
  if (lowered.startsWith("data:") || lowered.startsWith("mailto:") || lowered.startsWith("#")) {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(candidate, baseUrl);
  } catch {
    return null;
  }

  if (!/^https?:$/i.test(resolved.protocol)) {
    return null;
  }

  resolved.hash = "";
  return resolved.toString();
}

function extractMarkdownImageReferences(content: string, baseUrl: string): string[] {
  const references: string[] = [];
  const imagePattern = /!\[[^\]]*]\(([^)]+)\)/g;

  for (const match of content.matchAll(imagePattern)) {
    const normalized = normalizeRemoteReference(match[1] ?? "", baseUrl);
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

function resolveUrlMimeType(input: string, response: Response): string {
  const headerMimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
  const guessedMimeType = guessMimeType(new URL(input).pathname);
  if (!headerMimeType) {
    return guessedMimeType;
  }

  if (
    (headerMimeType === "text/plain" || headerMimeType === "application/octet-stream") &&
    guessedMimeType !== "application/octet-stream"
  ) {
    return guessedMimeType;
  }

  return headerMimeType;
}

function buildRemoteAssetRelativePath(assetUrl: string, mimeType: string): string {
  const url = new URL(assetUrl);
  const normalized = sanitizeAssetRelativePath(`${url.hostname}${url.pathname || "/asset"}`);
  const extension = path.posix.extname(normalized);
  const directory = path.posix.dirname(normalized);
  const basename = extension ? path.posix.basename(normalized, extension) : path.posix.basename(normalized);
  const resolvedExtension = extension || `.${mime.extension(mimeType) || "bin"}`;
  const hashedName = `${basename || "asset"}-${sha256(assetUrl).slice(0, 8)}${resolvedExtension}`;
  return directory === "." ? hashedName : path.posix.join(directory, hashedName);
}

async function readResponseBytesWithinLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`asset exceeds max size (${contentLength} > ${maxBytes})`);
  }

  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new Error(`asset exceeds max size (${bytes.length} > ${maxBytes})`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("asset exceeds configured size limit");
      throw new Error(`asset exceeds max size (${total} > ${maxBytes})`);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks);
}

async function fetchRemoteImageAttachment(assetUrl: string, maxAssetSize: number): Promise<PreparedAttachment> {
  const response = await fetch(assetUrl);
  if (!response.ok) {
    throw new Error(`failed with ${response.status} ${response.statusText}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || guessMimeType(new URL(assetUrl).pathname);
  if (!mimeType.startsWith("image/")) {
    throw new Error(`unsupported mime type ${mimeType}`);
  }

  const bytes = await readResponseBytesWithinLimit(response, maxAssetSize);
  return {
    relativePath: buildRemoteAssetRelativePath(assetUrl, mimeType),
    mimeType,
    originalPath: assetUrl,
    bytes
  };
}

async function collectRemoteImageAttachments(
  assetUrls: string[],
  options: NormalizedIngestOptions
): Promise<{ attachments: PreparedAttachment[]; skippedCount: number }> {
  if (!options.includeAssets || options.maxAssetSize === 0 || !assetUrls.length) {
    return { attachments: [], skippedCount: 0 };
  }

  const attachments: PreparedAttachment[] = [];
  let skippedCount = 0;

  for (const assetUrl of [...new Set(assetUrls)]) {
    try {
      attachments.push(await fetchRemoteImageAttachment(assetUrl, options.maxAssetSize));
    } catch {
      skippedCount += 1;
    }
  }

  return { attachments, skippedCount };
}

function extractHtmlImageReferences(html: string, baseUrl: string): string[] {
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;
  const references: string[] = [];

  for (const image of [...document.querySelectorAll("img[src]")]) {
    const src = image.getAttribute("src");
    if (!src) {
      continue;
    }
    const normalized = normalizeRemoteReference(src, baseUrl);
    if (normalized) {
      references.push(normalized);
    }
  }

  return references;
}

function rewriteHtmlImageReferences(html: string, baseUrl: string, replacements: Map<string, string>): string {
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;

  for (const image of [...document.querySelectorAll("img[src]")]) {
    const src = image.getAttribute("src");
    if (!src) {
      continue;
    }
    const normalized = normalizeRemoteReference(src, baseUrl);
    const replacement = normalized ? replacements.get(normalized) : undefined;
    if (replacement) {
      image.setAttribute("src", replacement);
    }
  }

  return dom.serialize();
}

function rewriteMarkdownImageReferences(content: string, baseUrl: string, replacements: Map<string, string>): string {
  return content.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (fullMatch, prefix, target, suffix) => {
    const normalized = normalizeRemoteReference(target, baseUrl);
    const replacement = normalized ? replacements.get(normalized) : undefined;
    if (!replacement) {
      return fullMatch;
    }
    return `${prefix}${replacement}${suffix}`;
  });
}

function rewriteMarkdownImageTargets(content: string, replacements: Map<string, string>): string {
  return content.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (fullMatch, prefix, target, suffix) => {
    const trimmed = target.trim().replace(/^<|>$/g, "");
    const [withoutTitle] = trimmed.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/, 1);
    const candidate = withoutTitle.trim();
    const replacement = replacements.get(candidate);
    if (!replacement) {
      return fullMatch;
    }
    return `${prefix}${replacement}${suffix}`;
  });
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
    `attachments=${manifestAttachments.length}`,
    ...(prepared.logDetails ?? [])
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

async function prepareUrlInput(input: string, options: NormalizedIngestOptions): Promise<PreparedInput> {
  const response = await fetch(input);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${input}: ${response.status} ${response.statusText}`);
  }

  const inputUrl = new URL(input);
  const originalPayloadBytes = Buffer.from(await response.arrayBuffer());
  let payloadBytes = originalPayloadBytes;
  let mimeType = resolveUrlMimeType(input, response);
  let sourceKind = inferKind(mimeType, inputUrl.pathname);
  const language = inferCodeLanguage(inputUrl.pathname, mimeType);
  let storedExtension = ".bin";
  let title = inputUrl.hostname + inputUrl.pathname;
  let extractedText: string | undefined;
  let attachments: PreparedAttachment[] | undefined;
  let contentHash: string | undefined;
  const logDetails: string[] = [];

  if (sourceKind === "html" || mimeType.startsWith("text/html")) {
    const html = originalPayloadBytes.toString("utf8");
    const initialConversion = await convertHtmlToMarkdown(html, input);
    title = initialConversion.title;

    let localizedHtml = html;
    let localAssetReplacements: Map<string, string> | undefined;
    if (options.includeAssets) {
      const { attachments: remoteAttachments, skippedCount } = await collectRemoteImageAttachments(
        extractHtmlImageReferences(html, input),
        options
      );
      if (remoteAttachments.length) {
        attachments = remoteAttachments;
        contentHash = buildCompositeHash(originalPayloadBytes, remoteAttachments);
        const sourceId = `${slugify(title)}-${contentHash.slice(0, 8)}`;
        localAssetReplacements = new Map(
          remoteAttachments.map((attachment) => [attachment.originalPath ?? "", `../assets/${sourceId}/${attachment.relativePath}`])
        );
        localizedHtml = rewriteHtmlImageReferences(html, input, localAssetReplacements);
        logDetails.push(`remote_assets=${remoteAttachments.length}`);
      }
      if (skippedCount) {
        logDetails.push(`remote_asset_skips=${skippedCount}`);
      }
    }

    const converted =
      localizedHtml === html && !attachments?.length ? initialConversion : await convertHtmlToMarkdown(localizedHtml, input);
    extractedText = converted.markdown;
    if (localAssetReplacements?.size) {
      const absoluteLocalAssetReplacements = new Map(
        [...localAssetReplacements.values()].map((replacement) => [new URL(replacement, input).toString(), replacement])
      );
      extractedText = rewriteMarkdownImageTargets(extractedText, absoluteLocalAssetReplacements);
    }
    payloadBytes = Buffer.from(extractedText, "utf8");
    mimeType = "text/markdown";
    sourceKind = "markdown";
    storedExtension = ".md";
  } else {
    const extension = path.extname(inputUrl.pathname);
    storedExtension = extension || `.${mime.extension(mimeType) || "bin"}`;
    if (sourceKind === "markdown" || sourceKind === "text" || sourceKind === "code") {
      extractedText = payloadBytes.toString("utf8");
      title = titleFromText(title || inputUrl.hostname, extractedText);

      if (sourceKind === "markdown" && options.includeAssets) {
        const { attachments: remoteAttachments, skippedCount } = await collectRemoteImageAttachments(
          extractMarkdownImageReferences(extractedText, input),
          options
        );
        if (remoteAttachments.length) {
          attachments = remoteAttachments;
          contentHash = buildCompositeHash(originalPayloadBytes, remoteAttachments);
          const sourceId = `${slugify(title)}-${contentHash.slice(0, 8)}`;
          const replacements = new Map(
            remoteAttachments.map((attachment) => [attachment.originalPath ?? "", `../assets/${sourceId}/${attachment.relativePath}`])
          );
          extractedText = rewriteMarkdownImageReferences(extractedText, input, replacements);
          payloadBytes = Buffer.from(extractedText, "utf8");
          logDetails.push(`remote_assets=${remoteAttachments.length}`);
        }
        if (skippedCount) {
          logDetails.push(`remote_asset_skips=${skippedCount}`);
        }
      }
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
    extractedText,
    attachments,
    contentHash,
    logDetails
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

export async function ingestInput(rootDir: string, input: string, options?: IngestOptions): Promise<SourceManifest> {
  const { paths } = await initWorkspace(rootDir);
  const normalizedOptions = normalizeIngestOptions(options);
  const prepared = /^https?:\/\//i.test(input)
    ? await prepareUrlInput(input, normalizedOptions)
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
