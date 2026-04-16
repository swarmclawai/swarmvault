# Large Repo Example

Use this when you want a tiny repo-shaped source tree that exercises every
source class (`first_party`, `third_party`, `resource`, `generated`) and
surfaces the per-source-class benchmark breakdown added in cycle B.8.

The example is intentionally small. Its job is to make two things concrete:

1. The large-repo defaults introduced in B.7 — the `graph.similarityIdfFloor`
   and `graph.godNodeLimit` knobs are wired into `swarmvault.config.json` so
   it is obvious how to tune them.
2. The richer benchmark corpus reporting introduced in B.8 — once
   `swarmvault benchmark` runs, `state/benchmark.json` carries a `byClass`
   payload and `wiki/graph/report.md` renders the new
   "Benchmark By Source Class" table.

## Layout

- `sources/src/app.ts` — first-party code that imports local utilities.
- `sources/src/utils.ts` — first-party helper module referenced by `app.ts`.
- `sources/README.md` — first-party markdown describing the repo.
- `sources/package.json` — third-party-like package manifest (classified as
  `first_party` because it lives outside `node_modules/`; included so the
  config preset can demonstrate custom `classifyGlobs` if you want to
  reclassify it).
- `sources/node_modules/left-pad/index.ts` — third-party code the classifier
  picks up via the built-in `node_modules` segment rule.
- `sources/assets/logo.svg` — resource asset, text-only SVG so the worked
  example stays fully text-based.
- `sources/dist/app.d.ts` — generated declaration output the classifier
  recognises via the built-in `dist` segment rule.

## Running

```
cd worked/large-repo
./run.sh
```

The script performs:

1. `swarmvault init` — seeds the vault layout in this directory.
2. Copies the bundled `swarmvault.config.json` into place so the B.7 graph
   knobs are applied.
3. `swarmvault ingest ./sources` — pulls every source class into the vault.
   The `extractClasses` array in the config makes sure third-party,
   resource, and generated material flows through, not just first-party.
4. `swarmvault compile` — builds the graph, benchmark, and reports.
5. `swarmvault benchmark` — re-runs the benchmark explicitly so the
   `byClass` block is fresh.
6. Echoes the per-source-class rows from `state/benchmark.json` and the new
   "Benchmark By Source Class" table from `wiki/graph/report.md` to stdout
   so you can eyeball the output without opening a second terminal.

## Expected output

After the script finishes you should see lines similar to:

```
first_party   sources=3  pages=... nodes=... guided=... naive=... reduction=...
third_party   sources=1  pages=... nodes=... guided=... naive=... reduction=...
resource      sources=1  pages=... nodes=... guided=... naive=... reduction=...
generated     sources=1  pages=... nodes=... guided=... naive=... reduction=...
```

The exact numbers depend on which provider is configured and on local
analysis decisions, but every class should have at least one source.
