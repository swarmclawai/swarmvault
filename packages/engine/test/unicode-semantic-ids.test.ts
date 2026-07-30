import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { analysisSignature } from "../src/analysis.js";
import { ANALYSIS_FORMAT_VERSION } from "../src/analysis-format.js";
import { acceptApproval, compileVault, ingestInput, initVault, readApproval, rejectApproval, searchVault } from "../src/index.js";
import type { CompileState, GraphArtifact, SourceAnalysis } from "../src/types.js";
import { semanticSlug } from "../src/utils.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-unicode-ids-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Unicode semantic ids", () => {
  it("migrates v8 caches without re-analysis and uses canonical ids throughout generated artifacts", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "journey.md"),
      "# Journey\n\nA durable source used to exercise semantic identity migration.",
      "utf8"
    );
    await ingestInput(rootDir, "journey.md");
    await compileVault(rootDir);
    await compileVault(rootDir);
    await compileVault(rootDir);

    const analysesDir = path.join(rootDir, "state", "analyses");
    const analysisFiles = (await fs.readdir(analysesDir)).filter((file) => file.endsWith(".json"));
    expect(analysisFiles).toHaveLength(1);
    const analysisPath = path.join(analysesDir, analysisFiles[0] as string);
    const current = JSON.parse(await fs.readFile(analysisPath, "utf8")) as SourceAnalysis;
    const legacyProducedAt = "2026-01-01T00:00:00.000Z";
    const legacy: SourceAnalysis = {
      ...current,
      analysisVersion: 8,
      concepts: [
        { id: "concept:item", name: "毫毛分身术", description: "由毫毛变化出的分身。" },
        { id: "concept:item", name: "筋斗云", description: "快速远行的神通。" },
        { id: "concept:item", name: "毫毛分身术", description: "由毫毛变化出的分身。" },
        { id: "concept:c", name: "C++", description: "A programming language." },
        { id: "concept:c", name: "C#", description: "Another programming language." }
      ],
      entities: [
        { id: "entity:item", name: "孙悟空", description: "故事中的主要人物。" },
        { id: "entity:item", name: "猪八戒", description: "故事中的同行者。" }
      ],
      producedAt: legacyProducedAt
    };
    await fs.writeFile(analysisPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const compileStatePath = path.join(rootDir, "state", "compile-state.json");
    const compileState = JSON.parse(await fs.readFile(compileStatePath, "utf8")) as CompileState;
    compileState.analyses[legacy.sourceId] = analysisSignature(legacy);
    compileState.candidateHistory["concept:item"] = {
      sourceIds: [legacy.sourceId],
      status: "active"
    };
    await fs.writeFile(compileStatePath, `${JSON.stringify(compileState, null, 2)}\n`, "utf8");

    const graphPath = path.join(rootDir, "state", "graph.json");
    const previousGraph = JSON.parse(await fs.readFile(graphPath, "utf8")) as GraphArtifact;
    const existingConceptPage = previousGraph.pages.find((page) => page.kind === "concept");
    const existingConceptNode = previousGraph.nodes.find((node) => node.type === "concept");
    if (!existingConceptPage || !existingConceptNode) {
      throw new Error("Expected the baseline compile to create a concept page and node.");
    }
    previousGraph.pages.push({
      ...existingConceptPage,
      id: "concept:item",
      path: "concepts/item.md",
      title: "Legacy merged concept",
      nodeIds: ["concept:item"]
    });
    previousGraph.pages.push({
      ...existingConceptPage,
      id: "entity:item",
      path: "entities/item.md",
      title: "Legacy merged entity",
      kind: "entity",
      nodeIds: ["entity:item"]
    });
    previousGraph.nodes.push({
      ...existingConceptNode,
      id: "concept:item",
      label: "Legacy merged concept",
      pageId: "concept:item"
    });
    previousGraph.nodes.push({
      ...existingConceptNode,
      id: "entity:item",
      type: "entity",
      label: "Legacy merged entity",
      pageId: "entity:item"
    });
    await fs.writeFile(graphPath, `${JSON.stringify(previousGraph, null, 2)}\n`, "utf8");
    const legacyConceptContent = [
      "---",
      "# Preserve this YAML comment byte-for-byte.",
      "page_id: concept:item",
      "kind: concept",
      "managed_by: system",
      "---",
      "# Legacy merged concept",
      "",
      "<!-- swarmvault-guided-source:legacy-review:start -->",
      "A user-authored note that cannot be assigned safely to one split concept.",
      "<!-- swarmvault-guided-source:legacy-review:end -->",
      ""
    ].join("\n");
    await fs.writeFile(path.join(rootDir, "wiki", "concepts", "item.md"), legacyConceptContent, "utf8");
    await fs.writeFile(
      path.join(rootDir, "wiki", "entities", "item.md"),
      "---\npage_id: entity:item\nkind: entity\nmanaged_by: system\n---\n# Legacy merged entity\n",
      "utf8"
    );

    await compileVault(rootDir);

    const migrated = JSON.parse(await fs.readFile(analysisPath, "utf8")) as SourceAnalysis;
    const conceptIds = migrated.concepts.map((term) => term.id);
    const entityIds = migrated.entities.map((term) => term.id);
    const cloneId = `concept:${semanticSlug("毫毛分身术")}`;
    const cloudId = `concept:${semanticSlug("筋斗云")}`;
    expect(migrated.analysisVersion).toBe(ANALYSIS_FORMAT_VERSION);
    expect(migrated.producedAt).toBe(legacyProducedAt);
    expect(conceptIds).toEqual([cloneId, cloudId, "concept:c", "concept:c"]);
    expect(migrated.concepts.map((term) => term.name)).toEqual(["毫毛分身术", "筋斗云", "C++", "C#"]);
    expect(new Set([...conceptIds, ...entityIds]).size).toBe(5);
    expect([...conceptIds, ...entityIds]).not.toContain("concept:item");
    expect([...conceptIds, ...entityIds]).not.toContain("entity:item");

    const graph = JSON.parse(await fs.readFile(graphPath, "utf8")) as GraphArtifact;
    const cloneNode = graph.nodes.find((node) => node.id === cloneId);
    const clonePage = graph.pages.find((page) => page.id === cloneId);
    expect(cloneNode?.pageId).toBe(cloneId);
    expect(cloneNode?.label).toBe("毫毛分身术");
    expect(clonePage?.id).toBe(cloneId);
    expect(clonePage?.status).toBe("candidate");
    expect(clonePage?.path).toMatch(new RegExp(`/${semanticSlug("毫毛分身术")}\\.md$`));
    expect(graph.nodes.some((node) => node.id === "concept:item" || node.id === "entity:item")).toBe(false);
    expect(graph.pages.some((page) => page.id === "concept:item" || page.id === "entity:item")).toBe(false);
    await expect(fs.access(path.join(rootDir, "wiki", "concepts", "item.md"))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "wiki", "entities", "item.md"))).rejects.toThrow();
    const archivedConceptFiles = await fs.readdir(path.join(rootDir, "wiki", "archive", "guided-pages", "concepts"));
    expect(archivedConceptFiles).toHaveLength(1);
    const archivedConceptContent = await fs.readFile(
      path.join(rootDir, "wiki", "archive", "guided-pages", "concepts", archivedConceptFiles[0] as string),
      "utf8"
    );
    expect(archivedConceptContent).toBe(legacyConceptContent);

    const sourcePage = graph.pages.find((page) => page.id === `source:${legacy.sourceId}`);
    if (!sourcePage || !clonePage) {
      throw new Error("Expected canonical source and concept pages.");
    }
    const sourceContent = await fs.readFile(path.join(rootDir, "wiki", sourcePage.path), "utf8");
    const sourceFrontmatter = matter(sourceContent).data;
    expect(sourceFrontmatter.node_ids).toContain(cloneId);
    expect(sourceFrontmatter.backlinks).toContain(cloneId);
    expect(sourceContent).toContain(`[[${clonePage.path.replace(/\.md$/, "")}|毫毛分身术]]`);
    await expect(fs.access(path.join(rootDir, "wiki", clonePage.path))).resolves.toBeUndefined();

    const conceptContent = await fs.readFile(path.join(rootDir, "wiki", clonePage.path), "utf8");
    const conceptFrontmatter = matter(conceptContent).data;
    expect(conceptFrontmatter.page_id).toBe(cloneId);
    expect(conceptFrontmatter.source_ids).toEqual([legacy.sourceId]);
    expect(conceptFrontmatter.backlinks).toEqual([`source:${legacy.sourceId}`]);
    expect(conceptContent.split(`[[sources/${legacy.sourceId}|`).length - 1).toBe(1);
    expect(conceptContent).not.toContain("A user-authored note that cannot be assigned safely to one split concept.");

    const results = await searchVault(rootDir, "毫毛分身术", 5);
    expect(results.some((result) => result.pageId === cloneId)).toBe(true);
    await compileVault(rootDir);
    expect(
      await fs.readFile(path.join(rootDir, "wiki", "archive", "guided-pages", "concepts", archivedConceptFiles[0] as string), "utf8")
    ).toBe(archivedConceptContent);
  });

  it("defers invalid non-code caches during code-only compilation", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "note.md"), "# Note\n\nSemantic content that requires full analysis.", "utf8");
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    const analysesDir = path.join(rootDir, "state", "analyses");
    const analysisFile = (await fs.readdir(analysesDir)).find((file) => file.endsWith(".json"));
    if (!analysisFile) {
      throw new Error("Expected an analysis cache.");
    }
    const analysisPath = path.join(analysesDir, analysisFile);
    const cached = JSON.parse(await fs.readFile(analysisPath, "utf8")) as SourceAnalysis;
    const deferred: SourceAnalysis = {
      ...cached,
      analysisVersion: 7,
      producedAt: "2026-01-02T00:00:00.000Z"
    };
    await fs.writeFile(analysisPath, `${JSON.stringify(deferred, null, 2)}\n`, "utf8");

    await compileVault(rootDir, { codeOnly: true });
    const afterCodeOnly = JSON.parse(await fs.readFile(analysisPath, "utf8")) as SourceAnalysis;
    expect(afterCodeOnly.analysisVersion).toBe(7);
    expect(afterCodeOnly.producedAt).toBe(deferred.producedAt);

    await compileVault(rootDir);
    const afterFullCompile = JSON.parse(await fs.readFile(analysisPath, "utf8")) as SourceAnalysis;
    expect(afterFullCompile.analysisVersion).toBe(ANALYSIS_FORMAT_VERSION);
    expect(afterFullCompile.producedAt).not.toBe(deferred.producedAt);
  });

  it("keeps guided-page archive and deletion atomic in compile approvals", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "approval.md"), "# Approval\n\nA durable concept for approval testing.", "utf8");
    await ingestInput(rootDir, "approval.md");
    await compileVault(rootDir);

    const graphPath = path.join(rootDir, "state", "graph.json");
    const addObsoleteGuidedPage = async (suffix: string) => {
      const graph = JSON.parse(await fs.readFile(graphPath, "utf8")) as GraphArtifact;
      const template = graph.pages.find((page) => page.kind === "concept");
      if (!template) {
        throw new Error("Expected a concept page for the approval fixture.");
      }
      const pageId = `concept:legacy-${suffix}`;
      const relativePath = `concepts/legacy-${suffix}.md`;
      graph.pages.push({
        ...template,
        id: pageId,
        path: relativePath,
        title: `Legacy ${suffix}`,
        nodeIds: [pageId]
      });
      await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
      const content = [
        "---",
        `page_id: ${pageId}`,
        "kind: concept",
        "managed_by: system",
        "---",
        `# Legacy ${suffix}`,
        "",
        `<!-- swarmvault-guided-source:${suffix}:start -->`,
        `Keep ${suffix} notes.`,
        `<!-- swarmvault-guided-source:${suffix}:end -->`,
        ""
      ].join("\n");
      await fs.writeFile(path.join(rootDir, "wiki", relativePath), content, "utf8");
      return { pageId, relativePath, content };
    };

    const acceptedFixture = await addObsoleteGuidedPage("accept");
    const staged = await compileVault(rootDir, { approve: true });
    const detail = await readApproval(rootDir, staged.approvalId as string);
    const archiveEntry = detail.entries.find((entry) => entry.previousPath === acceptedFixture.relativePath);
    expect(archiveEntry?.changeType).toBe("archive");
    expect(archiveEntry?.nextPath).toMatch(/^archive\/guided-pages\/concepts\/legacy-accept-[a-f0-9]{12}\.md$/);
    await expect(fs.access(path.join(rootDir, "wiki", acceptedFixture.relativePath))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "wiki", archiveEntry?.nextPath as string))).rejects.toThrow();
    expect(await fs.readFile(path.join(staged.approvalDir as string, "wiki", archiveEntry?.nextPath as string), "utf8")).toBe(
      acceptedFixture.content
    );

    const accepted = await acceptApproval(rootDir, staged.approvalId as string, [acceptedFixture.relativePath]);
    expect(accepted.updatedEntries).toEqual([acceptedFixture.pageId]);
    await expect(fs.access(path.join(rootDir, "wiki", acceptedFixture.relativePath))).rejects.toThrow();
    expect(await fs.readFile(path.join(rootDir, "wiki", archiveEntry?.nextPath as string), "utf8")).toBe(acceptedFixture.content);

    const rejectedFixture = await addObsoleteGuidedPage("reject");
    const stagedAgain = await compileVault(rootDir, { approve: true });
    const detailAgain = await readApproval(rootDir, stagedAgain.approvalId as string);
    const rejectedArchiveEntry = detailAgain.entries.find((entry) => entry.previousPath === rejectedFixture.relativePath);
    expect(rejectedArchiveEntry?.changeType).toBe("archive");
    await rejectApproval(rootDir, stagedAgain.approvalId as string, [rejectedArchiveEntry?.nextPath as string]);
    await expect(fs.access(path.join(rootDir, "wiki", rejectedFixture.relativePath))).resolves.toBeUndefined();
    await expect(fs.access(path.join(rootDir, "wiki", rejectedArchiveEntry?.nextPath as string))).rejects.toThrow();
  });
});
