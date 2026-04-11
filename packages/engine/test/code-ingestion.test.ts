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

  it("builds parser-backed module pages for Bash and Dart sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "bash"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "dart", "lib"), { recursive: true });

    await fs.writeFile(path.join(repoDir, "bash", "helper.sh"), ["format_name() {", '  printf "Bash:%s\\n" "$1"', "}"].join("\n"), "utf8");
    await fs.writeFile(
      path.join(repoDir, "bash", "widget.sh"),
      ["source ./helper.sh", "", "invoke_format() {", '  format_name "$1"', "}", "", "run_widget() {", '  invoke_format "$1"', "}"].join(
        "\n"
      ),
      "utf8"
    );

    await fs.writeFile(path.join(repoDir, "dart", "pubspec.yaml"), ["name: tiny_app", "description: tiny dart repo"].join("\n"), "utf8");
    await fs.writeFile(
      path.join(repoDir, "dart", "lib", "helper.dart"),
      ["library tiny.app.helper;", "", 'String formatName(String value) => "Dart:$value";'].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "dart", "lib", "widget.dart"),
      [
        "library tiny.app.widget;",
        "",
        "import 'package:tiny_app/helper.dart';",
        "",
        "mixin Loggable {}",
        "",
        "class BaseWidget {}",
        "class Runner {}",
        "",
        "extension WidgetLabels on Widget {",
        "  String label() => decorate('label');",
        "}",
        "",
        "String decorate(String value) => formatName(value);",
        "",
        "class Widget extends BaseWidget with Loggable implements Runner {",
        "  Widget();",
        "",
        "  String run() {",
        "    return decorate('run');",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    const bashHelperManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("bash/helper.sh"));
    const bashWidgetManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("bash/widget.sh"));
    const dartHelperManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("dart/lib/helper.dart"));
    const dartWidgetManifest = result.imported.find((manifest) => manifest.originalPath?.endsWith("dart/lib/widget.dart"));

    if (!bashHelperManifest || !bashWidgetManifest || !dartHelperManifest || !dartWidgetManifest) {
      throw new Error("repo-aware ingest did not return the expected Bash and Dart manifests");
    }

    expect(bashHelperManifest.language).toBe("bash");
    expect(bashWidgetManifest.language).toBe("bash");
    expect(dartHelperManifest.language).toBe("dart");
    expect(dartWidgetManifest.language).toBe("dart");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "bash")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "dart")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "invoke_format")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "run_widget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget.run")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget.label")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "decorate")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "calls" &&
          nodeById.get(edge.source)?.label === "run_widget" &&
          nodeById.get(edge.target)?.label === "invoke_format"
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "calls" && nodeById.get(edge.source)?.label === "Widget.run" && nodeById.get(edge.target)?.label === "decorate"
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "extends" && nodeById.get(edge.source)?.label === "Widget" && nodeById.get(edge.target)?.label === "BaseWidget"
      )
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "implements" &&
          nodeById.get(edge.source)?.label === "Widget" &&
          ["Loggable", "Runner"].includes(nodeById.get(edge.target)?.label ?? "")
      )
    ).toBe(true);

    const bashModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${bashWidgetManifest.sourceId}.md`), "utf8");
    const dartModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${dartWidgetManifest.sourceId}.md`), "utf8");

    expect(bashModulePage).toContain("Language: `bash`");
    expect(bashModulePage).toContain("## Imports");
    expect(bashModulePage).toContain(`code/${bashHelperManifest.sourceId}`);

    expect(dartModulePage).toContain("Language: `dart`");
    expect(dartModulePage).toContain("Namespace/Package: `tiny.app.widget`");
    expect(dartModulePage).toContain("## Imports");
    expect(dartModulePage).toContain(`code/${dartHelperManifest.sourceId}`);
    expect(dartModulePage).toContain("Widget.label");

    const searchResults = await searchVault(rootDir, "Widget.label", 20);
    expect(searchResults.some((result) => result.path === `code/${dartWidgetManifest.sourceId}.md`)).toBe(true);
  });

  it("degrades gracefully on Swift sources without loading the Swift grammar by default", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "swift"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "swift", "Widget.swift"),
      [
        "import Foundation",
        "",
        "public protocol Renderable {",
        "    func render() -> String",
        "}",
        "",
        "open class BaseWidget {}",
        "",
        "public class Widget: BaseWidget, Renderable {",
        "    private let name: String",
        "",
        "    public init(name: String) {",
        "        self.name = name",
        "    }",
        "",
        "    public func render() -> String {",
        "        return formatName(name)",
        "    }",
        "}",
        "",
        "public struct Point {",
        "    public let x: Double",
        "    public let y: Double",
        "}",
        "",
        "public enum Direction {",
        "    case north",
        "    case south",
        "}",
        "",
        "public typealias Coordinate = (Double, Double)"
      ].join("\n"),
      "utf8"
    );

    const widgetManifest = await ingestInput(rootDir, "swift/Widget.swift");

    expect(widgetManifest.language).toBe("swift");

    await compileVault(rootDir);

    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${widgetManifest.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(
      analysis.code?.diagnostics.some((diagnostic) => diagnostic.message.includes("Swift parser-backed analysis is disabled by default"))
    ).toBe(true);
    expect(analysis.code?.symbols ?? []).toHaveLength(0);

    const widgetModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(widgetModulePage).toContain("Language: `swift`");
    expect(widgetModulePage).toContain("Swift parser-backed analysis is disabled by default");

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget")).toBe(false);
  });

  it("builds parser-backed module pages for Elixir sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "elixir"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "elixir", "formatter.ex"),
      ["defmodule MyApp.Formatter do", "  def format(value) do", '    "Elixir:" <> value', "  end", "end"].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "elixir", "widget.ex"),
      [
        "defmodule MyApp.Widget do",
        '  @moduledoc """',
        "  A widget wrapped around a formatter.",
        '  """',
        "",
        "  alias MyApp.Formatter",
        "  require Logger",
        "",
        "  defstruct [:name]",
        "",
        "  def new(name) do",
        "    %__MODULE__{name: name}",
        "  end",
        "",
        "  def render(%__MODULE__{name: name}) do",
        "    Formatter.format(name)",
        "  end",
        "",
        "  defp internal_marker, do: :ok",
        "end",
        "",
        "defprotocol MyApp.Renderable do",
        "  def render(value)",
        "end"
      ].join("\n"),
      "utf8"
    );

    const formatterManifest = await ingestInput(rootDir, "elixir/formatter.ex");
    const widgetManifest = await ingestInput(rootDir, "elixir/widget.ex");

    expect(formatterManifest.language).toBe("elixir");
    expect(widgetManifest.language).toBe("elixir");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "elixir")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "MyApp.Widget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "MyApp.Renderable")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "MyApp.Widget.new")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "MyApp.Widget.render")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "MyApp.Formatter.format")).toBe(true);
    // Private defp function exists as a symbol but is not exported.
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "MyApp.Widget.internal_marker")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);

    const widgetModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(widgetModulePage).toContain("Language: `elixir`");
    expect(widgetModulePage).toContain("Module Name: `MyApp.Widget`");
    expect(widgetModulePage).toContain("## Imports");
    // Resolved Elixir `alias` should link to the formatter module's generated
    // code page via its source ID, proving import resolution fired.
    expect(widgetModulePage).toContain(`code/${formatterManifest.sourceId}`);

    const searchResults = await searchVault(rootDir, "MyApp.Widget.render", 20);
    expect(searchResults.some((result) => result.path === `code/${widgetManifest.sourceId}.md`)).toBe(true);
  });

  it("builds parser-backed module pages for OCaml sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "ocaml"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "ocaml", "formatter.ml"),
      ['let format_name name = Printf.sprintf "OCaml:%s" name'].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "ocaml", "widget.ml"),
      [
        "open Formatter",
        "",
        "type direction = North | South | East | West",
        "",
        "type color = {",
        "  r : int;",
        "  g : int;",
        "  b : int;",
        "}",
        "",
        "module Widget = struct",
        "  type t = { name : string }",
        "  let make name = { name }",
        "  let render w = format_name w.name",
        "end",
        "",
        "module type RENDERABLE = sig",
        "  val render : 'a -> string",
        "end",
        "",
        "let entry_point name = Widget.render (Widget.make name)"
      ].join("\n"),
      "utf8"
    );

    const formatterManifest = await ingestInput(rootDir, "ocaml/formatter.ml");
    const widgetManifest = await ingestInput(rootDir, "ocaml/widget.ml");

    expect(formatterManifest.language).toBe("ocaml");
    expect(widgetManifest.language).toBe("ocaml");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "ocaml")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "RENDERABLE")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "direction")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "color")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "entry_point")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "format_name")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);

    const widgetModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(widgetModulePage).toContain("Language: `ocaml`");
    expect(widgetModulePage).toContain("## Imports");
    // Resolved `open Formatter` should link to formatter.ml's code page.
    expect(widgetModulePage).toContain(`code/${formatterManifest.sourceId}`);
  });

  it("builds parser-backed module pages for Objective-C sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "objc"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "objc", "Widget.m"),
      [
        "#import <Foundation/Foundation.h>",
        "",
        "@protocol Renderable <NSObject>",
        "- (NSString *)render;",
        "@end",
        "",
        "@interface Widget : NSObject <Renderable>",
        "@property (nonatomic, copy) NSString *name;",
        "- (NSString *)render;",
        "@end",
        "",
        "@implementation Widget",
        "- (NSString *)render {",
        '    return [NSString stringWithFormat:@"Widget:%@", _name];',
        "}",
        "@end",
        "",
        "NSString *formatName(NSString *name) {",
        '    return [NSString stringWithFormat:@"Name:%@", name];',
        "}"
      ].join("\n"),
      "utf8"
    );

    const widgetManifest = await ingestInput(rootDir, "objc/Widget.m");
    expect(widgetManifest.language).toBe("objc");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "objc")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Renderable")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "formatName")).toBe(true);
    // `Widget : NSObject` should yield an extends edge to NSObject (even if
    // NSObject itself is not a local symbol; the edge check only needs the source
    // and relation to exist).
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "implements" &&
          nodeById.get(edge.source)?.label === "Widget" &&
          nodeById.get(edge.target)?.label === "Renderable"
      )
    ).toBe(true);

    const widgetModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(widgetModulePage).toContain("Language: `objc`");
  });

  it("builds parser-backed module pages for ReScript sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "rescript"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "rescript", "formatter.res"),
      ['let formatName = (name: string): string => "ReScript:" ++ name'].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "rescript", "widget.res"),
      [
        "open Formatter",
        "",
        "type direction = North | South | East | West",
        "",
        "type color = {",
        "  r: int,",
        "  g: int,",
        "  b: int,",
        "}",
        "",
        "module Widget = {",
        "  type t = {name: string}",
        "  let make = (name: string): t => {name: name}",
        "  let render = (w: t): string => formatName(w.name)",
        "}",
        "",
        "let defaultColor = {r: 0, g: 0, b: 0}"
      ].join("\n"),
      "utf8"
    );

    const formatterManifest = await ingestInput(rootDir, "rescript/formatter.res");
    const widgetManifest = await ingestInput(rootDir, "rescript/widget.res");

    expect(formatterManifest.language).toBe("rescript");
    expect(widgetManifest.language).toBe("rescript");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "rescript")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "direction")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "color")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "formatName")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "defaultColor")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);

    const widgetModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(widgetModulePage).toContain("Language: `rescript`");
    expect(widgetModulePage).toContain(`code/${formatterManifest.sourceId}`);
  });

  it("builds parser-backed module pages for Solidity sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "solidity"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "solidity", "IWidget.sol"),
      [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity ^0.8.20;",
        "",
        "interface IWidget {",
        "    function render() external view returns (string memory);",
        "}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "solidity", "Widget.sol"),
      [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity ^0.8.20;",
        "",
        'import "./IWidget.sol";',
        "",
        "library WidgetMath {",
        "    function multiply(uint256 a, uint256 b) internal pure returns (uint256) {",
        "        return a * b;",
        "    }",
        "}",
        "",
        "contract Widget is IWidget {",
        "    string public name;",
        "",
        "    constructor(string memory _name) {",
        "        name = _name;",
        "    }",
        "",
        "    function render() external view override returns (string memory) {",
        "        return name;",
        "    }",
        "}",
        "",
        "struct Point {",
        "    uint256 x;",
        "    uint256 y;",
        "}",
        "",
        "enum Direction { North, South, East, West }"
      ].join("\n"),
      "utf8"
    );

    const iWidgetManifest = await ingestInput(rootDir, "solidity/IWidget.sol");
    const widgetManifest = await ingestInput(rootDir, "solidity/Widget.sol");

    expect(iWidgetManifest.language).toBe("solidity");
    expect(widgetManifest.language).toBe("solidity");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "solidity")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "IWidget")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "WidgetMath")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Point")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Direction")).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.relation === "implements" && nodeById.get(edge.source)?.label === "Widget" && nodeById.get(edge.target)?.label === "IWidget"
      )
    ).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);

    const widgetModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(widgetModulePage).toContain("Language: `solidity`");
    expect(widgetModulePage).toContain(`code/${iWidgetManifest.sourceId}`);
  });

  it("builds parser-backed module pages for HTML sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "site"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "site", "index.html"),
      [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="UTF-8">',
        "  <title>Widget Demo</title>",
        '  <link rel="stylesheet" href="./styles.css">',
        "</head>",
        "<body>",
        '  <nav id="main-nav">',
        '    <a href="#home">Home</a>',
        "  </nav>",
        '  <main id="content">',
        '    <section id="hero">',
        '      <my-custom-widget name="hello"></my-custom-widget>',
        "    </section>",
        "  </main>",
        '  <script src="./widget.js"></script>',
        "</body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );

    const manifest = await ingestInput(rootDir, "site/index.html");
    expect(manifest.language).toBe("html");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "html")).toBe(true);
    // Custom element <my-custom-widget> becomes a class symbol.
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "my-custom-widget")).toBe(true);
    // Elements with id attributes become variable symbols.
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "main-nav")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "content")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "hero")).toBe(true);

    const indexModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${manifest.sourceId}.md`), "utf8");
    expect(indexModulePage).toContain("Language: `html`");
    expect(indexModulePage).toContain("## Imports");
  });

  it("builds parser-backed module pages for CSS sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "styles"), { recursive: true });

    await fs.writeFile(path.join(rootDir, "styles", "reset.css"), ["body { margin: 0; }"].join("\n"), "utf8");
    await fs.writeFile(
      path.join(rootDir, "styles", "main.css"),
      [
        '@import "./reset.css";',
        "",
        ":root {",
        "    --primary: #3498db;",
        "}",
        "",
        ".navigation {",
        "    display: flex;",
        "}",
        "",
        "#main-content {",
        "    max-width: 1200px;",
        "}",
        "",
        "@keyframes fadeIn {",
        "    from { opacity: 0; }",
        "    to { opacity: 1; }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const resetManifest = await ingestInput(rootDir, "styles/reset.css");
    const mainManifest = await ingestInput(rootDir, "styles/main.css");

    expect(resetManifest.language).toBe("css");
    expect(mainManifest.language).toBe("css");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "css")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === ".navigation")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "#main-content")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "@keyframes fadeIn")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "imports")).toBe(true);

    const mainModulePage = await fs.readFile(path.join(rootDir, "wiki", "code", `${mainManifest.sourceId}.md`), "utf8");
    expect(mainModulePage).toContain("Language: `css`");
    expect(mainModulePage).toContain(`code/${resetManifest.sourceId}`);
  });

  it("builds parser-backed module pages for Vue SFC sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "vue"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "vue", "Widget.vue"),
      [
        "<script setup>",
        "import { ref, computed } from 'vue'",
        "const count = ref(0)",
        "</script>",
        "",
        "<template>",
        '  <div id="app-root">',
        "    <h1>Counter: {{ count }}</h1>",
        '    <SubWidget :value="count" />',
        "  </div>",
        "</template>",
        "",
        "<style scoped>",
        ".container { padding: 1rem; }",
        "</style>"
      ].join("\n"),
      "utf8"
    );

    const widgetManifest = await ingestInput(rootDir, "vue/Widget.vue");
    expect(widgetManifest.language).toBe("vue");

    await compileVault(rootDir);

    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    expect(graph.nodes.some((node) => node.type === "module" && node.language === "vue")).toBe(true);
    // The SFC's own component name (derived from the filename) is the primary symbol.
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "Widget")).toBe(true);
    // PascalCase tag inside <template> is treated as a Vue component reference.
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "SubWidget")).toBe(true);
    // An id="app-root" on a plain element becomes a variable symbol.
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "app-root")).toBe(true);

    const page = await fs.readFile(path.join(rootDir, "wiki", "code", `${widgetManifest.sourceId}.md`), "utf8");
    expect(page).toContain("Language: `vue`");
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

  it("detects executable shell scripts by shebang even without an extension", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    const scriptPath = path.join(repoDir, "run-widget");
    await fs.writeFile(scriptPath, ["#!/usr/bin/env bash", "run_widget() {", "  echo ok", "}"].join("\n"), "utf8");
    await fs.chmod(scriptPath, 0o755);

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    const manifest = result.imported.find((entry) => entry.originalPath?.endsWith("run-widget"));

    expect(manifest?.sourceKind).toBe("code");
    expect(manifest?.language).toBe("bash");
  });

  it("detects executable node, python, and ruby scripts by shebang without an extension", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    const cases: Array<{ name: string; body: string; language: string }> = [
      { name: "runnode", body: '#!/usr/bin/env node\nconsole.log("ok");\n', language: "javascript" },
      { name: "runpy", body: "#!/usr/bin/env python3\nprint('ok')\n", language: "python" },
      { name: "runruby", body: '#!/usr/bin/env ruby\nputs "ok"\n', language: "ruby" }
    ];
    for (const { name, body } of cases) {
      const scriptPath = path.join(repoDir, name);
      await fs.writeFile(scriptPath, body, "utf8");
      await fs.chmod(scriptPath, 0o755);
    }

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    for (const { name, language } of cases) {
      const manifest = result.imported.find((entry) => entry.originalPath?.endsWith(name));
      expect(manifest?.sourceKind, `script ${name}`).toBe("code");
      expect(manifest?.language, `script ${name}`).toBe(language);
    }
  });

  it("treats TypeScript files as text/typescript instead of video/mp2t", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    for (const [filename, body] of [
      ["api.ts", "export const token = 1;\n"],
      ["types.d.ts", "export interface Shape { area: number }\n"],
      ["loader.mts", "export const mode = 'esm';\n"],
      ["legacy.cts", "export const mode = 'cjs';\n"]
    ] as const) {
      await fs.writeFile(path.join(repoDir, filename), body, "utf8");
    }

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    const manifests = result.imported.filter((entry) => /\.(d\.)?[mc]?ts$/.test(entry.originalPath ?? ""));
    expect(manifests).toHaveLength(4);
    for (const manifest of manifests) {
      expect(manifest.mimeType, manifest.originalPath).toBe("text/typescript");
      expect(manifest.sourceKind, manifest.originalPath).toBe("code");
    }
  });

  it("ingests common text manifest, config, and license files instead of dropping them as binary", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    // Most dev files land as `text`; TOML/YAML/JSON config files that are NOT code
    // manifests (package.json / tsconfig.json) get promoted to the `data` source kind
    // so their structure still surfaces in the graph.
    const textFiles: Array<[string, string, "text" | "data"]> = [
      ["package.json", '{"name": "demo", "version": "0.0.1"}\n', "text"],
      ["tsconfig.json", '{"compilerOptions": {"strict": true}}\n', "text"],
      ["pyproject.toml", '[project]\nname = "demo"\n', "data"],
      ["Cargo.toml", '[package]\nname = "demo"\n', "data"],
      ["go.mod", "module example.com/demo\n\ngo 1.22\n", "text"],
      ["go.sum", "example.com/demo v1.0.0 h1:abc\n", "text"],
      ["LICENSE", "MIT License\nCopyright (c) 2026\n", "text"],
      ["LICENSE-MIT", "MIT License\n", "text"],
      ["Makefile", "build:\n\techo hi\n", "text"],
      ["Dockerfile", 'FROM node:24\nCMD ["node"]\n', "text"],
      [".gitignore", "node_modules/\n", "text"],
      [".editorconfig", "root = true\n", "text"]
    ];
    for (const [filename, body] of textFiles) {
      await fs.writeFile(path.join(repoDir, filename), body, "utf8");
    }

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    for (const [filename, , expectedKind] of textFiles) {
      const manifest = result.imported.find((entry) => entry.originalPath?.endsWith(filename));
      expect(manifest, `expected ${filename} to be ingested`).toBeDefined();
      expect(manifest?.sourceKind, filename).toBe(expectedKind);
    }
    expect(result.skipped.filter((entry) => entry.reason.startsWith("unsupported_kind"))).toHaveLength(0);
  });

  it("parses multiple Lua sources without emitting spurious tree-sitter diagnostics", async () => {
    // tree-sitter-lua@0.1.13 leaks wasm state across parses: the first Lua source in a
    // session parses cleanly, but every subsequent Lua source inherits poisoned state and
    // reports bogus "syntax error" nodes on fundamentally valid code. The descendant-based
    // symbol and import walkers still work against the corrupted tree, so we keep those
    // results and suppress the unreliable grammar diagnostics for Lua specifically.
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "widget.lua"),
      ['local helper = require("helper")', "", "function renderWidget(name)", "  return helper.formatName(name)", "end", ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "helper.lua"),
      ["local M = {}", "", "function M.formatName(name)", '  return "Lua:" .. name', "end", "", "return M", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    expect(result.imported).toHaveLength(2);

    await compileVault(rootDir);

    for (const entry of result.imported) {
      const analysisPath = path.join(rootDir, "state", "analyses", `${entry.sourceId}.json`);
      const analysis = JSON.parse(await fs.readFile(analysisPath, "utf8")) as SourceAnalysis;
      expect(analysis.code?.diagnostics ?? [], `${entry.repoRelativePath} should have no diagnostics`).toHaveLength(0);
      expect(analysis.code?.symbols.length, `${entry.repoRelativePath} should extract symbols`).toBeGreaterThan(0);
    }
  });

  it("tracks Rust `mod` declarations as local module imports that resolve to sibling files", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "src", "lib.rs"),
      [
        "mod fmt;",
        "",
        "pub trait Renderable {}",
        "pub struct Widget;",
        "impl Renderable for Widget {}",
        "",
        "pub fn render(name: &str) -> String {",
        "    fmt::format_name(name)",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "src", "fmt.rs"),
      ["pub fn format_name(name: &str) -> String {", '    format!("Rust:{name}")', "}", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    expect(result.imported).toHaveLength(2);

    await compileVault(rootDir);

    const libManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("lib.rs"));
    const fmtManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("fmt.rs"));
    expect(libManifest).toBeDefined();
    expect(fmtManifest).toBeDefined();

    const libAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${libManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const modImport = libAnalysis.code?.imports.find((entry) => entry.specifier === "self::fmt");
    expect(modImport, "mod fmt; should appear as a local import with specifier self::fmt").toBeDefined();
    expect(modImport?.isExternal).toBe(false);
    expect(modImport?.resolvedSourceId).toBe(fmtManifest?.sourceId);
  });

  it("resolves Ruby `require_relative` sibling files even when the specifier is a bare name", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "lib"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "lib", "widget.rb"),
      [
        'require_relative "helper"',
        "",
        "module Tiny",
        "  class Widget",
        "    def render(name)",
        "      Tiny.format_label(name)",
        "    end",
        "  end",
        "end",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "lib", "helper.rb"),
      ["module Tiny", "  def self.format_label(name)", '    "Ruby:#{name}"', "  end", "end", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    expect(result.imported).toHaveLength(2);

    await compileVault(rootDir);

    const widgetManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("widget.rb"));
    const helperManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("helper.rb"));
    const widgetAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${widgetManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;

    const requireRelative = widgetAnalysis.code?.imports[0];
    expect(requireRelative, "widget.rb should record the require_relative import").toBeDefined();
    expect(requireRelative?.isExternal).toBe(false);
    expect(requireRelative?.resolvedSourceId).toBe(helperManifest?.sourceId);
  });

  it("resolves PowerShell dot-source imports that reference $PSScriptRoot", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "Widget.ps1"),
      [
        '. "$PSScriptRoot/Helper.ps1"',
        "",
        "function Invoke-Widget {",
        "  param([string]$Name)",
        "  return Format-Label -Name $Name",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "Helper.ps1"),
      ["function Format-Label {", "  param([string]$Name)", '  return "PS:$Name"', "}", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    expect(result.imported).toHaveLength(2);

    await compileVault(rootDir);

    const widgetManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Widget.ps1"));
    const helperManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Helper.ps1"));
    const widgetAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${widgetManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;

    const dotSource = widgetAnalysis.code?.imports[0];
    expect(dotSource, "Widget.ps1 should record the dot-source import").toBeDefined();
    expect(dotSource?.isExternal).toBe(false);
    expect(dotSource?.resolvedSourceId).toBe(helperManifest?.sourceId);
  });

  it("parses Rust multi-line brace-group use declarations into one import per selector", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "src", "lib.rs"),
      ["mod a;", "mod b;", "use crate::{", "    a::X,", "    b::Y,", "};", "", "pub fn render() -> (X, Y) { (X, Y) }", ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(repoDir, "src", "a.rs"), "pub struct X;\n", "utf8");
    await fs.writeFile(path.join(repoDir, "src", "b.rs"), "pub struct Y;\n", "utf8");

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    expect(result.imported).toHaveLength(3);
    await compileVault(rootDir);

    const libManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("lib.rs"));
    const aManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("a.rs"));
    const bManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("b.rs"));
    const libAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${libManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    // Brace-group use expands one import per selector with the leaf symbol captured
    // in importedSymbols. The specifier is the full module::symbol path and the
    // resolver's trailing-segment stripping maps each one to the sibling source file.
    const aImport = libAnalysis.code?.imports.find((entry) => entry.specifier === "crate::a::X");
    const bImport = libAnalysis.code?.imports.find((entry) => entry.specifier === "crate::b::Y");
    expect(aImport, "crate::a::X import should exist").toBeDefined();
    expect(bImport, "crate::b::Y import should exist").toBeDefined();
    expect(aImport?.importedSymbols).toContain("X");
    expect(bImport?.importedSymbols).toContain("Y");
    expect(aImport?.resolvedSourceId).toBe(aManifest?.sourceId);
    expect(bImport?.resolvedSourceId).toBe(bManifest?.sourceId);
  });

  it("strips trailing Rust symbol segments when the specifier targets a module file", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "src", "lib.rs"),
      ["mod inner;", "", "use crate::inner::CONST_NAME;", "", "pub fn read() -> u32 { CONST_NAME }", ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(repoDir, "src", "inner.rs"), "pub const CONST_NAME: u32 = 42;\n", "utf8");

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const libManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("lib.rs"));
    const innerManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("inner.rs"));
    const libAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${libManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const constImport = libAnalysis.code?.imports.find((entry) => entry.specifier === "crate::inner::CONST_NAME");
    expect(constImport).toBeDefined();
    expect(constImport?.resolvedSourceId).toBe(innerManifest?.sourceId);
  });

  it("disambiguates Rust `crate::` references across multiple workspace crates", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "crates", "alpha", "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "crates", "beta", "src"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "crates", "alpha", "src", "lib.rs"),
      ["// alpha crate root", "mod shared;", "use crate::shared::name;", "pub fn announce_alpha() -> &'static str { name() }", ""].join(
        "\n"
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "crates", "alpha", "src", "shared.rs"),
      ['pub fn name() -> &\'static str { "alpha" }', ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "crates", "beta", "src", "lib.rs"),
      ["// beta crate root", "mod shared;", "use crate::shared::name;", "pub fn announce_beta() -> &'static str { name() }", ""].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(repoDir, "crates", "beta", "src", "shared.rs"),
      ['pub fn name() -> &\'static str { "beta" }', ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const alphaLib = result.imported.find((entry) => entry.repoRelativePath?.endsWith("crates/alpha/src/lib.rs"));
    const alphaShared = result.imported.find((entry) => entry.repoRelativePath?.endsWith("crates/alpha/src/shared.rs"));
    const betaLib = result.imported.find((entry) => entry.repoRelativePath?.endsWith("crates/beta/src/lib.rs"));
    const betaShared = result.imported.find((entry) => entry.repoRelativePath?.endsWith("crates/beta/src/shared.rs"));

    const alphaAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${alphaLib?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const betaAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${betaLib?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;

    const alphaImport = alphaAnalysis.code?.imports.find((entry) => entry.specifier === "crate::shared::name");
    const betaImport = betaAnalysis.code?.imports.find((entry) => entry.specifier === "crate::shared::name");

    expect(alphaImport?.resolvedSourceId).toBe(alphaShared?.sourceId);
    expect(betaImport?.resolvedSourceId).toBe(betaShared?.sourceId);
  });

  it("extracts Python `from` imports through the AST, not regex on text", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "pkg"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "pkg", "__init__.py"), "", "utf8");
    await fs.writeFile(path.join(repoDir, "pkg", "mod.py"), "def A():\n    return 1\n\ndef B():\n    return 2\n", "utf8");
    await fs.writeFile(
      path.join(repoDir, "pkg", "app.py"),
      ["from .mod import A, B as C", "", "def run():", "    return A() + C()", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const appManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("pkg/app.py"));
    const appAnalysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${appManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const fromImport = appAnalysis.code?.imports[0];
    expect(fromImport?.specifier).toBe(".mod");
    expect(fromImport?.importedSymbols).toEqual(["A", "B as C"]);
    expect(fromImport?.isExternal).toBe(false);
  });

  it("extracts Go import specs including named, dot, and blank imports via AST", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "main.go"),
      [
        "package main",
        "",
        "import (",
        '    "fmt"',
        '    myio "io"',
        '    . "strings"',
        '    _ "os"',
        ")",
        "",
        'func main() { fmt.Println("hi") }',
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const mainManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("main.go"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${mainManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const specs = new Map(analysis.code?.imports.map((entry) => [entry.specifier, entry]) ?? []);
    expect(specs.get("fmt")?.namespaceImport).toBeUndefined();
    expect(specs.get("io")?.namespaceImport).toBe("myio");
    expect(specs.get("strings")?.namespaceImport).toBeUndefined();
    expect(specs.get("os")?.namespaceImport).toBeUndefined();
    expect(specs.size).toBe(4);
  });

  it("records Java wildcard and static imports through the AST", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, "com", "example"), { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "com", "example", "Widget.java"),
      [
        "package com.example;",
        "",
        "import java.util.List;",
        "import java.util.*;",
        "import static com.example.Constants.*;",
        "",
        "public class Widget {",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Widget.java"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const specifiers = (analysis.code?.imports ?? []).map((entry) => entry.specifier).sort();
    expect(specifiers).toEqual(["com.example.Constants.*", "java.util.*", "java.util.List"]);
  });

  it("records Kotlin aliased imports through the AST", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "Widget.kt"),
      ["package demo", "", "import foo.bar.Thing as T", "", "class Widget {", "  fun make(): T = T()", "}", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Widget.kt"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const aliased = analysis.code?.imports.find((entry) => entry.specifier === "foo.bar.Thing");
    expect(aliased).toBeDefined();
    expect(aliased?.namespaceImport).toBe("T");
  });

  it("emits one Scala import per brace-group selector with alias support", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "Widget.scala"),
      [
        "package demo",
        "",
        "import java.util.{List, ArrayList => AList}",
        "",
        "class Widget {",
        "  val items: List[AList[Int]] = null",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Widget.scala"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const selectors = analysis.code?.imports.filter((entry) => entry.specifier === "java.util") ?? [];
    expect(selectors).toHaveLength(2);
    const symbols = selectors.flatMap((entry) => entry.importedSymbols).sort();
    expect(symbols).toEqual(["ArrayList as AList", "List"]);
  });

  it("records C# aliased using directives through the AST", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "Widget.cs"),
      ["using Alias = System.Text.StringBuilder;", "using System.Collections.Generic;", "", "public class Widget {}", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Widget.cs"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const aliased = analysis.code?.imports.find((entry) => entry.specifier === "System.Text.StringBuilder");
    expect(aliased).toBeDefined();
    expect(aliased?.namespaceImport).toBe("Alias");
    const plain = analysis.code?.imports.find((entry) => entry.specifier === "System.Collections.Generic");
    expect(plain).toBeDefined();
    expect(plain?.namespaceImport).toBeUndefined();
  });

  it("expands PHP grouped use declarations into one import per clause", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "Widget.php"),
      ["<?php", "namespace App;", "", "use Foo\\{Baz, Qux as Q};", "", "class Widget {}", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("Widget.php"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const imports = analysis.code?.imports ?? [];
    const baz = imports.find((entry) => entry.specifier === "Foo\\Baz");
    const qux = imports.find((entry) => entry.specifier === "Foo\\Qux");
    expect(baz).toBeDefined();
    expect(qux).toBeDefined();
    expect(qux?.namespaceImport).toBe("Q");
  });

  it("distinguishes C++ system and local include directives through the AST", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "local.h"), ["#pragma once", "int shared();", ""].join("\n"), "utf8");
    await fs.writeFile(
      path.join(repoDir, "main.cpp"),
      ["#include <vector>", '#include "local.h"', "", "int main() { return shared(); }", ""].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const mainManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("main.cpp"));
    const localManifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("local.h"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${mainManifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    const system = analysis.code?.imports.find((entry) => entry.specifier === "vector");
    const local = analysis.code?.imports.find((entry) => entry.specifier === "local.h");
    expect(system?.isExternal).toBe(true);
    expect(local?.isExternal).toBe(false);
    expect(local?.resolvedSourceId).toBe(localManifest?.sourceId);
  });

  it("tolerates C preprocessor directives that interrupt if/else control flow", async () => {
    // Real json-c pattern: the `else` branch is stitched across a `#endif`. Without
    // preprocessor neutralisation tree-sitter-c reports a dangling `else` and emits
    // a spurious syntax error.
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "debug.c"),
      [
        "#include <stdio.h>",
        "void log_msg(const char *msg) {",
        "#if HAVE_SYSLOG",
        "    syslog(0, msg);",
        "    if (1)",
        "    {",
        '        printf("yes");',
        "    }",
        "    else",
        "#endif",
        '        printf("no");',
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("debug.c"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.code?.diagnostics ?? [], "debug.c should parse cleanly").toHaveLength(0);
  });

  it("tolerates C# preprocessor directives that split a single expression body", async () => {
    // Real System.CommandLine pattern: `#if NET7_0_OR_GREATER` splits an
    // expression-bodied method across two alternative bodies joined by `&&` with the
    // trailing clause, which tree-sitter-c-sharp cannot reconcile unaided.
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "ConsoleHelpers.cs"),
      [
        "namespace System.CommandLine {",
        "    internal static class ConsoleHelpers {",
        "        private static readonly bool ColorsAreSupported = GetColorsAreSupported();",
        "        private static bool GetColorsAreSupported()",
        "#if NET7_0_OR_GREATER",
        "            => !(OperatingSystem.IsBrowser() || OperatingSystem.IsAndroid())",
        "#else",
        '            => !(RuntimeInformation.IsOSPlatform(OSPlatform.Create("BROWSER")))',
        "#endif",
        "            && !Console.IsOutputRedirected;",
        "    }",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("ConsoleHelpers.cs"));
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.code?.diagnostics ?? [], "ConsoleHelpers.cs should parse cleanly").toHaveLength(0);
    const symbolNames = (analysis.code?.symbols ?? []).map((s) => s.name);
    expect(symbolNames).toContain("ConsoleHelpers");
  });

  it("suppresses grammar diagnostics on zsh-flavoured shell scripts", async () => {
    // tree-sitter-bash parses POSIX bash only; feeding it zsh-specific parameter
    // expansions produces noisy errors. Detect the dialect and silence the
    // grammar-level diagnostics while still running the descendant-based walkers
    // so functions and `source` edges still land in the graph.
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    const repoDir = path.join(rootDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "completion.zsh"),
      [
        "#!/usr/bin/env zsh",
        "",
        "function collect_options() {",
        `    local lines=( \${(f)"$(echo -e "a\\nb\\nc")"} )`,
        "    print -l $lines",
        "}",
        "",
        "collect_options",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await ingestDirectory(rootDir, repoDir, { repoRoot: repoDir });
    await compileVault(rootDir);

    const manifest = result.imported.find((entry) => entry.repoRelativePath?.endsWith("completion.zsh"));
    expect(manifest, "completion.zsh should be ingested").toBeDefined();
    const analysis = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "analyses", `${manifest?.sourceId}.json`), "utf8")
    ) as SourceAnalysis;
    expect(analysis.code?.diagnostics ?? [], "zsh script should have no grammar diagnostics").toHaveLength(0);
    const symbolNames = (analysis.code?.symbols ?? []).map((s) => s.name);
    expect(symbolNames).toContain("collect_options");
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
    // Two Python code files plus the repo's .gitignore (now recognized as a
    // known text file rather than silently dropped as an unsupported binary).
    expect(initial.imported).toHaveLength(3);
    expect(initial.imported.some((manifest) => manifest.originalPath?.endsWith(".gitignore"))).toBe(true);
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
