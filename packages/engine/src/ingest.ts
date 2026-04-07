import fs from "node:fs/promises";
import path from "node:path";
import { Readability } from "@mozilla/readability";
import ignore from "ignore";
import { JSDOM } from "jsdom";
import mime from "mime-types";
import TurndownService from "turndown";
import { inferCodeLanguage } from "./code-analysis.js";
import { initWorkspace, loadVaultConfig } from "./config.js";
import { appendLogEntry } from "./logs.js";
import type {
  AddOptions,
  AddResult,
  DirectoryIngestResult,
  InboxImportResult,
  IngestOptions,
  RepoSyncResult,
  ResolvedPaths,
  SourceAttachment,
  SourceManifest,
  WatchRepoSyncResult
} from "./types.js";
import {
  ensureDir,
  fileExists,
  listFilesRecursive,
  normalizeWhitespace,
  readJsonFile,
  sha256,
  slugify,
  toPosix,
  writeJsonFile
} from "./utils.js";
import { clearPendingSemanticRefreshEntries } from "./watch-state.js";

const DEFAULT_MAX_ASSET_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_FILES = 5000;
const BUILT_IN_REPO_IGNORES = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv", "vendor", "target"]);

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
  repoRelativePath?: string;
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
  wasUpdated: boolean;
};

type InboxAttachmentRef = {
  absolutePath: string;
  relativeRef: string;
};

type NormalizedIngestOptions = {
  includeAssets: boolean;
  maxAssetSize: number;
  repoRoot?: string;
  include: string[];
  exclude: string[];
  maxFiles: number;
  gitignore: boolean;
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
    maxAssetSize: Math.max(0, Math.floor(options?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE)),
    repoRoot: options?.repoRoot ? path.resolve(options.repoRoot) : undefined,
    include: (options?.include ?? []).map((pattern) => pattern.trim()).filter(Boolean),
    exclude: (options?.exclude ?? []).map((pattern) => pattern.trim()).filter(Boolean),
    maxFiles: Math.max(1, Math.floor(options?.maxFiles ?? DEFAULT_MAX_DIRECTORY_FILES)),
    gitignore: options?.gitignore ?? true
  };
}

function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  return patterns.some(
    (pattern) => path.matchesGlob(relativePath, pattern) || path.matchesGlob(path.posix.basename(relativePath), pattern)
  );
}

function supportedDirectoryKind(sourceKind: SourceManifest["sourceKind"]): boolean {
  return sourceKind !== "binary";
}

async function findNearestGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  try {
    const stat = await fs.stat(current);
    if (!stat.isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    current = path.dirname(current);
  }

  while (true) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function withinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function repoRootFromManifest(manifest: SourceManifest): string | null {
  if (manifest.originType !== "file" || !manifest.originalPath || !manifest.repoRelativePath) {
    return null;
  }

  const repoDir = path.posix.dirname(manifest.repoRelativePath);
  const fileDir = path.dirname(path.resolve(manifest.originalPath));
  if (repoDir === "." || !repoDir) {
    return fileDir;
  }

  const segments = repoDir.split("/").filter(Boolean);
  return path.resolve(fileDir, ...segments.map(() => ".."));
}

function repoRelativePathFor(absolutePath: string, repoRoot?: string): string | undefined {
  if (!repoRoot || !withinRoot(repoRoot, absolutePath)) {
    return undefined;
  }
  const relative = toPosix(path.relative(repoRoot, absolutePath));
  return relative && !relative.startsWith("..") ? relative : undefined;
}

function normalizeOriginUrl(input: string): string {
  try {
    return new URL(input).toString();
  } catch {
    return input;
  }
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function stripLeadingLabel(value: string, label: string): string {
  return value.startsWith(label) ? value.slice(label.length).trim() : value.trim();
}

function arxivIdFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(trimmed)) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function isTweetUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.hostname.includes("x.com") || url.hostname.includes("twitter.com");
  } catch {
    return false;
  }
}

