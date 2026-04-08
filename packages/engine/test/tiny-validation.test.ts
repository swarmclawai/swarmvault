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
      "csharp",
      "c",
      "cpp",
      "php",
      "ruby",
      "powershell"
    ];
    const expectedSourceKinds: SourceKind[] = ["markdown", "text", "html", "pdf", "image", "code"];

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

    const imageManifest = manifests.find((manifest) => manifest.repoRelativePath === "docs/diagram.svg");
    const imageArtifact = JSON.parse(
      await fs.readFile(path.join(rootDir, imageManifest?.extractedMetadataPath ?? ""), "utf8")
    ) as SourceExtractionArtifact;
    expect(imageArtifact.extractor).toBe("image_vision");

    const codeIndexPath = path.join(rootDir, "state", "code-index.json");
    const codeIndex = JSON.parse(await fs.readFile(codeIndexPath, "utf8")) as { entries: Array<{ language: CodeLanguage }> };
    const indexedLanguages = new Set(codeIndex.entries.map((entry) => entry.language));
    for (const language of expectedLanguages) {
      expect(indexedLanguages.has(language), `missing indexed language ${language}`).toBe(true);
    }

    const tsxManifest = manifests.find((manifest) => manifest.repoRelativePath === "tsx/Widget.tsx");
    const tsxModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${tsxManifest?.sourceId}.md`), "utf8");
    expect(tsxModulePage).toContain("Language: `tsx`");

    const results = await searchVault(rootDir, "Tiny HTML Source", 10);
    expect(results.some((result) => result.path.startsWith("sources/"))).toBe(true);
  });
});
