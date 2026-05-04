import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCodeSource, inferCodeLanguage } from "../src/code-analysis.js";
import { compileVault, ingestDirectory, initVault } from "../src/index.js";
import type { GraphArtifact, SourceManifest } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-parser-coverage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function manifestFor(filePath: string, language?: SourceManifest["language"]): SourceManifest {
  return {
    sourceId: `source:${filePath}`,
    title: path.basename(filePath),
    originType: "file",
    sourceKind: "code",
    language,
    originalPath: filePath,
    storedPath: filePath,
    mimeType: "text/plain",
    contentHash: `hash:${filePath}`,
    semanticHash: `semantic:${filePath}`,
    createdAt: "2026-05-04T12:00:00.000Z",
    updatedAt: "2026-05-04T12:00:00.000Z"
  };
}

describe("parser-backed language coverage", () => {
  it("detects Svelte, Julia, Verilog/SystemVerilog, and R source files", () => {
    expect(inferCodeLanguage("Widget.svelte")).toBe("svelte");
    expect(inferCodeLanguage("analysis.jl")).toBe("julia");
    expect(inferCodeLanguage("counter.v")).toBe("verilog");
    expect(inferCodeLanguage("counter.sv")).toBe("systemverilog");
    expect(inferCodeLanguage("stats.R")).toBe("r");
  });

  it("nest-parses Svelte script blocks through the TypeScript analyzer", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.mkdir(path.join(rootDir, "svelte"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "svelte", "state.ts"), "export const label = 'Run';\n", "utf8");
    await fs.writeFile(
      path.join(rootDir, "svelte", "Button.svelte"),
      [
        '<script lang="ts">',
        "import { label } from './state';",
        "export function formatName(name: string): string {",
        "  return label + ' ' + name;",
        "}",
        "</script>",
        '<button id="submitButton">{formatName("task")}</button>'
      ].join("\n"),
      "utf8"
    );

    const ingest = await ingestDirectory(rootDir, path.join(rootDir, "svelte"), { repoRoot: path.join(rootDir, "svelte") });
    const buttonManifest = [...ingest.imported, ...ingest.updated].find((manifest) => manifest.originalPath?.endsWith("Button.svelte"));
    expect(buttonManifest?.language).toBe("svelte");

    await compileVault(rootDir);
    const graph = JSON.parse(await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")) as GraphArtifact;
    const svelteModule = graph.nodes.find((node) => node.type === "module" && node.language === "svelte");

    expect(svelteModule).toBeDefined();
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "formatName")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "symbol" && node.label === "submitButton")).toBe(true);
    expect(graph.edges.some((edge) => edge.source === svelteModule?.id && edge.relation === "imports")).toBe(true);
  });

  it("emits explicit diagnostics when a detected language has no packaged parser asset", async () => {
    const analysis = await analyzeCodeSource(manifestFor("analysis.jl", "julia"), "function f(x)\n  x + 1\nend\n", "schema");

    expect(analysis.code?.language).toBe("julia");
    expect(analysis.code?.diagnostics[0]?.message).toContain("No packaged parser asset");
  });
});
