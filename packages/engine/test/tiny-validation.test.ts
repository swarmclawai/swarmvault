import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, ingestDirectory, initVault, searchVault } from "../src/index.js";
import type { CodeLanguage, SourceExtractionArtifact, SourceKind, SourceManifest } from "../src/types.js";

const tempDirs: string[] = [];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tinyFixtureDir = path.resolve(__dirname, "..", "..", "..", "smoke", "fixtures", "tiny-matrix");
const MINIMAL_DOCX = Buffer.from(
  "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",
  "base64"
);

async function createSimpleXlsx(): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Metric", "Value"],
      ["Users", 12],
      ["Errors", 1]
    ]),
    "Overview"
  );
  workbook.Props = { Title: "Tiny Workbook" };
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function createSimplePptx(): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
          '<Default Extension="xml" ContentType="application/xml"/>',
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
          '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
          '<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>',
          '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
          "</Types>"
        ].join(""),
        "utf8"
      ),
      "_rels/.rels": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>',
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
          "</Relationships>"
        ].join(""),
        "utf8"
      ),
      "docProps/core.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">',
          "<dc:title>Tiny Slide Deck</dc:title>",
          "<dc:creator>SwarmVault Tests</dc:creator>",
          "</cp:coreProperties>"
        ].join(""),
        "utf8"
      ),
      "ppt/presentation.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
          '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>',
          "</p:presentation>"
        ].join(""),
        "utf8"
      ),
      "ppt/_rels/presentation.xml.rels": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
          "</Relationships>"
        ].join(""),
        "utf8"
      ),
      "ppt/slides/slide1.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
          "<p:cSld><p:spTree><p:sp><p:txBody>",
          "<a:p><a:r><a:t>Tiny Slide Deck</a:t></a:r></a:p>",
          "<a:p><a:r><a:t>Slides should stay searchable.</a:t></a:r></a:p>",
          "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
        ].join(""),
        "utf8"
      ),
      "ppt/slides/_rels/slide1.xml.rels": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>',
          "</Relationships>"
        ].join(""),
        "utf8"
      ),
      "ppt/notesSlides/notesSlide1.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
          '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
          "<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Notes should be searchable too.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>",
          "</p:notes>"
        ].join(""),
        "utf8"
      )
    })
  );
}

function createSimpleEpub(): Buffer {
  return Buffer.from(
    zipSync({
      mimetype: Buffer.from("application/epub+zip", "utf8"),
      "META-INF/container.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>',
          "</container>"
        ].join(""),
        "utf8"
      ),
      "OEBPS/nav.xhtml": Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav><h1>Table of Contents</h1></nav></body></html>',
        "utf8"
      ),
      "OEBPS/content.opf": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">',
          '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Tiny EPUB</dc:title><dc:creator>SwarmVault Tests</dc:creator></metadata>',
          "<manifest>",
          '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
          '<item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>',
          '<item id="chapter-2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>',
          "</manifest>",
          '<spine><itemref idref="chapter-1"/><itemref idref="chapter-2"/></spine>',
          "</package>"
        ].join(""),
        "utf8"
      ),
      "OEBPS/chapter-1.xhtml": Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>First Chapter</h1><p>Books should split into chapter sources.</p></body></html>',
        "utf8"
      ),
      "OEBPS/chapter-2.xhtml": Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Second Chapter</h1><p>Later chapters stay searchable too.</p></body></html>',
        "utf8"
      )
    })
  );
}

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-tiny-"));
  tempDirs.push(dir);
  return dir;
}

