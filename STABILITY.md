# SwarmVault Stability Contract

This document is the public-API contract for SwarmVault. Every surface in the **Stable** tables is covered by the semantic-versioning promise: breaking changes require a major version bump (e.g. `1.x.y` → `2.0.0`). **Experimental** surfaces may change in any minor release. **Internal** surfaces are not part of the public API and may change in any release.

SwarmVault follows [semantic versioning 2.0.0](https://semver.org/spec/v2.0.0.html). Once `1.0.0` is cut:

- `MAJOR` — breaking changes to anything listed as Stable below.
- `MINOR` — additions to the public surface (new CLI subcommands, new config keys, new MCP tools, new frontmatter fields). Existing stable surfaces keep working unchanged.
- `PATCH` — bug fixes, performance improvements, documentation, no surface changes.

## Deprecation policy

When a Stable surface is retired, it follows this deprecation window:

1. **Announcement**: the retiring surface is marked `@deprecated` in code and annotated here with the target removal version. A `CHANGELOG.md` entry describes the replacement and the migration path.
2. **Grace window**: **at least two minor releases** must pass before removal. If 1.0.0 deprecates something, the earliest it can be removed is 1.2.0.
3. **Runtime warning**: `swarmvault lint` flags deprecated config keys and CLI usage so users see the warning during normal workflow.
4. **Removal**: the surface is removed in the announced version. A migration is added to `swarmvault migrate` so existing vaults transition cleanly. `swarmvault migrate` handles the schema side; users update their own workflows.
5. **Major bumps**: a `MAJOR` release may remove surfaces without the two-minor grace window, but the `CHANGELOG.md` and `MIGRATION.md` entries must still describe the replacement and migration path.

Incompatible changes to Experimental surfaces do not follow this policy. They may change with a single `CHANGELOG.md` note in any minor release.

## CLI subcommands

Stable:

| Command | Status | Since |
|---|---|---|
| `swarmvault init [--obsidian] [--profile <preset>] [--lite]` | Stable | 0.1.0 |
| `swarmvault demo [--port <n>] [--serve]` | Stable | 0.7.26 |
| `swarmvault scan <dir> [--port <n>] [--serve]` | Stable | 0.7.x |
| `swarmvault ingest <path\|url> [--guide\|--no-guide] [--review] [--commit] [--no-redact] [--resume <run-id>]` | Stable | 0.1.0 |
| `swarmvault add <url> [--no-redact]` | Stable | 0.7.x |
| `swarmvault source add\|list\|reload\|delete\|review\|guide\|session` | Stable | 0.7.x |
| `swarmvault inbox import [dir]` | Stable | 0.7.x |
| `swarmvault compile [--approve] [--commit] [--max-tokens <n>]` | Stable | 0.1.0 |
| `swarmvault query <question> [--no-save] [--commit] [--format ...] [--gap-fill]` | Stable | 0.1.0 (`--gap-fill` since 0.10.0) |
| `swarmvault explore <question> [--steps <n>] [--format ...] [--gap-fill]` | Stable | 0.7.x (`--gap-fill` since 0.10.0) |
| `swarmvault lint [--deep\|--no-deep] [--web] [--conflicts] [--decay] [--tiers]` | Stable | 0.1.0 (`--decay`/`--tiers` since 0.10.0) |
| `swarmvault review list\|show\|accept\|reject` | Stable | 0.7.x |
| `swarmvault graph query\|path\|explain\|god-nodes\|blast\|serve\|export\|push\|supersession` | Stable | 0.7.x (`supersession` since 0.10.0) |
| `swarmvault candidate list\|promote\|archive\|auto-promote\|preview-scores` | Stable | 0.7.x |
| `swarmvault watch [--lint] [--repo] [--once] [--code-only] [--debounce <ms>] [--root <path>]` | Stable | 0.7.x (`--root` since 0.11.0) |
| `swarmvault watch list-roots\|add-root\|remove-root` | Stable | 0.11.0 |
| `swarmvault watch status` / `swarmvault watch-status` | Stable | 0.7.x |
| `swarmvault hook install\|uninstall\|status` | Stable | 0.7.x |
| `swarmvault schedule list\|run\|serve` | Stable | 0.7.x |
| `swarmvault diff` | Stable | 0.7.26 |
| `swarmvault benchmark [--question <text...>]` | Stable | 0.7.x |
| `swarmvault consolidate [--dry-run]` | Stable | 0.10.0 |
| `swarmvault migrate [--target <version>] [--apply] [--dry-run]` | Stable | 0.12.0 |
| `swarmvault install --agent <agent>` | Stable | 0.7.x |
| `swarmvault mcp` | Stable | 0.7.x |
| `swarmvault --json` (global) | Stable | 0.1.0 |
| `swarmvault --version` | Stable | 0.1.0 |

## Config keys (`swarmvault.config.json`)

Stable (all keys existing in 0.11.0 plus the new 0.12.0 additions):

- `workspace.{rawDir, wikiDir, stateDir, agentDir, inboxDir}`
- `providers.<id>.{type, model, baseUrl, apiKeyEnv, headers, module, capabilities, apiStyle}`
- `tasks.{compileProvider, queryProvider, lintProvider, visionProvider, imageProvider?, embeddingProvider?, audioProvider?}`
- `viewer.port`
- `profile.{presets, dashboardPack, guidedSessionMode, dataviewBlocks, guidedIngestDefault, deepLintDefault}`
- `projects.<id>.{roots, schemaPath?}`
- `agents[]`
- `schedules.<id>.{enabled?, when.{cron?|every?}, task.{type: compile|lint|query|explore|consolidate, ...}}`
- `orchestration.{maxParallelRoles?, compilePostPass?, roles.{research|audit|context|safety}.executor.{type, ...}}`
- `benchmark.{enabled?, questions?, maxQuestions?}`
- `repoAnalysis.{classifyGlobs?, extractClasses?}`
- `graphSinks.neo4j.{uri, username, passwordEnv, database?, vaultId?, includeClasses?, batchSize?}`
- `graph.{communityResolution?, similarityIdfFloor?, similarityEdgeCap?, godNodeLimit?, foldCommunitiesBelow?}`
- `webSearch.{providers, tasks.{deepLintProvider?, queryProvider?, exploreProvider?}}`
- `candidate.autoPromote.*`
- `redaction.{enabled?, placeholder?, useDefaults?, patterns?}`
- `freshness.{defaultHalfLifeDays?, staleThreshold?, halfLifeDaysBySourceClass?}`
- `consolidation.{enabled?, workingToEpisodic?, episodicToSemantic?, semanticToProcedural?}`
- `watch.{repoRoots?, excludeRepoRoots?}`

Unknown keys are preserved by `swarmvault migrate` but are not covered by the stability promise; they may be read by experimental code paths that change.

## MCP tools (`swarmvault mcp`)

Stable tools exposed over stdio:

`ingest`, `compile`, `query`, `explore`, `lint`, `search`, `page`, `source_list`, `candidate_list`, `promote_candidate`, `archive_candidate`, `preview_candidate_scores`, `auto_promote_candidates`, `list_approvals`, `read_approval`, `review_decision`, `blast_radius`, `list_godnodes`, `list_hyperedges`, `explain_graph`, `path_graph`, `query_graph`, `watch_status`, `consolidate`, `migrate`.

## Page frontmatter fields

Stable and **preserved** by `swarmvault migrate`:

- `page_id` (required)
- `kind` (required): `index | source | module | concept | entity | output | insight | graph_report | community_summary`
- `title`
- `tags[]`
- `source_ids[]`
- `project_ids[]`
- `node_ids[]`
- `freshness`: `fresh | stale`
- `status`
- `confidence`
- `created_at`, `updated_at`
- `compiled_from[]`
- `managed_by`: `system | human`
- `backlinks[]`
- `schema_hash`
- `source_hashes{}`
- `source_semantic_hashes{}`
- `decay_score`, `last_confirmed_at`, `superseded_by` (since 0.10.0)
- `tier`, `consolidated_from_page_ids[]`, `consolidation_confidence` (since 0.10.0)

Additions to this list are `MINOR` changes. Removals require a `MAJOR` bump and a matching `swarmvault migrate` step.

## Graph artifact (`state/graph.json`)

Stable field set on `GraphArtifact`:

- `generatedBy.{version, generatedAt}`
- `nodes[]` with `{id, label, kind, sourceIds, tags, ...}`
- `edges[]` with `{id, source, target, relation, status, evidenceClass, confidence, provenance, similarityReasons?, similarityBasis?}`
- `hyperedges[]` with `{id, relation: participate_in | implement | form, participants[]}`
- `communities[]`
- `pages[]`
- `sources[]`
- `benchmark?` with `byClass?` (since 0.11.0)

Viewer-only synthetic hub nodes (since 0.11.0) never appear in `state/graph.json`.

## State files

Stable file set in `state/`:

- `graph.json` — compiled graph artifact (above)
- `search.sqlite` — hybrid search index (regenerated by compile; may be deleted without data loss)
- `approvals/` — review bundles
- `candidates/` — staged candidate pages
- `ingest-runs/<id>.json` — per-run failure logs for `ingest --resume`
- `benchmark.json` — benchmark artifact
- `embeddings.json` — embedding cache (regenerated)
- `vault-version.json` (since 0.12.0) — last migration record

## Experimental surfaces

These may change in any minor release. Use at your own risk.

- Custom provider modules (`providers.<id>.module`)
- Custom web-search adapter modules (`webSearch.providers.<id>.module`)
- Orchestration command executors (`orchestration.roles.*.executor.command`)
- `providers.<id>.type = "local-whisper"` and its extensions (`binaryPath`, `modelPath`, `extraArgs`, `threads`) — shelling out to a user-installed `whisper.cpp` binary; the discovery, config shape, and model-download behavior may evolve as the feature graduates to stable
- `swarmvault provider setup` subcommand (added in 1.1.0) — options and prompts may change while the flow is being iterated
- Any CLI flag documented as `experimental` in `--help`

## Internal surfaces (not covered by this contract)

- Module exports from `@swarmvaultai/engine` not listed in the `@swarmvaultai/engine` package's public API. The TypeScript definitions are documentation for stable exports only.
- File layout inside `dist/` of any published package.
- The viewer's React component tree (`@swarmvaultai/viewer` ships a minimal stable surface for embedding, but internal components may change).
- Test fixtures under `packages/*/test/` and `worked/`.
- `docs/superpowers/specs/` and `wiki/outputs/` are local working documents and are not published.
