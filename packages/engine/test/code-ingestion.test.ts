import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileVault, ingestInput, initVault, searchVault } from "../src/index.js";
import type { GraphArtifact, SourceAnalysis } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-code-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("code-aware ingestion", () => {
  it("builds module pages plus code graph nodes and edges for TS sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "src", "util.ts"),
      [
        "export interface Renderable {",
        "  render(): string;",
        "}",
        "",
        "export function formatLabel(name: string): string {",
        `  return \`Widget:\${name}\`;`,
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "src", "widget.ts"),
      [
        "import { formatLabel, Renderable } from './util';",
        "",
        "function buildLabel(name: string): string {",
        "  return formatLabel(name);",
        "}",
        "",
        "export class Widget implements Renderable {",
        "  constructor(private readonly name: string) {}",
        "",
        "  render(): string {",
        "    return buildLabel(this.name);",
        "  }",
        "}",
        "",
        "export function renderWidget(name: string): string {",
        "  return buildLabel(name);",
        "}"
      ].join("\n"),
      "utf8"
    );

    const utilManifest = await ingestInput(rootDir, "src/util.ts");
    const widgetManifest = await ingestInput(rootDir, "src/widget.ts");
    expect(utilManifest.sourceKind).toBe("code");
    expect(utilManifest.language).toBe("typescript");
    expect(widgetManifest.sourceKind).toBe("code");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.id === `module:${widgetManifest.sourceId}`)).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "renderWidget")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "defines")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "exports")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "calls")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "implements")).toBe(true);

    const modulePagePath = path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`);
    const modulePage = await fs.readFile(modulePagePath, "utf8");
    expect(modulePage).toContain("## Imports");
    expect(modulePage).toContain("formatLabel");
    expect(modulePage).toContain(`code/${utilManifest.sourceId}`);

    const searchResults = await searchVault(rootDir, "renderWidget", 10);
    expect(searchResults.some((result) => result.path === `code/${widgetManifest.sourceId}.md`)).toBe(true);
  });

  it("records parser diagnostics on broken code sources without failing compile", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "broken.ts"), "export const = 1;\n", "utf8");
    const manifest = await ingestInput(rootDir, "broken.ts");

    await expect(compileVault(rootDir)).resolves.toBeTruthy();

    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.code?.diagnostics.length ?? 0).toBeGreaterThan(0);

    const modulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${manifest.sourceId}.md`), "utf8");
    expect(modulePage).toContain("## Diagnostics");
    expect(modulePage).toContain("TS");
  });
});