async function readManifests(rootDir: string): Promise<SourceManifest[]> {
  const manifestsDir = path.join(rootDir, "state", "manifests");
  const names = await fs.readdir(manifestsDir);
  return await Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(manifestsDir, name), "utf8")) as SourceManifest)
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("tiny validation matrix", () => {
  it("covers every shipped code language and local source kind with repo ingest", async () => {
    const rootDir = await createTempWorkspace();
    const repoDir = path.join(rootDir, "repo");
    await fs.cp(tinyFixtureDir, repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "docs", "brief.docx"), MINIMAL_DOCX);
    await fs.writeFile(path.join(repoDir, "docs", "dataset.csv"), ["Metric,Value", "Users,12", "Errors,1"].join("\n"), "utf8");
    await fs.writeFile(path.join(repoDir, "docs", "dataset.tsv"), ["Week\tSignups", "Week 1\t4", "Week 2\t8"].join("\n"), "utf8");
    await fs.writeFile(path.join(repoDir, "docs", "deck.pptx"), createSimplePptx());
    await fs.writeFile(path.join(repoDir, "docs", "workbook.xlsx"), await createSimpleXlsx());
    await fs.writeFile(path.join(repoDir, "docs", "book.epub"), createSimpleEpub());

    await initVault(rootDir);
    await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifests = await readManifests(rootDir);
    const codeLanguages = new Set(manifests.filter((manifest) => manifest.sourceKind === "code").map((manifest) => manifest.language));
    const sourceKinds = new Set(manifests.map((manifest) => manifest.sourceKind));

    const expectedLanguages: CodeLanguage[] = [
      "javascript",
      "jsx",
      "typescript",
      "tsx",
      "python",
      "go",
      "rust",
      "java",
      "kotlin",
      "scala",
      "lua",
      "zig",
      "csharp",
      "c",
      "cpp",
      "php",
      "ruby",
      "powershell"
    ];
    const expectedSourceKinds: SourceKind[] = ["markdown", "text", "html", "pdf", "docx", "epub", "csv", "xlsx", "pptx", "image", "code"];

    for (const language of expectedLanguages) {
      expect(codeLanguages.has(language), `missing language ${language}`).toBe(true);
    }
    for (const sourceKind of expectedSourceKinds) {
      expect(sourceKinds.has(sourceKind), `missing source kind ${sourceKind}`).toBe(true);
    }

    const htmlManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/page.html");
    expect(htmlManifest?.sourceKind).toBe("html");
    expect(htmlManifest?.extractedTextPath).toBeTruthy();
    expect(htmlManifest?.extractedMetadataPath).toBeTruthy();
    const htmlExtract = await fs.readFile(path.join(rootDir, htmlManifest?.extractedTextPath ?? ""), "utf8");
    expect(htmlExtract).toContain("Local HTML files should extract readable text before analysis.");
    const htmlArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, htmlManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(htmlArtifact.extractor).toBe("html_readability");

    const pdfManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/paper.pdf");
    const pdfArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, pdfManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(pdfArtifact.extractor).toBe("pdf_text");
    expect(pdfArtifact.pageCount).toBe(1);

    const docxManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/brief.docx");
    expect(docxManifest?.sourceKind).toBe("docx");
    const docxArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, docxManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(docxArtifact.extractor).toBe("docx_text");
    expect(docxArtifact.metadata?.title).toBe("Tiny DOCX Source");
    const docxExtract = await fs.readFile(path.join(rootDir, docxManifest?.extractedTextPath ?? ""), "utf8");
    expect(docxExtract).toContain("Local DOCX files should extract readable text before analysis.");

    const csvManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/dataset.csv");
    expect(csvManifest?.sourceKind).toBe("csv");
    const csvArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, csvManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(csvArtifact.extractor).toBe("csv_text");
    expect(csvArtifact.metadata?.format).toBe("csv");

    const tsvManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/dataset.tsv");
    expect(tsvManifest?.sourceKind).toBe("csv");
    const tsvExtract = await fs.readFile(path.join(rootDir, tsvManifest?.extractedTextPath ?? ""), "utf8");
    expect(tsvExtract).toContain("Format: TSV");

    const xlsxManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/workbook.xlsx");
    expect(xlsxManifest?.sourceKind).toBe("xlsx");
    const xlsxArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, xlsxManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(xlsxArtifact.extractor).toBe("xlsx_text");
    expect(xlsxArtifact.metadata?.sheet_count).toBe("1");
    const xlsxExtract = await fs.readFile(path.join(rootDir, xlsxManifest?.extractedTextPath ?? ""), "utf8");
    expect(xlsxExtract).toContain("## Sheet: Overview");

    const pptxManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/deck.pptx");
    expect(pptxManifest?.sourceKind).toBe("pptx");
    const pptxArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, pptxManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(pptxArtifact.extractor).toBe("pptx_text");
    expect(pptxArtifact.metadata?.slide_count).toBe("1");

    const epubManifests = manifests.filter((manifest) => manifest.originalPath?.endsWith("docs/book.epub"));
    expect(epubManifests).toHaveLength(2);
    expect(epubManifests.every((manifest) => manifest.sourceKind === "epub")).toBe(true);
    expect(epubManifests.every((manifest) => manifest.sourceGroupTitle === "Tiny EPUB")).toBe(true);
    const epubExtract = await fs.readFile(path.join(rootDir, epubManifests[0]?.extractedTextPath ?? ""), "utf8");
    expect(epubExtract).toContain("Books should split into chapter sources.");

    const imageManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/diagram.svg");
    const imageArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, imageManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(imageArtifact.extractor).toBe("image_vision");

    const rstManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/guide.rst");
    expect(rstManifest?.sourceKind).toBe("text");
    expect(rstManifest?.mimeType).toBe("text/x-rst");
    const rstExtract = await fs.readFile(path.join(rootDir, rstManifest?.extractedTextPath ?? ""), "utf8");
    expect(rstExtract).toContain("# Tiny reStructuredText Source");
    expect(rstExtract).toContain("Note: The extracted text should normalize headings and directives.");

    const codeIndexPath = path.join(rootDir, "state", "code-index.json");
    const codeIndex = JSON.parse(await fs.readFile(codeIndexPath, "utf8")) as { entries: Array<{ language: CodeLanguage }> };
    const indexedLanguages = new Set(codeIndex.entries.map((entry) => entry.language));
    for (const language of expectedLanguages) {
      expect(indexedLanguages.has(language), `missing indexed language ${language}`).toBe(true);
    }

    const tsxManifest = manifests.find((manifest) => manifest.repoRelativePath === "tsx/Widget.tsx");
    const tsxModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${tsxManifest?.sourceId}.md`), "utf8");
    expect(tsxModulePage).toContain("Language: `tsx`");

    const zigManifest = manifests.find((manifest) => manifest.repoRelativePath === "zig/Widget.zig");
    const zigModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${zigManifest?.sourceId}.md`), "utf8");
    expect(zigModulePage).toContain("Language: `zig`");

    const luaManifest = manifests.find((manifest) => manifest.repoRelativePath === "lua/widget.lua");
    const luaModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${luaManifest?.sourceId}.md`), "utf8");
    expect(luaModulePage).toContain("Language: `lua`");

    const results = await searchVault(rootDir, "Tiny HTML Source", 10);
    expect(results.some((result) => result.path.startsWith("sources/"))).toBe(true);
  });
});
