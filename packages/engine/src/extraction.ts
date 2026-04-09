import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseCsvSync } from "csv-parse/sync";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { z } from "zod";
import { getProviderForTask } from "./providers/registry.js";
import type { ProviderAdapter, SourceExtractionArtifact, SourceKind } from "./types.js";
import { normalizeWhitespace, sha256, truncate } from "./utils.js";

const imageVisionExtractionSchema = z.object({
  title: z.string().min(1).nullable().optional(),
  summary: z.string().min(1),
  text: z.string().default(""),
  concepts: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().default("")
      })
    )
    .max(12)
    .default([]),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().default("")
      })
    )
    .max(12)
    .default([]),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.65),
        polarity: z.enum(["positive", "negative", "neutral"]).default("neutral")
      })
    )
    .max(8)
    .default([]),
  questions: z.array(z.string().min(1)).max(6).default([])
});

function extractionMetadata(
  sourceKind: SourceKind,
  mimeType: string,
  extractor: SourceExtractionArtifact["extractor"]
): SourceExtractionArtifact {
  return {
    extractor,
    sourceKind,
    mimeType,
    producedAt: new Date().toISOString()
  };
}

export function buildExtractionHash(extractedText?: string, artifact?: SourceExtractionArtifact): string | undefined {
  if (!extractedText && !artifact) {
    return undefined;
  }

  const normalizedArtifact = artifact
    ? {
        ...artifact,
        producedAt: undefined
      }
    : null;

  return sha256(
    JSON.stringify({
      extractedText: extractedText ?? null,
      artifact: normalizedArtifact
    })
  );
}

export function createPlainTextExtractionArtifact(sourceKind: SourceKind, mimeType: string): SourceExtractionArtifact {
  return extractionMetadata(sourceKind, mimeType, "plain_text");
}

export function createHtmlReadabilityExtractionArtifact(sourceKind: SourceKind, mimeType: string): SourceExtractionArtifact {
  return extractionMetadata(sourceKind, mimeType, "html_readability");
}

function normalizeVisionMarkdown(payload: z.infer<typeof imageVisionExtractionSchema>): string {
  const sections: string[] = [];

  if (payload.summary.trim()) {
    sections.push(payload.summary.trim());
  }

  if (payload.text.trim()) {
    sections.push(payload.text.trim());
  }

  if (payload.claims.length) {
    sections.push(payload.claims.map((claim) => `- ${claim.text}`).join("\n"));
  }

  return sections.join("\n\n").trim();
}

