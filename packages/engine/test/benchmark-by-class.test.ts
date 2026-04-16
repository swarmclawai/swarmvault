import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { benchmarkVault, compileVault, ingestDirectory, initVault } from "../src/index.js";
import type { BenchmarkArtifact } from "../src/types.js";

/**
 * Tests covering the per-source-class benchmark breakdown added in cycle B.8.
 * The goal is to prove:
 *   1. The `byClass` payload is populated for every source class when a vault
 *      ingests first-party, third-party, resource, and generated material.
 *   2. The Markdown graph report renders the new "Benchmark By Source Class"
 *      section once a second compile has picked up the benchmark artifact.
 *   3. Vaults that only hold first-party sources still produce a valid
 *      `byClass` object with zeroed entries for the missing classes rather
 *      than leaving them `undefined` — downstream consumers rely on that.
 */

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-benchmark-by-class-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function createSimplePdf(text: string): Buffer {
  // Minimal, text-only PDF so the resource class has something extractable.
  // Kept inline instead of imported to avoid coupling this test file to the
  // much larger vault.test.ts helper collection.
  const escaped = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

describe("benchmark byClass", () => {
  it("emits one populated entry per source class when all four classes are ingested", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    await fs.mkdir(path.join(rootDir, "repo", "src"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "Pods"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "App.xcassets"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "repo", "dist"), { recursive: true });

    await fs.writeFile(path.join(rootDir, "repo", "src", "app.ts"), "export function main(): string { return 'hello'; }\n", "utf8");
    await fs.writeFile(path.join(rootDir, "repo", "Pods", "vendor.ts"), "export const vendorValue = 1;\n", "utf8");
    await fs.writeFile(
      path.join(rootDir, "repo", "App.xcassets", "Reference.pdf"),
      createSimplePdf("Bundled PDF resource for benchmark-by-class test.")
    );
    await fs.writeFile(path.join(rootDir, "repo", "dist", "generated.js"), "console.log('generated output');\n", "utf8");

    await ingestDirectory(rootDir, "repo", {
      extractClasses: ["first_party", "third_party", "resource", "generated"]
    });

    // First compile generates the graph and the initial benchmark run. The
    // second compile picks up the benchmark artifact and renders the new
    // per-class table in wiki/graph/report.md.
    await compileVault(rootDir);
    await compileVault(rootDir);

    const benchmark = JSON.parse(await fs.readFile(path.join(rootDir, "state", "benchmark.json"), "utf8")) as BenchmarkArtifact;

    expect(benchmark.byClass).toBeDefined();
    expect(benchmark.byClass.first_party.sourceCount).toBeGreaterThan(0);
    expect(benchmark.byClass.third_party.sourceCount).toBeGreaterThan(0);
    expect(benchmark.byClass.resource.sourceCount).toBeGreaterThan(0);
    expect(benchmark.byClass.generated.sourceCount).toBeGreaterThan(0);

    // Each class should know which of its nodes are god-nodes. The exact
    // number depends on the tiny fixture's graph shape, but it must never be
    // `undefined`.
    for (const sourceClass of ["first_party", "third_party", "resource", "generated"] as const) {
      const entry = benchmark.byClass[sourceClass];
      expect(entry.sourceClass).toBe(sourceClass);
      expect(entry.godNodeCount).toBeGreaterThanOrEqual(0);
      expect(entry.corpusTokens).toBeGreaterThanOrEqual(0);
      expect(entry.finalContextTokens).toBeGreaterThanOrEqual(0);
    }

    const reportMarkdown = await fs.readFile(path.join(rootDir, "wiki", "graph", "report.md"), "utf8");
    expect(reportMarkdown).toContain("### Benchmark By Source Class");
    expect(reportMarkdown).toContain("| Class | Sources | Pages | Nodes | God Nodes |");
    expect(reportMarkdown).toMatch(/\|\s*First-party\s*\|/);
    expect(reportMarkdown).toMatch(/\|\s*Third-party\s*\|/);
    expect(reportMarkdown).toMatch(/\|\s*Resource\s*\|/);
    expect(reportMarkdown).toMatch(/\|\s*Generated\s*\|/);
  });

  it("returns zeroed entries for missing classes on a first-party-only vault", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);

    // ingestDirectory is used rather than ingestInput so the manifests carry
    // explicit `sourceClass: "first_party"` — ingestInput only populates the
    // field when the caller threads a value through, and here we explicitly
    // want to cover the first-party-only vault shape.
    await fs.mkdir(path.join(rootDir, "repo"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "repo", "alpha.md"),
      "# Alpha\n\nDurable memory keeps the agent context alive across sessions.\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "repo", "beta.md"),
      "# Beta\n\nPersistent context helps an agent resume prior work after a long pause.\n",
      "utf8"
    );
    await ingestDirectory(rootDir, "repo");

    await compileVault(rootDir);
    const benchmark = await benchmarkVault(rootDir);

    expect(benchmark.byClass).toBeDefined();
    expect(benchmark.byClass.first_party.sourceCount).toBeGreaterThan(0);

    // Fallback contract: the other three classes must exist on the object
    // with zero/empty values so downstream consumers never see `undefined`.
    for (const sourceClass of ["third_party", "resource", "generated"] as const) {
      const entry = benchmark.byClass[sourceClass];
      expect(entry).toBeDefined();
      expect(entry.sourceClass).toBe(sourceClass);
      expect(entry.sourceCount).toBe(0);
      expect(entry.pageCount).toBe(0);
      expect(entry.nodeCount).toBe(0);
      expect(entry.godNodeCount).toBe(0);
      expect(entry.corpusTokens).toBe(0);
      expect(entry.finalContextTokens).toBe(0);
      expect(entry.reductionRatio).toBe(0);
      expect(entry.perQuestion).toEqual([]);
    }
  });
});
