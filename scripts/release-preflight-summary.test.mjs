import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPreflightSummary, formatPreflightSummaryMarkdown, writePreflightSummary } from "./release-preflight-summary.mjs";

test("formats and writes release preflight summaries", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-preflight-summary-"));
  try {
    const summary = createPreflightSummary({
      version: "3.4.0",
      repoRoot: "/repo/opensource",
      webRoot: "/repo/web",
      startedAt: "2026-05-03T10:00:00.000Z",
      finishedAt: "2026-05-03T10:05:00.000Z",
      gates: [
        { id: "check", label: "pnpm check", status: "passed", durationMs: 1200 },
        { id: "browser-smoke", label: "browser smoke", status: "skipped", durationMs: 0, detail: "--no-browser" }
      ],
      packageSmoke: {
        installSpecs: ["/tmp/engine.tgz", "/tmp/cli.tgz"],
        packDir: "/tmp/pack",
        packDirKept: true,
        browserSmoke: "skipped",
        ossCorpus: "passed"
      },
      artifacts: {
        summary: "/repo/opensource/.release-preflight/summary.json"
      }
    });

    assert.equal(summary.status, "passed");
    const markdown = formatPreflightSummaryMarkdown(summary);
    assert.match(markdown, /SwarmVault 3\.4\.0 Release Preflight/);
    assert.match(markdown, /pnpm check/);
    assert.match(markdown, /browser smoke/);
    assert.match(markdown, /\/tmp\/engine\.tgz/);

    const written = await writePreflightSummary(summary, outputDir);
    const saved = JSON.parse(await fs.readFile(written.jsonPath, "utf8"));
    assert.equal(saved.version, "3.4.0");
    assert.match(await fs.readFile(written.markdownPath, "utf8"), /OSS corpus: passed/);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
