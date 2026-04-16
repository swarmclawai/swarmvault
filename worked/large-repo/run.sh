#!/usr/bin/env bash
# Exercise the large-repo worked example end-to-end so you can eyeball the
# per-source-class benchmark breakdown introduced in cycle B.8. Everything
# below is intentionally straight-line shell — no helpers, no subshells —
# so it doubles as a readable checklist when something drifts.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Pick up the user's locally installed CLI if present; fall back to npx so
# the script works in a fresh clone before `pnpm install`.
if command -v swarmvault >/dev/null 2>&1; then
  SV=(swarmvault)
else
  SV=(npx --yes @swarmvaultai/cli)
fi

echo "[1/5] swarmvault init"
"${SV[@]}" init

# The bundled config demonstrates the B.7 graph knobs
# (`graph.similarityIdfFloor`, `graph.godNodeLimit`) and opens up every
# source class via `repoAnalysis.extractClasses`.
cp -f swarmvault.config.json ./swarmvault.config.json

echo "[2/5] swarmvault ingest ./sources"
"${SV[@]}" ingest ./sources

echo "[3/5] swarmvault compile"
"${SV[@]}" compile

echo "[4/5] swarmvault benchmark"
"${SV[@]}" benchmark

echo "[5/5] Per-source-class rows from state/benchmark.json"
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const benchmark = JSON.parse(fs.readFileSync(path.join("state", "benchmark.json"), "utf8"));
if (!benchmark.byClass) {
  console.error("benchmark.json is missing byClass; is the engine version at least 0.11.0?");
  process.exit(1);
}
const classes = ["first_party", "third_party", "resource", "generated"];
for (const cls of classes) {
  const entry = benchmark.byClass[cls];
  console.log(
    `${cls.padEnd(13)} sources=${entry.sourceCount} pages=${entry.pageCount} nodes=${entry.nodeCount} god_nodes=${entry.godNodeCount} guided=${entry.finalContextTokens} naive=${entry.corpusTokens} reduction=${(entry.reductionRatio * 100).toFixed(1)}%`
  );
}
NODE

echo
echo "Benchmark By Source Class table from wiki/graph/report.md:"
awk '/^### Benchmark By Source Class/{flag=1} flag{print} flag && NF==0{flag=0}' wiki/graph/report.md
