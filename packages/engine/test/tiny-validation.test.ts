import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    const expectedSourceKinds: SourceKind[] = ["markdown", "text", "html", "pdf", "docx", "image", "code"];

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
