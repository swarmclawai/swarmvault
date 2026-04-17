# SwarmVault Scale Limits

This document records the tested operating envelope for SwarmVault. Above the top tier, SwarmVault still runs, but interactive performance and memory headroom degrade without targeted tuning. Treat these numbers as recommended ceilings, not hard failures.

## Scale tiers

| Tier | Sources | Pages | Graph nodes | Graph edges | Compile budget (warm) | Recommended backend |
|---|---|---|---|---|---|---|
| Small | up to 500 | up to 2,000 | up to 5,000 | up to 25,000 | < 30 s | heuristic or any provider |
| Medium | up to 5,000 | up to 20,000 | up to 50,000 | up to 200,000 | < 3 min | cached embedding provider recommended |
| Large | up to 50,000 | up to 150,000 | up to 400,000 | up to 1,500,000 | < 15 min | embedding + audio providers with local caching; Neo4j sink useful |

Warm compile budgets assume incremental compile on unchanged sources. Cold compile (full re-analysis) scales roughly linearly with corpus size and can be 3×–6× slower.

## What degrades past each tier

- **`state/search.sqlite` full-text index** — the SQLite FTS5 index stays fast up to the large tier. Above ~1 M indexed rows, plan on splitting the vault or moving the hybrid search layer to an external backend. Single-vault FTS is intentionally the 1.0 default; larger deployments are on the post-1.0 roadmap.
- **Graph compilation memory** — Louvain community detection plus god-node ranking keep the full graph in memory. Expect `node --max-old-space-size=8192 <bin>` once you cross the large tier.
- **Similarity edge density** — above 10,000 nodes, the large-repo defaults automatically cap similarity edges (see `graph.similarityEdgeCap`) so the graph does not fan out into a clique. Tune `graph.similarityIdfFloor` upward to drop more low-IDF features when the cap still feels dense.
- **Viewer interactivity** — the Cytoscape-based graph viewer handles up to ~10,000 visible nodes smoothly on a modern laptop. Use source-class filters, community filters, and tag filters to narrow the view; the standalone HTML export inherits the same limits.
- **Audio transcription** — each audio source calls a provider. At large tier, the per-source cost dominates; cache transcripts by running audio ingest as a separate scheduled job instead of on every compile.

## Knobs to turn when the defaults aren't enough

All knobs live in `swarmvault.config.json`:

- `graph.similarityIdfFloor` — raise (e.g. `0.6`–`0.8`) to drop more common shared features from similarity scoring. Default applies the IDF weighting with a low floor so rare overlaps still win.
- `graph.similarityEdgeCap` — explicit hard cap on similarity edges; overrides the `min(5 * nodeCount, 20000)` default.
- `graph.godNodeLimit` — explicit cap on reported god nodes; overrides the large-repo automatic reduction.
- `graph.foldCommunitiesBelow` — explicit minimum community size for report rollup.
- `repoAnalysis.classifyGlobs` and `repoAnalysis.extractClasses` — classify your vault into `first_party | third_party | resource | generated` and pick which classes get full extraction. For large repos this lets you keep the first-party view dense without re-extracting node_modules or build output.
- `benchmark.enabled: false` — disable the post-compile benchmark pass when you do not need the per-class breakdown every cycle.
- `consolidation.enabled: false` — disable the consolidation pass if you do not use tier insights. Large vaults still compile cleanly without it.
- `freshness.defaultHalfLifeDays` — extend if your corpus is slower-moving; the decay scheduler otherwise marks older pages stale faster than the reality.

## Benchmarking your own vault

Run `swarmvault benchmark` after a compile. The artifact lives at `state/benchmark.json` and ships with a per-source-class breakdown (since 0.11.0). The numbers you care about for scale planning:

- `contextTokensNaive` vs. `contextTokensGraphGuided` — how much the graph-guided retrieval is saving you vs. naive full-corpus context. Above 10× savings means the graph is earning its keep; below 2× means the corpus is probably too small to benefit, or too generic for the similarity layer to find useful overlap.
- `byClass.<class>.compilePageCount` — which class is dominating the page count.
- `wiki/graph/report.md` — community size distribution and god-node concentration. If a handful of god nodes carry most connectivity in a large vault, that is normal; if the top community is >60 % of nodes, the corpus may need better source-class classification or more targeted ingest.

## When you exceed the large tier

You are outside SwarmVault's tested envelope. Options in order of effort:

1. Split by project — most vaults above 50,000 sources have a natural split (multiple repos, multiple research programs). Use separate `swarmvault init` roots and point each at a focused subset.
2. Use the Neo4j sink — push the compiled graph to Neo4j so heavy graph analytics run outside SwarmVault's Node process.
3. Tune the knobs above aggressively and accept longer compile times.
4. File an issue. Large-scale hybrid retrieval and rerank is on the post-1.0 roadmap, and concrete use cases inform that work.

## Recorded measurements

The `check:perf` lane (`pnpm check:perf`) records micro-benchmarks for three tight paths:

- `computeDecayScore:10k` — per-page decay math at compile time.
- `resolveLargeRepoDefaults:100k` — graph-default resolution called per compile.
- `redact:20KB-prose` — ingest-time redaction over a typical note-sized buffer.

Baselines live in `scripts/perf-baselines.json` and are enforced with a ±35 % tolerance in CI. Update the baselines deliberately with `pnpm check:perf:record` after confirming a change is intentional, and note the reason in the commit message.
