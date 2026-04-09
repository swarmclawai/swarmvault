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

function createSimpleOdt(): Buffer {
  return Buffer.from(
    zipSync({
      // ODF requires the mimetype file to be the first (stored/uncompressed)
      // entry; fflate handles this as long as it's emitted first.
      mimetype: Buffer.from("application/vnd.oasis.opendocument.text", "utf8"),
      "META-INF/manifest.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">',
          '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>',
          '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
          "</manifest:manifest>"
        ].join(""),
        "utf8"
      ),
      "meta.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0">',
          "<office:meta>",
          "<dc:title>Tiny ODT Source</dc:title>",
          "<dc:creator>SwarmVault Tests</dc:creator>",
          "<dc:subject>odt fixture</dc:subject>",
          "<meta:keyword>odt</meta:keyword>",
          "</office:meta>",
          "</office:document-meta>"
        ].join(""),
        "utf8"
      ),
      "content.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">',
          "<office:body><office:text>",
          '<text:h text:outline-level="1">Tiny ODT Source</text:h>',
          "<text:p>Local ODT files should extract readable text before analysis.</text:p>",
          "<text:p>They should also preserve basic metadata.</text:p>",
          "</office:text></office:body>",
          "</office:document-content>"
        ].join(""),
        "utf8"
      )
    })
  );
}

function createSimpleOdp(): Buffer {
  return Buffer.from(
    zipSync({
      mimetype: Buffer.from("application/vnd.oasis.opendocument.presentation", "utf8"),
      "META-INF/manifest.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">',
          '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>',
          '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
          '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
          "</manifest:manifest>"
        ].join(""),
        "utf8"
      ),
      "meta.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
          "<office:meta>",
          "<dc:title>Tiny ODP Source</dc:title>",
          "</office:meta>",
          "</office:document-meta>"
        ].join(""),
        "utf8"
      ),
      "content.xml": Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">',
          "<office:body><office:presentation>",
          '<draw:page draw:name="Slide 1"><text:p>ODP slides should be extracted too.</text:p></draw:page>',
          '<draw:page draw:name="Slide 2"><text:p>Speaker notes and shapes should surface as text.</text:p></draw:page>',
          "</office:presentation></office:body>",
          "</office:document-content>"
        ].join(""),
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

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function readManifests(rootDir: string): Promise<SourceManifest[]> {
  const manifestsDir = path.join(rootDir, "state", "manifests");
  const names = await fs.readdir(manifestsDir);
  return await Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(manifestsDir, name), "utf8")) as SourceManifest)
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await removeDirWithRetry(dir)));
});

