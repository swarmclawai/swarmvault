import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTreeSitterLanguageCacheForTests } from "../src/code-tree-sitter.js";
import { compileVault, ingestDirectory, ingestInput, initVault, searchVault, syncTrackedRepos } from "../src/index.js";
import type { CodeIndexArtifact, GraphArtifact, SourceAnalysis } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-code-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetTreeSitterLanguageCacheForTests();
  vi.restoreAllMocks();
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
    await fs.writeFile(path.join(rootDir, "widget_type.go"), ["package sample", "", "type Widget struct{}"].join("\n"), "utf8");
    await fs.writeFile(
      path.join(rootDir, "widget_methods.go"),
      [
        "package sample",
        "",
        'import "fmt"',
        "",
        "func formatName(name string) string {",
        '  return fmt.Sprintf("Go:%s", name)',
        "}",
        "",
        "func (w Widget) Run(name string) string {",
        "  return formatName(name)",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "widget_entry.go"),
      ["package sample", "", "func Execute(name string) string {", "  widget := Widget{}", "  return widget.Run(name)", "}"].join("\n"),
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
    const goTypeManifest = await ingestInput(rootDir, "widget_type.go");
    const goMethodManifest = await ingestInput(rootDir, "widget_methods.go");
    const goEntryManifest = await ingestInput(rootDir, "widget_entry.go");
    const rustManifest = await ingestInput(rootDir, "widget.rs");
    const javaManifest = await ingestInput(rootDir, "Widget.java");

    expect(pythonUtil.language).toBe("python");
    expect(pythonApp.language).toBe("python");
    expect(goTypeManifest.language).toBe("go");
    expect(goMethodManifest.language).toBe("go");
    expect(goEntryManifest.language).toBe("go");
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

    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const executeNode = graph.nodes.find((node) => node.type === "symbol" && node.label === "Execute");
    const widgetRunNode = graph.nodes.find((node) => node.type === "symbol" && node.label === "Widget.Run");
    const widgetNode = graph.nodes.find((node) => node.type === "symbol" && node.label === "Widget");
    expect(executeNode).toBeTruthy();
    expect(widgetRunNode).toBeTruthy();
    expect(widgetNode).toBeTruthy();
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "calls" && nodeById.get(edge.source)?.label === "Execute" && nodeById.get(edge.target)?.label === "Widget.Run"
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "defines" && nodeById.get(edge.source)?.label === "Widget" && nodeById.get(edge.target)?.label === "Widget.Run"
      )
    ).toBe(true);

    const pythonModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${pythonApp.sourceId}.md`), "utf8");
    const goModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${goMethodManifest.sourceId}.md`), "utf8");
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
    expect(searchResults.some((result) => result.path === `code/${goTypeManifest.sourceId}.md`)).toBe(true);
  });

  it("builds parser-backed module pages for Kotlin and Scala sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "kotlin"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "scala"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "kotlin", "Format.kt"),
      ["package sample.util", "", 'fun formatName(name: String): String = "Kotlin:$name"'].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "kotlin", "Widget.kt"),
      [
        "package sample.app",
        "",
        "import sample.util.formatName",
        "",
        "interface Renderable",
        "",
        "open class BaseWidget",
        "",
        "class Widget(private val name: String) : BaseWidget(), Renderable {",
        "  fun render(): String = formatName(name)",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "scala", "Helpers.scala"),
      ["package sample.scalautil", "", 'def formatName(name: String): String = s"Scala:$name"'].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "scala", "Widget.scala"),
      [
        "package sample.app",
        "",
        "import sample.scalautil.formatName",
        "",
        "trait Renderable",
        "",
        "class BaseWidget",
        "",
        "class Widget(name: String) extends BaseWidget with Renderable {",
        "  def render(): String = formatName(name)",
        "}"
      ].join("\n"),
      "utf8"
    );

    const kotlinFormatManifest = await ingestInput(rootDir, "kotlin/Format.kt");
    const kotlinWidgetManifest = await ingestInput(rootDir, "kotlin/Widget.kt");
    const scalaHelperManifest = await ingestInput(rootDir, "scala/Helpers.scala");
    const scalaWidgetManifest = await ingestInput(rootDir, "scala/Widget.scala");

    expect(kotlinFormatManifest.language).toBe("kotlin");
    expect(kotlinWidgetManifest.language).toBe("kotlin");
    expect(scalaHelperManifest.language).toBe("scala");
    expect(scalaWidgetManifest.language).toBe("scala");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "kotlin")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "scala")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget.render")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "formatName")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "implements" &&
          nodeById.get(edge.source)?.label === "Widget" &&
          nodeById.get(edge.target)?.label === "Renderable"
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "extends" && nodeById.get(edge.source)?.label === "Widget" && nodeById.get(edge.target)?.label === "BaseWidget"
      )
    ).toBe(true);

    const kotlinModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${kotlinWidgetManifest.sourceId}.md`), "utf8");
    const scalaModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${scalaWidgetManifest.sourceId}.md`), "utf8");

    expect(kotlinModulePage).toContain("Language: `kotlin`");
    expect(kotlinModulePage).toContain("Namespace/Package: `sample.app`");
    expect(kotlinModulePage).toContain("## Imports");
    expect(kotlinModulePage).toContain(`code/${kotlinFormatManifest.sourceId}`);

    expect(scalaModulePage).toContain("Language: `scala`");
    expect(scalaModulePage).toContain("Namespace/Package: `sample.app`");
    expect(scalaModulePage).toContain("## Imports");
    expect(scalaModulePage).toContain(`code/${scalaHelperManifest.sourceId}`);

    const searchResults = await searchVault(rootDir, "Widget.render", 20);
    expect(searchResults.some((result) => result.path === `code/${kotlinWidgetManifest.sourceId}.md`)).toBe(true);
    expect(searchResults.some((result) => result.path === `code/${scalaWidgetManifest.sourceId}.md`)).toBe(true);
  });

  it("builds parser-backed module pages for Lua and Zig sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "lua"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "zig"), { recursive: true });

    await fs.writeFile(
      path.join(repoDir, "zig", "Format.zig"),
      ["pub fn formatName(name: []const u8) []const u8 {", "    return name;", "}"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "zig", "Widget.zig"),
      [
        'const helper = @import("Format.zig");',
        "",
        "pub const Renderable = struct {};",
        "pub const BaseWidget = struct {};",
        "",
        "pub const Widget = struct {",
        "    pub fn render(name: []const u8) []const u8 {",
        "        return helper.formatName(name);",
        "    }",
        "};"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "lua", "helper.lua"),
      ["local M = {}", "", "function M.formatName(name)", '  return "Lua:" .. name', "end", "", "return M"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "lua", "widget.lua"),
      ['local helper = require("lua.helper")', "", "function renderWidget(name)", "  return helper.formatName(name)", "end"].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    const luaHelperManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("lua/helper.lua"));
    const luaWidgetManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("lua/widget.lua"));
    const zigFormatManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("zig/Format.zig"));
    const zigWidgetManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("zig/Widget.zig"));

    if (!luaHelperManifest || !luaWidgetManifest || !zigFormatManifest || !zigWidgetManifest) {
      throw new Error("repo-aware ingest did not return the expected Lua and Zig manifests");
    }

    expect(luaHelperManifest.language).toBe("lua");
    expect(luaWidgetManifest.language).toBe("lua");
    expect(zigFormatManifest.language).toBe("zig");
    expect(zigWidgetManifest.language).toBe("zig");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "lua")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "zig")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget.render")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "renderWidget")).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "extends" && nodeById.get(edge.source)?.label === "Widget" && nodeById.get(edge.target)?.label === "BaseWidget"
      )
    ).toBe(false);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "implements" &&
          nodeById.get(edge.source)?.label === "Widget" &&
          nodeById.get(edge.target)?.label === "Renderable"
      )
    ).toBe(false);
    const luaModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${luaWidgetManifest.sourceId}.md`), "utf8");
    const zigModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${zigWidgetManifest.sourceId}.md`), "utf8");

    expect(luaModulePage).toContain("Language: `lua`");
    expect(luaModulePage).toContain("## Imports");
    expect(luaModulePage).toContain(`code/${luaHelperManifest.sourceId}`);
    expect(luaModulePage).toContain("renderWidget");

    expect(zigModulePage).toContain("Language: `zig`");
    expect(zigModulePage).toContain("## Imports");
    expect(zigModulePage).toContain(`code/${zigFormatManifest.sourceId}`);
    expect(zigModulePage).toContain("Widget.render");
    expect(zigModulePage).toContain("formatName");
    expect(zigModulePage).toContain("Renderable");

    const searchResults = await searchVault(rootDir, "renderWidget", 20);
    expect(searchResults.some((result) => result.path === `code/${luaWidgetManifest.sourceId}.md`)).toBe(true);
  });

  it("builds parser-backed module pages for C#, PHP, C, and C++ sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "native"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "native", "widget.cs"),
      [
        "namespace Sample.App;",
        "using System.Text;",
        "",
        "public interface Renderable {}",
        "",
        "public class Widget : BaseWidget, Renderable {",
        "  public void Run() {",
        "    Helper();",
        "  }",
        "}",
        "",
        "public class BaseWidget {}",
        "public static class Helpers {",
        "  public static void Helper() {}",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "native", "widget.php"),
      [
        "<?php",
        "namespace App\\Core;",
        "use Foo\\Bar as Baz;",
        "",
        "trait Renderable {}",
        "",
        "class Widget extends BaseWidget implements Renderable {",
        "  public function run() {",
        "    helper();",
        "  }",
        "}",
        "",
        "class BaseWidget {}",
        "function helper() {}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(rootDir, "native", "util.h"), ["int helper(void);", "struct BaseWidget {};"].join("\n"), "utf8");
    await fs.writeFile(
      path.join(rootDir, "native", "main.c"),
      [
        '#include "util.h"',
        "",
        "struct Widget : BaseWidget { int run(void) { return helper(); } };",
        "int helper(void) { return 1; }"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "native", "main.cpp"),
      ['#include "util.h"', "", "class WidgetCpp : public BaseWidget { int run() { return helper(); } };"].join("\n"),
      "utf8"
    );

    const csharpManifest = await ingestInput(rootDir, "native/widget.cs");
    const phpManifest = await ingestInput(rootDir, "native/widget.php");
    const cHeaderManifest = await ingestInput(rootDir, "native/util.h");
    const cManifest = await ingestInput(rootDir, "native/main.c");
    const cppManifest = await ingestInput(rootDir, "native/main.cpp");

    expect(csharpManifest.language).toBe("csharp");
    expect(phpManifest.language).toBe("php");
    expect(cManifest.language).toBe("c");
    expect(cppManifest.language).toBe("cpp");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "csharp")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "php")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "c")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "cpp")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "extends")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "implements")).toBe(true);

    const csharpModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${csharpManifest.sourceId}.md`), "utf8");
    const phpModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${phpManifest.sourceId}.md`), "utf8");
    const cModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${cManifest.sourceId}.md`), "utf8");
    const cppModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${cppManifest.sourceId}.md`), "utf8");

    expect(csharpModulePage).toContain("Language: `csharp`");
    expect(csharpModulePage).toContain("Namespace/Package: `Sample.App`");
    expect(phpModulePage).toContain("Language: `php`");
    expect(phpModulePage).toContain("Renderable");
    expect(cModulePage).toContain("Language: `c`");
    expect(cModulePage).toContain(`code/${cHeaderManifest.sourceId}`);
    expect(cppModulePage).toContain("Language: `cpp`");

    const searchResults = await searchVault(rootDir, "Widget", 20);
    expect(searchResults.some((result) => result.path === `code/${csharpManifest.sourceId}.md`)).toBe(true);
    expect(searchResults.some((result) => result.path === `code/${phpManifest.sourceId}.md`)).toBe(true);
  });

  it("detects Kotlin and Scala script extensions as code sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.writeFile(path.join(rootDir, "script.kts"), 'println("hello")\n', "utf8");
    await fs.writeFile(path.join(rootDir, "script.sc"), 'println("scala hello")\n', "utf8");

    const kotlinScript = await ingestInput(rootDir, "script.kts");
    const scalaScript = await ingestInput(rootDir, "script.sc");

    expect(kotlinScript.sourceKind).toBe("code");
    expect(kotlinScript.language).toBe("kotlin");
    expect(scalaScript.sourceKind).toBe("code");
    expect(scalaScript.language).toBe("scala");
  });

  it("records a clear diagnostic when a tree-sitter grammar asset is missing without failing unrelated sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "src", "Widget.kt"),
      [
        "package sample.app",
        "",
        "class Widget {",
        "  fun render(): String = formatName()",
        "}",
        "",
        'fun formatName(): String = "ok"'
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(rootDir, "src", "util.py"), "def helper(name):\n    return name.upper()\n", "utf8");

    const kotlinManifest = await ingestInput(rootDir, "src/Widget.kt");
    const pythonManifest = await ingestInput(rootDir, "src/util.py");
    const originalReadFile = fs.readFile.bind(fs);
    resetTreeSitterLanguageCacheForTests();
    vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (String(target).endsWith("tree-sitter-kotlin.wasm")) {
        const error = new Error("missing grammar asset") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return originalReadFile(target as Parameters<typeof fs.readFile>[0], options as Parameters<typeof fs.readFile>[1]);
    });

    await expect(compileVault(rootDir)).resolves.toBeTruthy();

    const kotlinAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${kotlinManifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(
      kotlinAnalysis.code?.diagnostics.some((diagnostic) => diagnostic.message.includes("Missing tree-sitter grammar asset for kotlin"))
    ).toBe(true);

    const pythonPage = await fs.readFile(path.join(rootDir, "wiki", "code", `${pythonManifest.sourceId}.md`), "utf8");
    const kotlinPage = await fs.readFile(path.join(rootDir, "wiki", "code", `${kotlinManifest.sourceId}.md`), "utf8");

    expect(pythonPage).toContain("Language: `python`");
    expect(kotlinPage).toContain("Missing tree-sitter grammar asset for kotlin");
  });

  it("ingests repo directories, writes code-index.json, and updates existing manifests by path", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "repo", ".git"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "repo", ".gitignore"), ["vendor/", "ignored.py"].join("\n"), "utf8");
    await fs.mkdir(path.join(rootDir, "repo", "src"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "vendor"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "repo", "ignored.py"), "def skip():\n    return 'ignored'\n", "utf8");
    await fs.writeFile(path.join(rootDir, "repo", "vendor", "skip.py"), "def skip_vendor():\n    return 'ignored'\n", "utf8");
    await fs.writeFile(path.join(rootDir, "repo", "src", "util.py"), "def helper(name):\n    return name.upper()\n", "utf8");
    await fs.writeFile(
      path.join(rootDir, "repo", "src", "app.py"),
      ["from .util import helper", "", "def run(name):", "    return helper(name)"].join("\n"),
      "utf8"
    );

    const initial = await ingestDirectory(rootDir, "repo");
    expect(initial.imported).toHaveLength(2);
    expect(initial.updated).toHaveLength(0);
    expect(initial.skipped.some((entry) => entry.reason === "gitignore")).toBe(true);
    expect(initial.skipped.some((entry) => entry.reason.startsWith("built_in_ignore"))).toBe(true);

    await compileVault(rootDir);

    const codeIndex = JSON.parse(await fs.readFile(path.join(rootDir, "state", "code-index.json"), "utf8")) as CodeIndexArtifact;
    expect(codeIndex.entries).toHaveLength(2);
    expect(codeIndex.entries.some((entry) => entry.repoRelativePath === "src/app.py")).toBe(true);
    expect(codeIndex.entries.some((entry) => entry.repoRelativePath === "src/util.py")).toBe(true);

    const appManifest = initial.imported.find((manifest) => manifest.originalPath?.endsWith("src/app.py"));
    const utilManifest = initial.imported.find((manifest) => manifest.originalPath?.endsWith("src/util.py"));
    expect(appManifest?.repoRelativePath).toBe("src/app.py");
    expect(utilManifest?.repoRelativePath).toBe("src/util.py");

    const modulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${appManifest?.sourceId}.md`), "utf8");
    expect(modulePage).toContain("Repo Path: `src/app.py`");
    expect(modulePage).toContain(`code/${utilManifest?.sourceId}`);

    await fs.writeFile(path.join(rootDir, "repo", "src", "util.py"), "def helper(name):\n    return f'updated:{name}'\n", "utf8");
    const second = await ingestDirectory(rootDir, "repo");
    expect(second.updated).toHaveLength(1);
    expect(second.updated[0]?.sourceId).toBe(utilManifest?.sourceId);
    expect(second.imported).toHaveLength(0);
  });

  it("builds parser-backed module pages for Ruby and PowerShell sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "repo", ".git"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "ruby"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "pwsh"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "repo", "ruby", "helper.rb"),
      ["module Sample", "  def self.format_name(name)", '    "Ruby:#{name}"', "  end", "end"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "repo", "ruby", "app.rb"),
      [
        'require_relative "./helper"',
        "",
        "module Sample",
        "  class Widget < BaseWidget",
        "    include Renderable",
        "",
        "    def run(name)",
        "      helper(name)",
        "    end",
        "  end",
        "",
        "  def helper(name)",
        "    Sample.format_name(name)",
        "  end",
        "end"
      ].join("\n"),
      "utf8"
    );

    await fs.writeFile(
      path.join(rootDir, "repo", "pwsh", "Helper.psm1"),
      ["function Helper {", "  param([string]$name)", "  return $name.ToUpper()", "}"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "repo", "pwsh", "Widget.ps1"),
      [
        "using module ./Helper.psm1",
        "",
        "class Widget : BaseWidget {",
        "  [string] Run([string]$name) {",
        "    return (Helper $name)",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, "repo");
    const rubyApp = result.imported.find((manifest) => manifest.originalPath?.endsWith("ruby/app.rb"));
    const rubyHelper = result.imported.find((manifest) => manifest.originalPath?.endsWith("ruby/helper.rb"));
    const powershellWidget = result.imported.find((manifest) => manifest.originalPath?.endsWith("pwsh/Widget.ps1"));
    const powershellHelper = result.imported.find((manifest) => manifest.originalPath?.endsWith("pwsh/Helper.psm1"));

    expect(rubyApp?.language).toBe("ruby");
    expect(rubyHelper?.language).toBe("ruby");
    expect(powershellWidget?.language).toBe("powershell");
    expect(powershellHelper?.language).toBe("powershell");

    await compileVault(rootDir);

    const rubyPage = await fs.readFile(path.join(rootDir, "wiki", "code", `${rubyApp?.sourceId}.md`), "utf8");
    const powershellPage = await fs.readFile(path.join(rootDir, "wiki", "code", `${powershellWidget?.sourceId}.md`), "utf8");

    expect(rubyPage).toContain("Language: `ruby`");
    expect(rubyPage).toContain("Namespace/Package: `Sample`");
    expect(rubyPage).toContain(`code/${rubyHelper?.sourceId}`);
    expect(rubyPage).toContain("Renderable");

    expect(powershellPage).toContain("Language: `powershell`");
    expect(powershellPage).toContain(`code/${powershellHelper?.sourceId}`);
    expect(powershellPage).toContain("BaseWidget");

    const searchResults = await searchVault(rootDir, "Widget", 20);
    expect(searchResults.some((entry) => entry.path === `code/${rubyApp?.sourceId}.md`)).toBe(true);
    expect(searchResults.some((entry) => entry.path === `code/${powershellWidget?.sourceId}.md`)).toBe(true);
  });

  it("syncs tracked repo manifests and removes deleted files", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "repo", ".git"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "repo", "src", "keep.py"), "def keep():\n    return 'keep'\n", "utf8");
    await fs.writeFile(path.join(rootDir, "repo", "src", "drop.py"), "def drop():\n    return 'drop'\n", "utf8");

    const initial = await ingestDirectory(rootDir, "repo");
    const droppedManifest = initial.imported.find((manifest) => manifest.originalPath?.endsWith("src/drop.py"));
    expect(droppedManifest).toBeTruthy();

    await fs.rm(path.join(rootDir, "repo", "src", "drop.py"));
    const sync = await syncTrackedRepos(rootDir);
    expect(sync.removed.some((manifest) => manifest.sourceId === droppedManifest?.sourceId)).toBe(true);

    await compileVault(rootDir);

    await expect(fs.access(path.join(rootDir, "state", "manifests", `${droppedManifest?.sourceId}.json`))).rejects.toThrow();
    await expect(fs.access(path.join(rootDir, "wiki", "code", `${droppedManifest?.sourceId}.md`))).rejects.toThrow();
  });
});