function markdownFrontmatter(value: Record<string, string | undefined>): string[] {
  const lines = ["---"];
  for (const [key, rawValue] of Object.entries(value)) {
    if (!rawValue) {
      continue;
    }
    lines.push(`${key}: "${rawValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  lines.push("---", "");
  return lines;
}

function prepareCapturedMarkdownInput(input: { title: string; url: string; markdown: string; logDetails?: string[] }): PreparedInput {
  return {
    title: input.title,
    originType: "url",
    sourceKind: "markdown",
    url: normalizeOriginUrl(input.url),
    mimeType: "text/markdown",
    storedExtension: ".md",
    payloadBytes: Buffer.from(input.markdown, "utf8"),
    extractedText: input.markdown,
    logDetails: input.logDetails
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function domTextFromHtml(html: string, baseUrl: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  return normalizeWhitespace(dom.window.document.body.textContent ?? "");
}

async function captureArxivMarkdown(
  input: string,
  options: Pick<AddOptions, "author" | "contributor">
): Promise<{ title: string; normalizedUrl: string; markdown: string }> {
  const arxivId = arxivIdFromInput(input);
  if (!arxivId) {
    throw new Error(`Could not determine an arXiv id from ${input}`);
  }

  const normalizedUrl = `https://arxiv.org/abs/${arxivId}`;
  const html = await fetchText(normalizedUrl);
  const dom = new JSDOM(html, { url: normalizedUrl });
  const document = dom.window.document;
  const metaTitle = document.querySelector('meta[name="citation_title"]')?.getAttribute("content")?.trim();
  const headingTitle = document.querySelector("h1.title")?.textContent?.trim();
  const title = stripLeadingLabel(metaTitle ?? headingTitle ?? arxivId, "Title:");
  const authors = [...document.querySelectorAll('meta[name="citation_author"]')]
    .map((node) => node.getAttribute("content")?.trim())
    .filter((value): value is string => Boolean(value));
  const authorsText = authors.join(", ") || stripLeadingLabel(document.querySelector(".authors")?.textContent?.trim() ?? "", "Authors:");
  const abstract = stripLeadingLabel(document.querySelector("blockquote.abstract")?.textContent?.trim() ?? "", "Abstract:");
  const capturedAt = new Date().toISOString();
  const markdown = [
    ...markdownFrontmatter({
      capture_type: "arxiv",
      source_url: normalizedUrl,
      arxiv_id: arxivId,
      author: options.author,
      contributor: options.contributor,
      captured_at: capturedAt
    }),
    `# ${title}`,
    "",
    `- arXiv: ${arxivId}`,
    ...(authorsText ? [`- Authors: ${authorsText}`] : []),
    ...(options.author ? [`- Added By: ${options.author}`] : []),
    ...(options.contributor ? [`- Contributor: ${options.contributor}`] : []),
    "",
    "## Abstract",
    "",
    abstract || "Abstract not available from the fetched arXiv page.",
    "",
    "## Source",
    "",
    `- URL: ${normalizedUrl}`,
    ""
  ].join("\n");

  return { title, normalizedUrl, markdown };
}

async function captureTweetMarkdown(
  input: string,
  options: Pick<AddOptions, "author" | "contributor">
): Promise<{ title: string; normalizedUrl: string; markdown: string }> {
  const normalizedUrl = normalizeOriginUrl(input);
  const canonicalUrl = normalizedUrl.replace("x.com", "twitter.com");
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=true`;
  const response = await fetch(oembedUrl);
  let postText = "";
  let postAuthor = "";

  if (response.ok) {
    const payload = (await response.json()) as { html?: string; author_name?: string };
    postText = payload.html ? domTextFromHtml(payload.html, canonicalUrl) : "";
    postAuthor = payload.author_name?.trim() ?? "";
  }

  const title = postAuthor ? `X Post by ${postAuthor}` : "X Post";
  const capturedAt = new Date().toISOString();
  const markdown = [
    ...markdownFrontmatter({
      capture_type: "tweet",
      source_url: normalizedUrl,
      author: options.author,
      contributor: options.contributor,
      captured_at: capturedAt
    }),
    `# ${title}`,
    "",
    ...(postAuthor ? [`- Post Author: ${postAuthor}`] : []),
    ...(options.author ? [`- Added By: ${options.author}`] : []),
    ...(options.contributor ? [`- Contributor: ${options.contributor}`] : []),
    "",
    "## Content",
    "",
    postText || `Captured the post link at ${normalizedUrl}. Rich text was unavailable from the public oEmbed response.`,
    "",
    "## Source",
    "",
    `- URL: ${normalizedUrl}`,
    ""
  ].join("\n");

  return { title, normalizedUrl, markdown };
}

function manifestMatchesOrigin(manifest: SourceManifest, prepared: PreparedInput): boolean {
  if (prepared.originType === "url") {
    return Boolean(prepared.url && manifest.url && normalizeOriginUrl(manifest.url) === normalizeOriginUrl(prepared.url));
  }
  return Boolean(prepared.originalPath && manifest.originalPath && toPosix(manifest.originalPath) === toPosix(prepared.originalPath));
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

async function readManifestByOrigin(manifestsDir: string, prepared: PreparedInput): Promise<SourceManifest | null> {
  const entries = await fs.readdir(manifestsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const manifest = await readJsonFile<SourceManifest>(path.join(manifestsDir, entry.name));
    if (manifest && manifestMatchesOrigin(manifest, prepared)) {
      return manifest;
    }
  }
  return null;
}

async function loadGitignoreMatcher(repoRoot: string, enabled: boolean) {
  if (!enabled) {
    return null;
  }
  const gitignorePath = path.join(repoRoot, ".gitignore");
  if (!(await fileExists(gitignorePath))) {
    return null;
  }
  const matcher = ignore();
  matcher.add(await fs.readFile(gitignorePath, "utf8"));
  return matcher;
}

function builtInIgnoreReason(relativePath: string): string | null {
  for (const segment of relativePath.split("/")) {
    if (BUILT_IN_REPO_IGNORES.has(segment)) {
      return `built_in_ignore:${segment}`;
    }
  }
  return null;
}

async function collectDirectoryFiles(
  rootDir: string,
  inputDir: string,
  repoRoot: string,
  options: NormalizedIngestOptions
): Promise<{ files: string[]; skipped: DirectoryIngestResult["skipped"] }> {
  const matcher = await loadGitignoreMatcher(repoRoot, options.gitignore);
  const skipped: DirectoryIngestResult["skipped"] = [];
  const files: string[] = [];
  const stack = [inputDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativeToRepo = repoRelativePathFor(absolutePath, repoRoot) ?? toPosix(path.relative(inputDir, absolutePath));
      const relativePath = relativeToRepo || entry.name;
      const builtInReason = builtInIgnoreReason(relativePath);
      if (builtInReason) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: builtInReason });
        continue;
      }
      if (matcher?.ignores(relativePath)) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "gitignore" });
        continue;
      }
      if (matchesAnyGlob(relativePath, options.exclude)) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "exclude_glob" });
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "unsupported_entry" });
        continue;
      }
      if (options.include.length > 0 && !matchesAnyGlob(relativePath, options.include)) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "include_glob" });
        continue;
      }

      const mimeType = guessMimeType(absolutePath);
      const sourceKind = inferKind(mimeType, absolutePath);
      if (!supportedDirectoryKind(sourceKind)) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: `unsupported_kind:${sourceKind}` });
        continue;
      }
      if (files.length >= options.maxFiles) {
        skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "max_files" });
        continue;
      }
      files.push(absolutePath);
    }
  }

  return { files: files.sort((left, right) => left.localeCompare(right)), skipped };
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
  const existingByOrigin = await readManifestByOrigin(paths.manifestsDir, prepared);
  const existingByHash = existingByOrigin ? null : await readManifestByHash(paths.manifestsDir, contentHash);
  if (
    existingByOrigin &&
    existingByOrigin.contentHash === contentHash &&
    existingByOrigin.title === prepared.title &&
    existingByOrigin.sourceKind === prepared.sourceKind &&
    existingByOrigin.language === prepared.language &&
    existingByOrigin.mimeType === prepared.mimeType &&
    existingByOrigin.repoRelativePath === prepared.repoRelativePath
  ) {
    return { manifest: existingByOrigin, isNew: false, wasUpdated: false };
  }
  if (existingByHash) {
    return { manifest: existingByHash, isNew: false, wasUpdated: false };
  }

  const previous = existingByOrigin ?? undefined;
  const sourceId = previous?.sourceId ?? `${slugify(prepared.title)}-${contentHash.slice(0, 8)}`;
  const now = new Date().toISOString();
  const storedPath = path.join(paths.rawSourcesDir, `${sourceId}${prepared.storedExtension}`);
  const extractedTextPath = prepared.extractedText ? path.join(paths.extractsDir, `${sourceId}.md`) : undefined;
  const attachmentsDir = path.join(paths.rawAssetsDir, sourceId);

  if (previous?.storedPath) {
    await fs.rm(path.resolve(rootDir, previous.storedPath), { force: true });
  }
  if (previous?.extractedTextPath) {
    await fs.rm(path.resolve(rootDir, previous.extractedTextPath), { force: true });
  }
  await fs.rm(attachmentsDir, { recursive: true, force: true });

  await fs.writeFile(storedPath, prepared.payloadBytes);
  if (prepared.extractedText && extractedTextPath) {
    await fs.writeFile(extractedTextPath, prepared.extractedText, "utf8");
  }

  const manifestAttachments: SourceAttachment[] = [];
  for (const attachment of attachments) {
    const absoluteAttachmentPath = path.join(attachmentsDir, attachment.relativePath);
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
    repoRelativePath: prepared.repoRelativePath,
    url: prepared.url,
    storedPath: toPosix(path.relative(rootDir, storedPath)),
    extractedTextPath: extractedTextPath ? toPosix(path.relative(rootDir, extractedTextPath)) : undefined,
    mimeType: prepared.mimeType,
    contentHash,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    attachments: manifestAttachments.length ? manifestAttachments : undefined
  };

  await writeJsonFile(path.join(paths.manifestsDir, `${sourceId}.json`), manifest);
  await appendLogEntry(rootDir, "ingest", prepared.title, [
    `source_id=${sourceId}`,
    `kind=${prepared.sourceKind}`,
    `attachments=${manifestAttachments.length}`,
    `updated=${previous ? "true" : "false"}`,
    ...(prepared.logDetails ?? [])
  ]);

  if (manifest.originalPath || manifest.repoRelativePath || manifest.sourceId) {
    await clearPendingSemanticRefreshEntries(rootDir, {
      sourceId: manifest.sourceId,
      originalPath: manifest.originalPath,
      relativePath: manifest.repoRelativePath
    });
  }

  return { manifest, isNew: !previous, wasUpdated: Boolean(previous) };
}

