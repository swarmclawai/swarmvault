import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
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

function parseDocxCoreMetadata(bytes: Buffer): Record<string, string> | undefined {
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
      metadata: parseDocxCoreMetadata(input.bytes),
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
