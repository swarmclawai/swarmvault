#!/usr/bin/env node
/**
 * Performance regression lane for SwarmVault.
 *
 * Measures a small set of tight operations against a deterministic in-memory
 * workload, compares against recorded baselines in `scripts/perf-baselines.json`,
 * and fails the build if any measurement exceeds `baseline * (1 + tolerance)`.
 *
 * Update the baselines on purpose by running `node ./scripts/check-perf-budget.mjs --record`.
 * Never update them silently — a regression hiding in a baseline bump is worse
 * than a red CI.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const baselinesPath = path.join(scriptDir, "perf-baselines.json");
const DEFAULT_TOLERANCE = 0.35;

function parseArgs(argv) {
  const args = { record: false, tolerance: DEFAULT_TOLERANCE, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--record") args.record = true;
    else if (token === "--json") args.json = true;
    else if (token === "--tolerance") {
      args.tolerance = Number.parseFloat(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!Number.isFinite(args.tolerance) || args.tolerance < 0) {
    throw new Error(`--tolerance must be a non-negative number, got ${args.tolerance}`);
  }
  return args;
}

async function loadBaselines() {
  try {
    const raw = await fs.readFile(baselinesPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeBaselines(baselines) {
  await fs.writeFile(baselinesPath, `${JSON.stringify(baselines, null, 2)}\n`, "utf8");
}

async function time(label, fn, iterations = 1) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    iterations,
    medianMs: samples[Math.floor(samples.length / 2)],
    minMs: samples[0],
    maxMs: samples[samples.length - 1]
  };
}

async function importEngine() {
  const pkgPath = path.join(repoRoot, "packages", "engine", "dist", "index.js");
  try {
    await fs.access(pkgPath);
  } catch {
    throw new Error(
      `engine dist not built at ${path.relative(repoRoot, pkgPath)}. Run \`pnpm build\` before the perf lane.`
    );
  }
  return import(pkgPath);
}

async function runBenchmarks() {
  const engine = await importEngine();
  const measurements = [];

  // Decay math — large-batch scoring — should stay hot on cached inputs.
  const now = Date.now();
  const lastConfirmed = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
  const config = engine.resolveDecayConfig({});
  measurements.push(
    await time(
      "computeDecayScore:10k",
      () => {
        let acc = 0;
        for (let i = 0; i < 10_000; i += 1) {
          acc += engine.computeDecayScore(lastConfirmed, "first_party", config, new Date(now));
        }
        if (acc < 0) throw new Error("impossible");
      },
      5
    )
  );

  // Large-repo default resolution — cheap but called per compile.
  measurements.push(
    await time(
      "resolveLargeRepoDefaults:100k",
      () => {
        for (let i = 0; i < 100_000; i += 1) {
          engine.resolveLargeRepoDefaults({ nodeCount: 5000 + (i % 1000), totalCommunities: 40 });
        }
      },
      5
    )
  );

  // Redaction on a 20 KB buffer of mixed prose — this is the per-source ingest hot path.
  const redactor = engine.buildRedactor(engine.DEFAULT_REDACTION_PATTERNS, "[REDACTED]");
  const proseChunk = "The quick brown fox jumps over the lazy dog. ".repeat(400);
  measurements.push(
    await time(
      "redact:20KB-prose",
      () => {
        const result = redactor.redact(proseChunk);
        if (!result || typeof result.text !== "string") throw new Error("redactor returned no text");
      },
      20
    )
  );

  return measurements;
}

function formatMs(value) {
  return `${value.toFixed(2)}ms`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const measurements = await runBenchmarks();
  const baselines = await loadBaselines();
  const report = measurements.map((measurement) => {
    const baseline = baselines[measurement.label]?.medianMs;
    const limit = baseline ? baseline * (1 + args.tolerance) : null;
    const regressed = baseline !== undefined && measurement.medianMs > limit;
    return { ...measurement, baselineMs: baseline, limitMs: limit, regressed };
  });

  if (args.record) {
    const next = {};
    for (const entry of measurements) {
      next[entry.label] = { medianMs: Number(entry.medianMs.toFixed(3)), recordedAt: new Date().toISOString() };
    }
    await writeBaselines(next);
    if (!args.json) {
      console.log("[perf] recorded new baselines:");
      for (const entry of measurements) {
        console.log(`  ${entry.label} median=${formatMs(entry.medianMs)}`);
      }
    } else {
      console.log(JSON.stringify({ action: "record", measurements: next }, null, 2));
    }
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ tolerance: args.tolerance, report }, null, 2));
  } else {
    for (const entry of report) {
      const baselineLabel = entry.baselineMs === undefined ? "no-baseline" : formatMs(entry.baselineMs);
      const verdict = entry.regressed ? "REGRESSED" : entry.baselineMs === undefined ? "NEW" : "ok";
      console.log(
        `[perf] ${entry.label}: median=${formatMs(entry.medianMs)} min=${formatMs(entry.minMs)} max=${formatMs(entry.maxMs)} baseline=${baselineLabel} ${verdict}`
      );
    }
  }

  const regressed = report.filter((entry) => entry.regressed);
  if (regressed.length > 0) {
    const lines = regressed.map(
      (entry) => `  ${entry.label}: ${formatMs(entry.medianMs)} > ${formatMs(entry.limitMs ?? 0)} (baseline ${formatMs(entry.baselineMs ?? 0)})`
    );
    console.error(`[perf] regression budget exceeded for ${regressed.length} metric(s):\n${lines.join("\n")}`);
    console.error("[perf] run `node ./scripts/check-perf-budget.mjs --record` after confirming the new numbers are intentional.");
    process.exit(1);
  }

  const missing = report.filter((entry) => entry.baselineMs === undefined);
  if (missing.length > 0) {
    console.warn(`[perf] ${missing.length} metric(s) have no baseline — record them with --record once the numbers are stable.`);
  }
}

await main();