async function removeManifestArtifacts(rootDir: string, manifest: SourceManifest, paths: ResolvedPaths): Promise<void> {
  await fs.rm(path.join(paths.manifestsDir, `${manifest.sourceId}.json`), { force: true });
  await fs.rm(path.resolve(rootDir, manifest.storedPath), { force: true });
  if (manifest.extractedTextPath) {
    await fs.rm(path.resolve(rootDir, manifest.extractedTextPath), { force: true });
  }
  await fs.rm(path.join(paths.rawAssetsDir, manifest.sourceId), { recursive: true, force: true });
  await fs.rm(path.join(paths.analysesDir, `${manifest.sourceId}.json`), { force: true });
}

function repoSyncWorkspaceIgnorePaths(rootDir: string, paths: ResolvedPaths, repoRoot: string): string[] {
  const candidates = [
    paths.rawDir,
    paths.wikiDir,
    paths.stateDir,
    paths.agentDir,
    paths.inboxDir,
    path.join(rootDir, ".claude"),
    path.join(rootDir, ".cursor"),
    path.join(rootDir, ".obsidian")
  ];

  return candidates
    .map((candidate) => path.resolve(candidate))
    .filter((candidate, index, items) => items.indexOf(candidate) === index)
    .filter((candidate) => withinRoot(repoRoot, candidate));
}