describe("tiny validation matrix", () => {
  it("covers every shipped code language with repo ingest", async () => {
    const rootDir = await createTempWorkspace();
    const repoDir = path.join(rootDir, "repo");
    await fs.cp(tinyFixtureDir, repoDir, { recursive: true });

    await initVault(rootDir);
    await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifests = await readManifests(rootDir);
    const codeLanguages = new Set(manifests.filter((manifest) => manifest.sourceKind === "code").map((manifest) => manifest.language));

    const expectedLanguages: CodeLanguage[] = [
      "javascript",
      "jsx",
      "typescript",
      "tsx",
      "bash",
      "python",
      "go",
      "rust",
      "java",
      "kotlin",
      "scala",
      "dart",
      "lua",
      "zig",
      "csharp",
      "c",
      "cpp",
      "php",
      "ruby",
      "powershell"
    ];

    for (const language of expectedLanguages) {
      expect(codeLanguages.has(language), `missing language ${language}`).toBe(true);
    }

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

    const bashManifest = manifests.find((manifest) => manifest.repoRelativePath === "bash/widget.sh");
    const bashModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${bashManifest?.sourceId}.md`), "utf8");
    expect(bashModulePage).toContain("Language: `bash`");

    const dartManifest = manifests.find((manifest) => manifest.repoRelativePath === "dart/lib/widget.dart");
    const dartModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${dartManifest?.sourceId}.md`), "utf8");
    expect(dartModulePage).toContain("Language: `dart`");

    const luaManifest = manifests.find((manifest) => manifest.repoRelativePath === "lua/widget.lua");
    const luaModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${luaManifest?.sourceId}.md`), "utf8");
    expect(luaModulePage).toContain("Language: `lua`");

    const results = await searchVault(rootDir, "Tiny HTML Source", 10);
    expect(results.some((result) => result.path.startsWith("sources/"))).toBe(true);
  }, 30_000);

  it("covers every shipped local source kind with repo ingest", async () => {
    const rootDir = await createTempWorkspace();
    const repoDir = path.join(rootDir, "repo");
    await fs.cp(tinyFixtureDir, repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, "docs", "brief.docx"), MINIMAL_DOCX);
    await fs.writeFile(path.join(repoDir, "docs", "dataset.csv"), ["Metric,Value", "Users,12", "Errors,1"].join("\n"), "utf8");
    await fs.writeFile(path.join(repoDir, "docs", "dataset.tsv"), ["Week\tSignups", "Week 1\t4", "Week 2\t8"].join("\n"), "utf8");
    await fs.writeFile(path.join(repoDir, "docs", "deck.pptx"), createSimplePptx());
    await fs.writeFile(path.join(repoDir, "docs", "workbook.xlsx"), await createSimpleXlsx());
    await fs.writeFile(path.join(repoDir, "docs", "book.epub"), createSimpleEpub());

    // Jupyter notebook fixture (pure JSON).
    await fs.writeFile(
      path.join(repoDir, "docs", "notebook.ipynb"),
      JSON.stringify(
        {
          cells: [
            {
              cell_type: "markdown",
              source: ["# Tiny Notebook\n", "\n", "This notebook documents the analysis pipeline."]
            },
            {
              cell_type: "code",
              source: ["def add(x, y):\n", "    return x + y\n"],
              outputs: [{ output_type: "stream", text: "Computed sum\n" }]
            }
          ],
          metadata: {
            kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
            language_info: { name: "python", version: "3.11.0" }
          },
          nbformat: 4,
          nbformat_minor: 5
        },
        null,
        2
      ),
      "utf8"
    );

    // MDX fixture: gets classified as markdown.
    await fs.writeFile(
      path.join(repoDir, "docs", "component-notes.mdx"),
      ["# MDX Component Notes", "", "import { Callout } from '@site/src/components';", "", "Documentation explaining the pipeline."].join(
        "\n"
      ),
      "utf8"
    );

    // Structured-data fixtures: JSON, YAML, TOML should all land as `data`.
    await fs.writeFile(
      path.join(repoDir, "docs", "settings.json"),
      JSON.stringify({ name: "platform", services: ["edge", "api"], limits: { burst: 100 } }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "rollout.yaml"),
      ["name: rollout", "stages:", "  - name: staging", "  - name: production"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "config.toml"),
      ['title = "Platform"', "", "[limits]", "burst = 100", "sustained = 20"].join("\n"),
      "utf8"
    );

    // ODS fixture reused from the XLSX helper — xlsx npm lib writes ODS too.
    const XLSX = await import("xlsx");
    const odsWorkbook = XLSX.utils.book_new();
    const odsSheet = XLSX.utils.aoa_to_sheet([
      ["Metric", "Value"],
      ["Users", 12],
      ["Errors", 1]
    ]);
    XLSX.utils.book_append_sheet(odsWorkbook, odsSheet, "Overview");
    await fs.writeFile(
      path.join(repoDir, "docs", "workbook.ods"),
      Buffer.from(XLSX.write(odsWorkbook, { type: "buffer", bookType: "ods" }))
    );

    // Hand-built minimal ODT and ODP fixtures (ZIP + content.xml + meta.xml).
    await fs.writeFile(path.join(repoDir, "docs", "brief.odt"), createSimpleOdt());
    await fs.writeFile(path.join(repoDir, "docs", "deck.odp"), createSimpleOdp());

    // BibTeX, RTF, Org, and AsciiDoc fixtures — all parsed by proper libs.
    await fs.writeFile(
      path.join(repoDir, "docs", "refs.bib"),
      [
        "@article{karpathy2015char-rnn,",
        "  title = {The Unreasonable Effectiveness of Recurrent Neural Networks},",
        "  author = {Karpathy, Andrej},",
        "  year = {2015},",
        "  journal = {Blog},",
        "  url = {https://karpathy.github.io/2015/05/21/rnn-effectiveness/}",
        "}",
        "",
        "@book{knuth1997art,",
        "  title = {The Art of Computer Programming},",
        "  author = {Knuth, Donald E.},",
        "  year = {1997},",
        "  publisher = {Addison-Wesley}",
        "}"
      ].join("\n"),
      "utf8"
    );

    // Minimal hand-authored RTF document.
    await fs.writeFile(
      path.join(repoDir, "docs", "legal.rtf"),
      [
        "{\\rtf1\\ansi\\deff0",
        "{\\fonttbl{\\f0 Helvetica;}}",
        "\\f0\\fs24",
        "Tiny RTF Source\\par",
        "Local RTF files should extract readable text before analysis.\\par",
        "They should also preserve paragraph structure.\\par",
        "}"
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      path.join(repoDir, "docs", "notes.org"),
      [
        "#+TITLE: Tiny Org Source",
        "",
        "* Introduction",
        "",
        "Local Org files should extract readable text via the orga parser.",
        "",
        "* TODO Roll out rate limiter",
        "",
        "Deploy the new rate limiter to staging, then production.",
        "",
        "** DONE Canary validation",
        "",
        "- Verified p99 latency stays below target",
        "- No regression in error rate"
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      path.join(repoDir, "docs", "spec.adoc"),
      [
        "= Tiny AsciiDoc Source",
        "SwarmVault Tests <tests@example.com>",
        "",
        "== Introduction",
        "",
        "Local AsciiDoc files should extract readable text via the Asciidoctor parser.",
        "",
        "== Goals",
        "",
        "* Preserve section structure.",
        "* Extract metadata and prose.",
        "* Route through the shared htmlToMarkdown helper so downstream analysis is consistent."
      ].join("\n"),
      "utf8"
    );

    // Modern image extensions — verify explicit routing catches formats the
    // mime-types package may miss. Bytes don't need to be valid image data
    // since we only assert on sourceKind (the vision extractor records a
    // warning on invalid payloads without crashing the ingest pipeline).
    const imageExtFixtures: Array<[string, Buffer]> = [
      ["docs/photo.heic", Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])],
      ["docs/snap.avif", Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])],
      ["docs/scene.jxl", Buffer.from([0xff, 0x0a])],
      ["docs/banner.bmp", Buffer.from([0x42, 0x4d, 0x00, 0x00])],
      ["docs/favicon.ico", Buffer.from([0x00, 0x00, 0x01, 0x00])],
      ["docs/landscape.tiff", Buffer.from([0x49, 0x49, 0x2a, 0x00])]
    ];
    for (const [fixturePath, bytes] of imageExtFixtures) {
      await fs.writeFile(path.join(repoDir, fixturePath), bytes);
    }

    // Office family variants — each variant needs UNIQUE content since the
    // ingest pipeline dedupes by content hash (shared bytes would collapse
    // into a single manifest). The .docm/.dotx/.dotm, .xlsm/.xltx/.xltm,
    // and .pptm/.potx/.potm extensions reuse the OOXML container of their
    // parent formats, so SheetJS/mammoth read them unchanged.
    async function makeUniqueXlsx(label: string, bookType: "xlsx" | "biff8"): Promise<Buffer> {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([
          ["Label", label],
          ["Timestamp", Date.now().toString()],
          ["Index", Math.random().toString()]
        ]),
        label
      );
      workbook.Props = { Title: `Tiny ${label}` };
      return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType }));
    }

    // Word family: DOCX test bytes are base64-decoded above. For macro/template
    // variants we cannot easily generate fresh OOXML bytes without pulling in
    // a DOCX builder, so we take the shared MINIMAL_DOCX and append a small
    // trailing marker outside the ZIP central directory — mammoth still parses
    // the core content and the bytes hash differently per fixture.
    await fs.writeFile(
      path.join(repoDir, "docs", "macro-enabled.docm"),
      Buffer.concat([MINIMAL_DOCX, Buffer.from("\n<!--docm-marker-->", "utf8")])
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "report-template.dotx"),
      Buffer.concat([MINIMAL_DOCX, Buffer.from("\n<!--dotx-marker-->", "utf8")])
    );

    // Excel family: unique workbook per extension.
    await fs.writeFile(path.join(repoDir, "docs", "macro-enabled.xlsm"), await makeUniqueXlsx("xlsm", "xlsx"));
    await fs.writeFile(path.join(repoDir, "docs", "budget-template.xltx"), await makeUniqueXlsx("xltx", "xlsx"));
    // Legacy .xls binary format — SheetJS writes biff8 natively and ingest
    // should route it through the same xlsx kind.
    await fs.writeFile(path.join(repoDir, "docs", "legacy.xls"), await makeUniqueXlsx("xls", "biff8"));

    // PowerPoint family: createSimplePptx() produces the same bytes each call,
    // so append markers to differentiate. The PPTX extractor reads the ZIP
    // contents; trailing bytes don't confuse it.
    await fs.writeFile(
      path.join(repoDir, "docs", "macro-enabled.pptm"),
      Buffer.concat([createSimplePptx(), Buffer.from("\n<!--pptm-marker-->", "utf8")])
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "slide-template.potx"),
      Buffer.concat([createSimplePptx(), Buffer.from("\n<!--potx-marker-->", "utf8")])
    );

    // Config/data expansion: XML, INI, .env, .properties should all promote
    // to the `data` source kind rather than falling through to plain text or
    // binary. Uses real parseable payloads so extraction succeeds.
    await fs.writeFile(
      path.join(repoDir, "docs", "pipeline.xml"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<pipeline>",
        "  <name>ingest</name>",
        "  <stages>",
        "    <stage>fetch</stage>",
        "    <stage>parse</stage>",
        "    <stage>compile</stage>",
        "  </stages>",
        "</pipeline>"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "service.ini"),
      ["[server]", "host=localhost", "port=8080", "", "[logging]", "level=info"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "config.env"),
      ["DATABASE_URL=postgres://localhost/app", "DEBUG=true", "PORT=3000"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "docs", "app.properties"),
      ["app.name=platform", "app.version=1.0", "app.feature.flags=rollout-v2"].join("\n"),
      "utf8"
    );

    await initVault(rootDir);
    await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifests = await readManifests(rootDir);
    const sourceKinds = new Set(manifests.map((manifest) => manifest.sourceKind));
    const expectedSourceKinds: SourceKind[] = [
      "markdown",
      "text",
      "pdf",
      "docx",
      "epub",
      "csv",
      "xlsx",
      "pptx",
      "image",
      "code",
      "jupyter",
      "odt",
      "odp",
      "ods",
      "data",
      "bibtex",
      "rtf",
      "org",
      "asciidoc"
    ];
    // NOTE: `.html` is now routed through the tree-sitter HTML code grammar
    // added in packages/engine/src/code-tree-sitter.ts, so `.html` files land
    // as `code` source kind with `language: html`. The former html-prose
    // extractor path is exercised elsewhere (e.g., HTML URLs via
    // `swarmvault add`), not by the repo-ingest matrix.

    for (const sourceKind of expectedSourceKinds) {
      expect(sourceKinds.has(sourceKind), `missing source kind ${sourceKind}`).toBe(true);
    }

    const htmlManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/page.html");
    expect(htmlManifest?.sourceKind).toBe("code");
    expect(htmlManifest?.language).toBe("html");

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

    // Routing specificity checks for newly-added file-type coverage. The
    // `expectedSourceKinds` set above only proves each kind appears at
    // least once; these assertions prove each specific extension routes
    // correctly (catches regressions where, say, .docm falls through to
    // binary because someone forgot to widen the `.docx` extension check).
    const expectedFileRouting: Array<[string, SourceKind]> = [
      // Modern image extensions.
      ["docs/photo.heic", "image"],
      ["docs/snap.avif", "image"],
      ["docs/scene.jxl", "image"],
      ["docs/banner.bmp", "image"],
      ["docs/favicon.ico", "image"],
      ["docs/landscape.tiff", "image"],
      // Office family variants — same kinds as their parent formats.
      ["docs/macro-enabled.docm", "docx"],
      ["docs/report-template.dotx", "docx"],
      ["docs/macro-enabled.xlsm", "xlsx"],
      ["docs/budget-template.xltx", "xlsx"],
      ["docs/legacy.xls", "xlsx"],
      ["docs/macro-enabled.pptm", "pptx"],
      ["docs/slide-template.potx", "pptx"],
      // Config/data expansion beyond JSON/YAML/TOML.
      ["docs/pipeline.xml", "data"],
      ["docs/service.ini", "data"],
      ["docs/config.env", "data"],
      ["docs/app.properties", "data"]
    ];
    const routingFailures: string[] = [];
    for (const [repoRelativePath, expectedKind] of expectedFileRouting) {
      const routedManifest = manifests.find((manifest) => manifest.repoRelativePath === repoRelativePath);
      if (!routedManifest) {
        routingFailures.push(`missing manifest: ${repoRelativePath}`);
        continue;
      }
      if (routedManifest.sourceKind !== expectedKind) {
        routingFailures.push(`${repoRelativePath}: expected ${expectedKind}, got ${routedManifest.sourceKind}`);
      }
    }
    expect(routingFailures, `routing regressions:\n${routingFailures.join("\n")}`).toEqual([]);
  }, 30_000);
});