async function materializeAttachmentPath(input: { filePath?: string; bytes?: Buffer; mimeType: string }): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  if (input.filePath) {
    return {
      filePath: input.filePath,
      cleanup: async () => {}
    };
  }

  if (!input.bytes) {
    throw new Error("Image extraction requires a file path or bytes.");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-image-extract-"));
  const extension = input.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
  const tempPath = path.join(tempDir, `source.${extension}`);
  await fs.writeFile(tempPath, input.bytes);

  return {
    filePath: tempPath,
    cleanup: async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

export async function extractImageWithVision(
  rootDir: string,
  input: { title: string; mimeType: string; filePath?: string; bytes?: Buffer }
): Promise<{ title?: string; extractedText?: string; artifact: SourceExtractionArtifact }> {
  let provider: ProviderAdapter;
  try {
    provider = await getProviderForTask(rootDir, "visionProvider");
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("image", input.mimeType, "image_vision"),
        warnings: [`Vision extraction unavailable: ${error instanceof Error ? error.message : "provider not configured"}`]
      }
    };
  }

  if (provider.type === "heuristic" || !provider.capabilities.has("vision") || !provider.capabilities.has("structured")) {
    return {
      artifact: {
        ...extractionMetadata("image", input.mimeType, "image_vision"),
        warnings: [`Vision extraction unavailable for provider ${provider.id}. Configure a structured multimodal provider.`]
      }
    };
  }

  const attachment = await materializeAttachmentPath(input);
  try {
    const parsed = await provider.generateStructured(
      {
        system: [
          "You extract grounded notes from a single image for a local-first knowledge vault.",
          "Only describe content that is actually visible.",
          "If the image contains text, transcribe it accurately.",
          "If the image is a diagram or screenshot, summarize the key visible relationships and labels without speculation."
        ].join("\n"),
        prompt: [
          `Source title: ${input.title}`,
          "Return structured extraction for this image.",
          "Include a concise summary, OCR-style text, grounded concepts/entities, visible claims, and follow-up questions."
        ].join("\n"),
        attachments: [{ mimeType: input.mimeType, filePath: attachment.filePath }]
      },
      imageVisionExtractionSchema
    );

    const artifact: SourceExtractionArtifact = {
      ...extractionMetadata("image", input.mimeType, "image_vision"),
      providerId: provider.id,
      providerModel: provider.model,
      vision: {
        title: parsed.title ?? undefined,
        summary: parsed.summary,
        text: parsed.text,
        concepts: parsed.concepts,
        entities: parsed.entities,
        claims: parsed.claims,
        questions: parsed.questions
      }
    };

    return {
      title: parsed.title ?? undefined,
      extractedText: normalizeVisionMarkdown(parsed),
      artifact
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("image", input.mimeType, "image_vision"),
        providerId: provider.id,
        providerModel: provider.model,
        warnings: [`Vision extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  } finally {
    await attachment.cleanup();
  }
}

function normalizePdfMetadata(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      const cleaned = normalizeWhitespace(value);
      if (cleaned) {
        metadata[key] = cleaned;
      }
    }
  }

  return Object.keys(metadata).length ? metadata : undefined;
}

function normalizeDocumentText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((section) => normalizeWhitespace(section))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function parseOfficeCoreMetadata(bytes: Buffer): Record<string, string> | undefined {
  try {
    const archive = unzipSync(new Uint8Array(bytes));
    const coreXml = archive["docProps/core.xml"];
    if (!coreXml) {
      return undefined;
    }

    const dom = new JSDOM(strFromU8(coreXml), { contentType: "text/xml" });
    const document = dom.window.document;
    const valuesByLocalName = new Map<string, string>();

    for (const node of Array.from(document.getElementsByTagName("*"))) {
      const localName = node.localName?.trim().toLowerCase();
      const text = normalizeWhitespace(node.textContent ?? "");
      if (!localName || !text || valuesByLocalName.has(localName)) {
        continue;
      }
      valuesByLocalName.set(localName, text);
    }

    const metadata: Record<string, string> = {};
    const mappings: Array<[string, string]> = [
      ["title", "title"],
      ["author", "creator"],
      ["subject", "subject"],
      ["description", "description"],
      ["keywords", "keywords"],
      ["last_modified_by", "lastmodifiedby"],
      ["created", "created"],
      ["modified", "modified"]
    ];

    for (const [targetKey, sourceKey] of mappings) {
      const value = valuesByLocalName.get(sourceKey);
      if (value) {
        metadata[targetKey] = value;
      }
    }

    return Object.keys(metadata).length ? metadata : undefined;
  } catch {
    return undefined;
  }
}

function decodeTextBytes(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeTableCell(value: unknown): string {
  return normalizeWhitespace(String(value ?? ""));
}

function isNumericCell(value: string): boolean {
  return value.length > 0 && Number.isFinite(Number(value));
}

function detectHeaderRow(rows: string[][]): { headers: string[]; bodyRows: string[][] } {
  if (!rows.length) {
    return { headers: [], bodyRows: [] };
  }

  const firstRow = rows[0] ?? [];
  const nonEmpty = firstRow.filter(Boolean);
  const unique = new Set(nonEmpty);
  const nonNumeric = nonEmpty.filter((value) => !isNumericCell(value));
  const looksLikeHeader =
    nonEmpty.length > 0 && unique.size === nonEmpty.length && nonNumeric.length >= Math.ceil(nonEmpty.length / 2) && rows.length > 1;

  if (looksLikeHeader) {
    return {
      headers: firstRow.map((value, index) => value || `column_${index + 1}`),
      bodyRows: rows.slice(1)
    };
  }

  const columnCount = Math.max(...rows.map((row) => row.length), 0);
  return {
    headers: Array.from({ length: columnCount }, (_, index) => `column_${index + 1}`),
    bodyRows: rows
  };
}

function columnHints(headers: string[], rows: string[][]): string[] {
  return headers
    .map((header, index) => {
      const values = rows
        .map((row) => row[index] ?? "")
        .map(normalizeTableCell)
        .filter(Boolean);
      if (!values.length) {
        return null;
      }
      const uniqueValues = [...new Set(values)];
      if (values.every(isNumericCell)) {
        return `- ${header}: numeric`;
      }
      if (uniqueValues.length <= 6 && values.length >= uniqueValues.length) {
        return `- ${header}: low-cardinality (${uniqueValues.slice(0, 6).join(", ")})`;
      }
      return null;
    })
    .filter((item): item is string => Boolean(item));
}

function markdownTable(headers: string[], rows: string[][], rowLimit = 20): string[] {
  if (!headers.length) {
    return ["No tabular preview available."];
  }
  const width = headers.length;
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows.slice(0, rowLimit)) {
    const normalized = Array.from({ length: width }, (_, index) => normalizeTableCell(row[index] ?? ""));
    lines.push(`| ${normalized.join(" | ")} |`);
  }
  return lines;
}

function zipEntryText(archive: Record<string, Uint8Array>, entryPath: string): string | undefined {
  const entry = archive[entryPath];
  return entry ? strFromU8(entry) : undefined;
}

function parseXmlDocument(xml: string): Document {
  return new JSDOM(xml, { contentType: "text/xml" }).window.document;
}

function zipDirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? "" : value.slice(0, index);
}

function resolveZipTarget(basePath: string, target: string): string {
  return path.posix.normalize(path.posix.join(zipDirname(basePath), target));
}

function relationshipTargets(xml: string, basePath: string): Map<string, { target: string; type: string }> {
  const document = parseXmlDocument(xml);
  const map = new Map<string, { target: string; type: string }>();
  for (const node of Array.from(document.getElementsByTagName("*"))) {
    if (node.localName !== "Relationship") {
      continue;
    }
    const id = node.getAttribute("Id")?.trim();
    const target = node.getAttribute("Target")?.trim();
    const type = node.getAttribute("Type")?.trim() ?? "";
    if (!id || !target) {
      continue;
    }
    map.set(id, { target: resolveZipTarget(basePath, target), type });
  }
  return map;
}

function xmlTextNodes(xml: string, localName: string): string[] {
  const document = parseXmlDocument(xml);
  const values: string[] = [];
  for (const node of Array.from(document.getElementsByTagName("*"))) {
    if (node.localName !== localName) {
      continue;
    }
    const text = normalizeWhitespace(node.textContent ?? "");
    if (text) {
      values.push(text);
    }
  }
  return values;
}

function firstHtmlHeading(html: string): string | undefined {
  const dom = new JSDOM(html);
  const heading = dom.window.document.querySelector("h1, h2, h3");
  const title = normalizeWhitespace(heading?.textContent ?? "");
  return title || undefined;
}

function htmlToMarkdown(html: string): string {
  const dom = new JSDOM(html);
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const body = dom.window.document.body?.innerHTML ?? html;
  return turndown.turndown(body).trim();
}

export interface EpubChapterExtraction {
  partKey: string;
  title: string;
  markdown: string;
  metadata: Record<string, string>;
}

export async function extractPdfText(input: {
  mimeType: string;
  bytes: Buffer;
}): Promise<{ extractedText?: string; artifact: SourceExtractionArtifact }> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(input.bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0
    });
    const document = await task.promise;
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = normalizeWhitespace(
        textContent.items
          .map((item) => (typeof item === "object" && item && "str" in item && typeof item.str === "string" ? item.str : ""))
          .join(" ")
      );
      if (pageText) {
        pageTexts.push(pageText);
      }
      page.cleanup();
    }

    const metadataResult = await document.getMetadata().catch(() => null);
    await task.destroy();

    const extractedText = pageTexts.join("\n\n").trim();
    const artifact: SourceExtractionArtifact = {
      ...extractionMetadata("pdf", input.mimeType, "pdf_text"),
      pageCount: document.numPages,
      metadata: normalizePdfMetadata(metadataResult?.info)
    };

    if (!extractedText) {
      artifact.warnings = ["PDF text extraction completed but produced no extractable text."];
    }

    return {
      extractedText: extractedText || undefined,
      artifact
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("pdf", input.mimeType, "pdf_text"),
        warnings: [`PDF text extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}

export async function extractDocxText(input: {
  mimeType: string;
  bytes: Buffer;
}): Promise<{ extractedText?: string; artifact: SourceExtractionArtifact }> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({
      buffer: input.bytes
    });
    const extractedText = normalizeDocumentText(result.value);
    const warnings = result.messages
      .map((message) => normalizeWhitespace(message.message))
      .filter(Boolean)
      .map((message) => truncate(message, 240));

    const artifact: SourceExtractionArtifact = {
      ...extractionMetadata("docx", input.mimeType, "docx_text"),
      metadata: parseOfficeCoreMetadata(input.bytes),
      warnings: warnings.length ? warnings : undefined
    };

    if (!extractedText) {
      artifact.warnings = [...(artifact.warnings ?? []), "DOCX text extraction completed but produced no extractable text."];
    }

    return {
      extractedText: extractedText || undefined,
      artifact
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("docx", input.mimeType, "docx_text"),
        warnings: [`DOCX text extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}

export async function extractCsvText(input: {
  mimeType: string;
  bytes: Buffer;
  fileName?: string;
}): Promise<{ title?: string; extractedText?: string; artifact: SourceExtractionArtifact }> {
  try {
    const rawText = decodeTextBytes(input.bytes);
    const delimiter = input.fileName?.toLowerCase().endsWith(".tsv") || input.mimeType.includes("tab-separated") ? "\t" : ",";
    const parsed = parseCsvSync(rawText, {
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true
    }) as string[][];
    const rows = parsed.map((row) => row.map((value) => normalizeTableCell(value)));
    const { headers, bodyRows } = detectHeaderRow(rows);
    const hintLines = columnHints(headers, bodyRows);
    const title = input.fileName ? path.basename(input.fileName, path.extname(input.fileName)) : undefined;
    const extractedText = [
      title ? `# ${title}` : null,
      `Format: ${delimiter === "\t" ? "TSV" : "CSV"}`,
      `Rows: ${bodyRows.length}`,
      `Columns: ${headers.length}`,
      headers.length ? `Headers: ${headers.join(", ")}` : null,
      "",
      hintLines.length ? "## Column Hints" : null,
      hintLines.length ? hintLines.join("\n") : null,
      hintLines.length ? "" : null,
      "## Preview",
      ...markdownTable(headers, bodyRows)
    ]
      .filter((item): item is string => Boolean(item))
      .join("\n")
      .trim();

    const artifact: SourceExtractionArtifact = {
      ...extractionMetadata("csv", input.mimeType, "csv_text"),
      metadata: {
        format: delimiter === "\t" ? "tsv" : "csv",
        row_count: String(bodyRows.length),
        column_count: String(headers.length),
        headers: headers.join(", ")
      }
    };

    return {
      title,
      extractedText,
      artifact
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("csv", input.mimeType, "csv_text"),
        warnings: [`CSV extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}

export async function extractXlsxText(input: {
  mimeType: string;
  bytes: Buffer;
  fileName?: string;
}): Promise<{ title?: string; extractedText?: string; artifact: SourceExtractionArtifact }> {
  try {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(input.bytes, { type: "buffer", cellFormula: false, cellHTML: false, cellStyles: false });
    const allSheetNames = workbook.SheetNames;
    const sheetNames = allSheetNames.slice(0, 10);
    const sheetSections: string[] = [];
    const metadata: Record<string, string> = {
      sheet_count: String(allSheetNames.length),
      sheet_names: allSheetNames.join(", ")
    };

    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        continue;
      }
      const rows = (
        XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          raw: false,
          defval: ""
        }) as unknown[][]
      ).map((row) => row.map((value) => normalizeTableCell(value)));
      const { headers, bodyRows } = detectHeaderRow(rows);
      sheetSections.push(`## Sheet: ${sheetName}`);
      sheetSections.push(`Rows: ${bodyRows.length}`);
      sheetSections.push(`Columns: ${headers.length}`);
      sheetSections.push(...markdownTable(headers, bodyRows));
      sheetSections.push("");
    }

    const title =
      normalizeWhitespace(String(workbook.Props?.Title ?? "")) ||
      (input.fileName ? path.basename(input.fileName, path.extname(input.fileName)) : undefined);
    const extractedText = [
      title ? `# ${title}` : null,
      `Sheets: ${allSheetNames.length}`,
      allSheetNames.length ? `Sheet Names: ${allSheetNames.join(", ")}` : null,
      "",
      ...sheetSections
    ]
      .filter((item): item is string => Boolean(item))
      .join("\n")
      .trim();

    const warnings = allSheetNames.length > sheetNames.length ? ["Workbook preview truncated to the first 10 sheets."] : undefined;
    return {
      title,
      extractedText,
      artifact: {
        ...extractionMetadata("xlsx", input.mimeType, "xlsx_text"),
        metadata,
        warnings
      }
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("xlsx", input.mimeType, "xlsx_text"),
        warnings: [`XLSX extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}

export async function extractPptxText(input: {
  mimeType: string;
  bytes: Buffer;
  fileName?: string;
}): Promise<{ title?: string; extractedText?: string; artifact: SourceExtractionArtifact }> {
  try {
    const archive = unzipSync(new Uint8Array(input.bytes));
    const presentationXml = zipEntryText(archive, "ppt/presentation.xml");
    if (!presentationXml) {
      throw new Error("Missing ppt/presentation.xml");
    }
    const relsXml = zipEntryText(archive, "ppt/_rels/presentation.xml.rels");
    if (!relsXml) {
      throw new Error("Missing ppt/_rels/presentation.xml.rels");
    }
    const rels = relationshipTargets(relsXml, "ppt/presentation.xml");
    const document = parseXmlDocument(presentationXml);
    const slideTargets = Array.from(document.getElementsByTagName("*"))
      .filter((node) => node.localName === "sldId")
      .map((node) => node.getAttribute("r:id")?.trim())
      .filter((value): value is string => Boolean(value))
      .map((relationshipId) => rels.get(relationshipId)?.target)
      .filter((value): value is string => Boolean(value))
      .slice(0, 60);

    const slideSections: string[] = [];
    for (let index = 0; index < slideTargets.length; index += 1) {
      const slidePath = slideTargets[index]!;
      const slideXml = zipEntryText(archive, slidePath);
      if (!slideXml) {
        continue;
      }
      const slideTexts = xmlTextNodes(slideXml, "t");
      const slideTitle = slideTexts[0] ?? `Slide ${index + 1}`;
      slideSections.push(`## Slide ${index + 1}: ${slideTitle}`);
      if (slideTexts.length) {
        slideSections.push(slideTexts.join("\n"));
      }
      const slideRelsPath = `${zipDirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`;
      const slideRelsXml = zipEntryText(archive, slideRelsPath);
      if (slideRelsXml) {
        const slideRels = relationshipTargets(slideRelsXml, slidePath);
        const notesTarget = [...slideRels.values()].find((entry) => entry.type.endsWith("/notesSlide"))?.target;
        if (notesTarget) {
          const notesXml = zipEntryText(archive, notesTarget);
          const noteTexts = notesXml ? xmlTextNodes(notesXml, "t") : [];
          if (noteTexts.length) {
            slideSections.push("Notes:");
            slideSections.push(noteTexts.join("\n"));
          }
        }
      }
      slideSections.push("");
    }

    const metadata = parseOfficeCoreMetadata(input.bytes);
    const title = metadata?.title || (input.fileName ? path.basename(input.fileName, path.extname(input.fileName)) : undefined);
    const extractedText = [title ? `# ${title}` : null, `Slides: ${slideTargets.length}`, "", ...slideSections]
      .filter((item): item is string => Boolean(item))
      .join("\n")
      .trim();

    return {
      title,
      extractedText,
      artifact: {
        ...extractionMetadata("pptx", input.mimeType, "pptx_text"),
        metadata: {
          ...(metadata ?? {}),
          slide_count: String(slideTargets.length)
        },
        warnings:
          Array.from(document.getElementsByTagName("*")).filter((node) => node.localName === "sldId").length > slideTargets.length
            ? ["Slide extraction truncated to the first 60 slides."]
            : undefined
      }
    };
  } catch (error) {
    return {
      artifact: {
        ...extractionMetadata("pptx", input.mimeType, "pptx_text"),
        warnings: [`PPTX extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
      }
    };
  }
}

export async function extractEpubChapters(input: {
  mimeType: string;
  bytes: Buffer;
  fileName?: string;
}): Promise<{ title?: string; author?: string; chapters: EpubChapterExtraction[]; warnings?: string[] }> {
  try {
    const archive = unzipSync(new Uint8Array(input.bytes));
    const containerXml = zipEntryText(archive, "META-INF/container.xml");
    if (!containerXml) {
      throw new Error("Missing META-INF/container.xml");
    }
    const container = parseXmlDocument(containerXml);
    const rootfile = Array.from(container.getElementsByTagName("*")).find((node) => node.localName === "rootfile");
    const packagePath = rootfile?.getAttribute("full-path")?.trim();
    if (!packagePath) {
      throw new Error("EPUB container did not declare a package document.");
    }
    const packageXml = zipEntryText(archive, packagePath);
    if (!packageXml) {
      throw new Error(`Missing EPUB package document: ${packagePath}`);
    }
    const packageDocument = parseXmlDocument(packageXml);
    const manifestEntries = new Map(
      Array.from(packageDocument.getElementsByTagName("*"))
        .filter((node) => node.localName === "item")
        .map(
          (node) =>
            [
              node.getAttribute("id")?.trim() ?? "",
              {
                href: node.getAttribute("href")?.trim() ?? "",
                mediaType: node.getAttribute("media-type")?.trim() ?? "",
                properties: node.getAttribute("properties")?.trim() ?? ""
              }
            ] as const
        )
        .filter(([id, item]) => Boolean(id && item.href))
    );
    const spineIds = Array.from(packageDocument.getElementsByTagName("*"))
      .filter((node) => node.localName === "itemref")
      .map((node) => node.getAttribute("idref")?.trim())
      .filter((value): value is string => Boolean(value));
    const bookTitle =
      xmlTextNodes(packageXml, "title")[0] || (input.fileName ? path.basename(input.fileName, path.extname(input.fileName)) : undefined);
    const author = xmlTextNodes(packageXml, "creator")[0];

    const chapters: EpubChapterExtraction[] = [];
    for (const spineId of spineIds) {
      const item = manifestEntries.get(spineId);
      if (!item || (!item.mediaType.includes("html") && !item.mediaType.includes("xhtml"))) {
        continue;
      }
      if (item.properties.split(/\s+/).includes("nav")) {
        continue;
      }
      const entryPath = resolveZipTarget(packagePath, item.href);
      const html = zipEntryText(archive, entryPath);
      if (!html) {
        continue;
      }
      const markdown = htmlToMarkdown(html);
      if (!markdown) {
        continue;
      }
      const chapterTitle = firstHtmlHeading(html) || markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || item.href;
      const normalizedTitle = normalizeWhitespace(chapterTitle);
      if (!normalizedTitle || /^table of contents$/i.test(normalizedTitle)) {
        continue;
      }
      chapters.push({
        partKey: item.href,
        title: normalizedTitle,
        markdown,
        metadata: {
          book_title: bookTitle ?? "",
          chapter_title: normalizedTitle,
          author: author ?? ""
        }
      });
    }

    return {
      title: bookTitle,
      author,
      chapters,
      warnings: chapters.length ? undefined : ["EPUB extraction completed but found no chapter-like spine entries."]
    };
  } catch (error) {
    return {
      chapters: [],
      warnings: [`EPUB extraction failed: ${error instanceof Error ? truncate(error.message, 240) : "unknown error"}`]
    };
  }
}
