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
    expect(modulePage).toContain("diagnostic");
  });

  it("builds module pages for Python, Go, Rust, and Java sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "pkg", "util.py"),
      ["def helper(name):", "    return format_name(name)", "", "def format_name(name):", "    return f'Py:{name}'"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "pkg", "app.py"),
      ["from .util import helper", "", "def run(name):", "    return helper(name)"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "widget.go"),
      [
        "package sample",
        "",
        'import "fmt"',
        "",
        "type Widget struct{}",
        "",
        "func formatName(name string) string {",
        '  return fmt.Sprintf("Go:%s", name)',
        "}",
        "",
        "func Run(name string) string {",
        "  return formatName(name)",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "widget.rs"),
      [
        "use crate::fmt::format_name;",
        "",
        "pub struct Widget;",
        "pub trait Renderable {}",
        "impl Renderable for Widget {}",
        "",
        "fn helper(name: &str) -> String {",
        "    format_name(name)",
        "}",
        "",
        "pub fn render(name: &str) -> String {",
        "    helper(name)",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "Widget.java"),
      [
        "import java.util.List;",
        "",
        "class BaseWidget {}",
        "",
        "public class Widget extends BaseWidget implements Runnable, AutoCloseable {",
        "  public void run() {}",
        "  public void close() {}",
        "}",
        "",
        "interface Helper extends Runnable {}"
      ].join("\n"),
      "utf8"
    );

    const pythonUtil = await ingestInput(rootDir, "pkg/util.py");
    const pythonApp = await ingestInput(rootDir, "pkg/app.py");
    const goManifest = await ingestInput(rootDir, "widget.go");
    const rustManifest = await ingestInput(rootDir, "widget.rs");
    const javaManifest = await ingestInput(rootDir, "Widget.java");

    expect(pythonUtil.language).toBe("python");
    expect(pythonApp.language).toBe("python");
    expect(goManifest.language).toBe("go");
    expect(rustManifest.language).toBe("rust");
    expect(javaManifest.language).toBe("java");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "python")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "go")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "rust")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "java")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "calls")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "implements")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "extends")).toBe(true);

    const pythonModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${pythonApp.sourceId}.md`), "utf8");
    const goModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${goManifest.sourceId}.md`), "utf8");
    const rustModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${rustManifest.sourceId}.md`), "utf8");
    const javaModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${javaManifest.sourceId}.md`), "utf8");

    expect(pythonModulePage).toContain("Language: `python`");
    expect(pythonModulePage).toContain(`code/${pythonUtil.sourceId}`);
    expect(goModulePage).toContain("Language: `go`");
    expect(goModulePage).toContain("fmt");
    expect(rustModulePage).toContain("Language: `rust`");
    expect(rustModulePage).toContain("Renderable");
    expect(javaModulePage).toContain("Language: `java`");
    expect(javaModulePage).toContain("BaseWidget");

    const searchResults = await searchVault(rootDir, "Widget", 20);
    expect(searchResults.some((result) => result.path === `code/${javaManifest.sourceId}.md`)).toBe(true);
    expect(searchResults.some((result) => result.path === `code/${goManifest.sourceId}.md`)).toBe(true);
  });
});