function preparedMatchesManifest(manifest: SourceManifest, prepared: PreparedInput, contentHash: string): boolean {
  return (
    manifest.contentHash === contentHash &&
    manifest.title === prepared.title &&
    manifest.sourceKind === prepared.sourceKind &&
    manifest.language === prepared.language &&
    manifest.mimeType === prepared.mimeType &&
    manifest.repoRelativePath === prepared.repoRelativePath
  );
}

function shouldDeferWatchSemanticRefresh(sourceKind: SourceManifest["sourceKind"]): boolean {
  return sourceKind === "markdown" || sourceKind === "text" || sourceKind === "html" || sourceKind === "pdf" || sourceKind === "image";
}

function pendingSemanticRefreshId(changeType: "added" | "modified" | "removed", repoRoot: string, relativePath: string): string {
  return `pending:${changeType}:${sha256(`${toPosix(repoRoot)}:${relativePath}`).slice(0, 12)}`;
}

export async function listTrackedRepoRoots(rootDir: string): Promise<string[]> {
  const manifests = await listManifests(rootDir);
  return [...new Set(manifests.map((manifest) => repoRootFromManifest(manifest)).filter((item): item is string => Boolean(item)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

export async function syncTrackedRepos(rootDir: string, options?: IngestOptions, repoRoots?: string[]): Promise<RepoSyncResult> {
  const { paths } = await initWorkspace(rootDir);
  const normalizedOptions = normalizeIngestOptions(options);
  const manifests = await listManifests(rootDir);
  const trackedRoots = (repoRoots && repoRoots.length > 0 ? repoRoots : await listTrackedRepoRoots(rootDir)).map((item) =>
    path.resolve(item)
  );
  const uniqueRoots = [...new Set(trackedRoots)].sort((left, right) => left.localeCompare(right));
  const manifestsByRepoRoot = new Map<string, SourceManifest[]>();

  for (const manifest of manifests) {
    const repoRoot = repoRootFromManifest(manifest);
    if (!repoRoot || !uniqueRoots.includes(path.resolve(repoRoot))) {
      continue;
    }
    const key = path.resolve(repoRoot);
    const bucket = manifestsByRepoRoot.get(key) ?? [];
    bucket.push(manifest);
    manifestsByRepoRoot.set(key, bucket);
  }

  const imported: SourceManifest[] = [];
  const updated: SourceManifest[] = [];
  const removed: SourceManifest[] = [];
  const skipped: DirectoryIngestResult["skipped"] = [];
  let scannedCount = 0;

  for (const repoRoot of uniqueRoots) {
    const repoManifests = manifestsByRepoRoot.get(repoRoot) ?? [];
    if (!(await fileExists(repoRoot))) {
      for (const manifest of repoManifests) {
        await removeManifestArtifacts(rootDir, manifest, paths);
        removed.push(manifest);
      }
      continue;
    }

    const ignoreRoots = repoSyncWorkspaceIgnorePaths(rootDir, paths, repoRoot);
    const collected = await collectDirectoryFiles(rootDir, repoRoot, repoRoot, normalizedOptions);
    const files = collected.files.filter((absolutePath) => !ignoreRoots.some((ignoreRoot) => withinRoot(ignoreRoot, absolutePath)));
    skipped.push(
      ...collected.skipped,
      ...collected.files
        .filter((absolutePath) => ignoreRoots.some((ignoreRoot) => withinRoot(ignoreRoot, absolutePath)))
        .map((absolutePath) => ({
          path: toPosix(path.relative(rootDir, absolutePath)),
          reason: "workspace_generated"
        }))
    );
    scannedCount += files.length;

    const currentPaths = new Set(files.map((absolutePath) => path.resolve(absolutePath)));
    for (const absolutePath of files) {
      const prepared = await prepareFileInput(rootDir, absolutePath, repoRoot);
      const result = await persistPreparedInput(rootDir, prepared, paths);
      if (result.isNew) {
        imported.push(result.manifest);
      } else if (result.wasUpdated) {
        updated.push(result.manifest);
      }
    }

    for (const manifest of repoManifests) {
      const originalPath = manifest.originalPath ? path.resolve(manifest.originalPath) : null;
      if (originalPath && !currentPaths.has(originalPath)) {
        await removeManifestArtifacts(rootDir, manifest, paths);
        removed.push(manifest);
      }
    }
  }

  if (uniqueRoots.length > 0) {
    await appendLogEntry(rootDir, "sync_repo", uniqueRoots.map((repoRoot) => toPosix(path.relative(rootDir, repoRoot)) || ".").join(","), [
      `repo_roots=${uniqueRoots.length}`,
      `scanned=${scannedCount}`,
      `imported=${imported.length}`,
      `updated=${updated.length}`,
      `removed=${removed.length}`,
      `skipped=${skipped.length}`
    ]);
  }

  return {
    repoRoots: uniqueRoots,
    scannedCount,
    imported,
    updated,
    removed,
    skipped
  };
}

export async function syncTrackedReposForWatch(
  rootDir: string,
  options?: IngestOptions,
  repoRoots?: string[]
): Promise<WatchRepoSyncResult> {
  const { paths } = await initWorkspace(rootDir);
  const normalizedOptions = normalizeIngestOptions(options);
  const manifests = await listManifests(rootDir);
  const trackedRoots = (repoRoots && repoRoots.length > 0 ? repoRoots : await listTrackedRepoRoots(rootDir)).map((item) =>
    path.resolve(item)
  );
  const uniqueRoots = [...new Set(trackedRoots)].sort((left, right) => left.localeCompare(right));
  const manifestsByRepoRoot = new Map<string, SourceManifest[]>();

  for (const manifest of manifests) {
    const repoRoot = repoRootFromManifest(manifest);
    if (!repoRoot || !uniqueRoots.includes(path.resolve(repoRoot))) {
      continue;
    }
    const key = path.resolve(repoRoot);
    const bucket = manifestsByRepoRoot.get(key) ?? [];
    bucket.push(manifest);
    manifestsByRepoRoot.set(key, bucket);
  }

  const imported: SourceManifest[] = [];
  const updated: SourceManifest[] = [];
  const removed: SourceManifest[] = [];
  const skipped: DirectoryIngestResult["skipped"] = [];
  const pendingSemanticRefresh: WatchRepoSyncResult["pendingSemanticRefresh"] = [];
  const staleSourceIds = new Set<string>();
  let scannedCount = 0;

  for (const repoRoot of uniqueRoots) {
    const repoManifests = manifestsByRepoRoot.get(repoRoot) ?? [];
    const manifestsByOriginalPath = new Map(
      repoManifests
        .filter((manifest) => manifest.originalPath)
        .map((manifest) => [path.resolve(manifest.originalPath as string), manifest] as const)
    );

    if (!(await fileExists(repoRoot))) {
      for (const manifest of repoManifests) {
        if (shouldDeferWatchSemanticRefresh(manifest.sourceKind)) {
          pendingSemanticRefresh.push({
            id: pendingSemanticRefreshId("removed", repoRoot, manifest.repoRelativePath ?? manifest.storedPath),
            repoRoot,
            path: toPosix(path.relative(rootDir, manifest.originalPath ?? manifest.storedPath)),
            changeType: "removed",
            detectedAt: new Date().toISOString(),
            sourceId: manifest.sourceId,
            sourceKind: manifest.sourceKind
          });
          staleSourceIds.add(manifest.sourceId);
        } else {
          await removeManifestArtifacts(rootDir, manifest, paths);
          removed.push(manifest);
        }
      }
      continue;
    }

    const ignoreRoots = repoSyncWorkspaceIgnorePaths(rootDir, paths, repoRoot);
    const collected = await collectDirectoryFiles(rootDir, repoRoot, repoRoot, normalizedOptions);
    const files = collected.files.filter((absolutePath) => !ignoreRoots.some((ignoreRoot) => withinRoot(ignoreRoot, absolutePath)));
    skipped.push(
      ...collected.skipped,
      ...collected.files
        .filter((absolutePath) => ignoreRoots.some((ignoreRoot) => withinRoot(ignoreRoot, absolutePath)))
        .map((absolutePath) => ({
          path: toPosix(path.relative(rootDir, absolutePath)),
          reason: "workspace_generated"
        }))
    );
    scannedCount += files.length;

    const currentPaths = new Set(files.map((absolutePath) => path.resolve(absolutePath)));
    for (const absolutePath of files) {
      const prepared = await prepareFileInput(rootDir, absolutePath, repoRoot);
      if (shouldDeferWatchSemanticRefresh(prepared.sourceKind)) {
        const existing = manifestsByOriginalPath.get(path.resolve(absolutePath));
        const contentHash = buildCompositeHash(prepared.payloadBytes, prepared.attachments);
        const changed = !existing || !preparedMatchesManifest(existing, prepared, contentHash);
        if (changed) {
          pendingSemanticRefresh.push({
            id: pendingSemanticRefreshId(
              existing ? "modified" : "added",
              repoRoot,
              prepared.repoRelativePath ?? toPosix(path.relative(repoRoot, absolutePath))
            ),
            repoRoot,
            path: toPosix(path.relative(rootDir, absolutePath)),
            changeType: existing ? "modified" : "added",
            detectedAt: new Date().toISOString(),
            sourceId: existing?.sourceId,
            sourceKind: prepared.sourceKind
          });
          if (existing?.sourceId) {
            staleSourceIds.add(existing.sourceId);
          }
        }
        continue;
      }

      const result = await persistPreparedInput(rootDir, prepared, paths);
      if (result.isNew) {
        imported.push(result.manifest);
      } else if (result.wasUpdated) {
        updated.push(result.manifest);
      }
    }

    for (const manifest of repoManifests) {
      const originalPath = manifest.originalPath ? path.resolve(manifest.originalPath) : null;
      if (originalPath && !currentPaths.has(originalPath)) {
        if (shouldDeferWatchSemanticRefresh(manifest.sourceKind)) {
          pendingSemanticRefresh.push({
            id: pendingSemanticRefreshId("removed", repoRoot, manifest.repoRelativePath ?? toPosix(path.relative(repoRoot, originalPath))),
            repoRoot,
            path: toPosix(path.relative(rootDir, originalPath)),
            changeType: "removed",
            detectedAt: new Date().toISOString(),
            sourceId: manifest.sourceId,
            sourceKind: manifest.sourceKind
          });
          staleSourceIds.add(manifest.sourceId);
        } else {
          await removeManifestArtifacts(rootDir, manifest, paths);
          removed.push(manifest);
        }
      }
    }
  }

  if (uniqueRoots.length > 0) {
    await appendLogEntry(
      rootDir,
      "sync_repo_watch",
      uniqueRoots.map((repoRoot) => toPosix(path.relative(rootDir, repoRoot)) || ".").join(","),
      [
        `repo_roots=${uniqueRoots.length}`,
        `scanned=${scannedCount}`,
        `imported=${imported.length}`,
        `updated=${updated.length}`,
        `removed=${removed.length}`,
        `pending_semantic_refresh=${pendingSemanticRefresh.length}`,
        `skipped=${skipped.length}`
      ]
    );
  }

  return {
    repoRoots: uniqueRoots,
    scannedCount,
    imported,
    updated,
    removed,
    skipped,
    pendingSemanticRefresh: pendingSemanticRefresh.filter(
      (entry, index, items) => index === items.findIndex((candidate) => candidate.id === entry.id)
    ),
    staleSourceIds: [...staleSourceIds]
  };
}

async function prepareFileInput(_rootDir: string, absoluteInput: string, repoRoot?: string): Promise<PreparedInput> {
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
    repoRelativePath: repoRelativePathFor(absoluteInput, repoRoot),
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
  const absoluteInput = path.resolve(rootDir, input);
  const repoRoot =
    isHttpUrl(input) || normalizedOptions.repoRoot
      ? normalizedOptions.repoRoot
      : await findNearestGitRoot(absoluteInput).then((value) => value ?? path.dirname(absoluteInput));
  const prepared = isHttpUrl(input)
    ? await prepareUrlInput(input, normalizedOptions)
    : await prepareFileInput(rootDir, absoluteInput, repoRoot);

  const result = await persistPreparedInput(rootDir, prepared, paths);
  return result.manifest;
}

export async function addInput(rootDir: string, input: string, options: AddOptions = {}): Promise<AddResult> {
  const { paths } = await initWorkspace(rootDir);
  if (!isHttpUrl(input) && !arxivIdFromInput(input)) {
    throw new Error("`swarmvault add` only supports URLs and bare arXiv ids in the current release.");
  }

  let prepared: PreparedInput | null = null;
  let captureType: AddResult["captureType"] = "url";
  let normalizedUrl = input;
  let fallback = false;

  try {
    if (arxivIdFromInput(input)) {
      const captured = await captureArxivMarkdown(input, options);
      prepared = prepareCapturedMarkdownInput({
        title: captured.title,
        url: captured.normalizedUrl,
        markdown: captured.markdown,
        logDetails: ["capture_type=arxiv"]
      });
      captureType = "arxiv";
      normalizedUrl = captured.normalizedUrl;
    } else if (isTweetUrl(input)) {
      const captured = await captureTweetMarkdown(input, options);
      prepared = prepareCapturedMarkdownInput({
        title: captured.title,
        url: captured.normalizedUrl,
        markdown: captured.markdown,
        logDetails: ["capture_type=tweet"]
      });
      captureType = "tweet";
      normalizedUrl = captured.normalizedUrl;
    }
  } catch {
    fallback = true;
  }

  if (!prepared) {
    normalizedUrl = arxivIdFromInput(input) ? `https://arxiv.org/abs/${arxivIdFromInput(input)}` : normalizeOriginUrl(input);
    return {
      captureType: "url",
      manifest: await ingestInput(rootDir, normalizedUrl, options),
      normalizedUrl,
      title: normalizedUrl,
      fallback: true
    };
  }

  const result = await persistPreparedInput(rootDir, prepared, paths);
  return {
    captureType,
    manifest: result.manifest,
    normalizedUrl,
    title: prepared.title,
    fallback
  };
}

export async function ingestDirectory(rootDir: string, inputDir: string, options?: IngestOptions): Promise<DirectoryIngestResult> {
  const { paths } = await initWorkspace(rootDir);
  const normalizedOptions = normalizeIngestOptions(options);
  const absoluteInputDir = path.resolve(rootDir, inputDir);
  const repoRoot = normalizedOptions.repoRoot ?? (await findNearestGitRoot(absoluteInputDir)) ?? absoluteInputDir;
  if (!(await fileExists(absoluteInputDir))) {
    throw new Error(`Directory not found: ${absoluteInputDir}`);
  }

  const { files, skipped } = await collectDirectoryFiles(rootDir, absoluteInputDir, repoRoot, normalizedOptions);
  const imported: SourceManifest[] = [];
  const updated: SourceManifest[] = [];

  for (const absolutePath of files) {
    const prepared = await prepareFileInput(rootDir, absolutePath, repoRoot);
    const result = await persistPreparedInput(rootDir, prepared, paths);
    if (result.isNew) {
      imported.push(result.manifest);
    } else if (result.wasUpdated) {
      updated.push(result.manifest);
    } else {
      skipped.push({ path: toPosix(path.relative(rootDir, absolutePath)), reason: "duplicate_content" });
    }
  }

  await appendLogEntry(rootDir, "ingest_directory", toPosix(path.relative(rootDir, absoluteInputDir)) || ".", [
    `repo_root=${toPosix(path.relative(rootDir, repoRoot)) || "."}`,
    `scanned=${files.length}`,
    `imported=${imported.length}`,
    `updated=${updated.length}`,
    `skipped=${skipped.length}`
  ]);

  return {
    inputDir: absoluteInputDir,
    repoRoot,
    scannedCount: files.length,
    imported,
    updated,
    skipped
  };
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
