# @swarmvaultai/engine

`@swarmvaultai/engine` is the runtime library behind SwarmVault.

It exposes the primitives for initializing a workspace, ingesting sources, importing an inbox, compiling a wiki, querying the vault, running lint, serving the graph viewer, watching the inbox, and exposing the vault over MCP.

## Who This Is For

Use this package if you want to:

- build your own interface on top of the SwarmVault runtime
- integrate vault operations into another Node application
- embed watch or MCP behavior without shelling out to the CLI
- customize provider loading or orchestration in code

If you only want to use SwarmVault as a tool, install `@swarmvaultai/cli` instead.

## Core Exports

```ts
import {
  addInput,
  addManagedSource,
  benchmarkVault,
  compileVault,
  createMcpServer,
  createWebSearchAdapter,
  deleteManagedSource,
  defaultVaultConfig,
  defaultVaultSchema,
  exploreVault,
  exportGraphFormat,
  exportGraphHtml,
  explainGraphVault,
  getWatchStatus,
  getGitHookStatus,
  importInbox,
  ingestInput,
  initVault,
  installAgent,
  installGitHooks,
  getWebSearchAdapterForTask,
  lintVault,
  listGodNodes,
  listManagedSourceRecords,
  listSchedules,
  loadVaultConfig,
  loadVaultSchema,
  loadVaultSchemas,
  pathGraphVault,
  pushGraphNeo4j,
  queryGraphVault,
  queryVault,
  reloadManagedSources,
  runWatchCycle,
  runSchedule,
  searchVault,
  serveSchedules,
  startGraphServer,
  startMcpServer,
  syncTrackedRepos,
  uninstallGitHooks,
  watchVault,
} from "@swarmvaultai/engine";
```

The engine also exports the main runtime types for providers, graph artifacts, pages, manifests, query results, lint findings, and watch records.

## Example

```ts
import {
  addInput,
  addManagedSource,
  benchmarkVault,
  compileVault,
  exploreVault,
  exportGraphHtml,
  exportGraphFormat,
  getWatchStatus,
  importInbox,
  initVault,
  installGitHooks,
  listManagedSourceRecords,
  loadVaultSchemas,
  pushGraphNeo4j,
  queryGraphVault,
  queryVault,
  reloadManagedSources,
  runWatchCycle,
  watchVault
} from "@swarmvaultai/engine";

const rootDir = process.cwd();

await initVault(rootDir, { obsidian: true });
const schemas = await loadVaultSchemas(rootDir);
console.log(schemas.root.path);
const managed = await addManagedSource(rootDir, "https://github.com/karpathy/micrograd");
console.log(managed.source.id);
await addInput(rootDir, "https://arxiv.org/abs/2401.12345");
await importInbox(rootDir);
await compileVault(rootDir, {});
const benchmark = await benchmarkVault(rootDir);
console.log(benchmark.avgQueryTokens);

const saved = await queryVault(rootDir, { question: "What changed most recently?" });
console.log(saved.savedPath);

const graphQuery = await queryGraphVault(rootDir, "Which nodes bridge the biggest communities?");
console.log(graphQuery.summary);

const exploration = await exploreVault(rootDir, { question: "What should I investigate next?", steps: 3, format: "report" });
console.log(exploration.hubPath);

await exportGraphHtml(rootDir, "./exports/graph.html");
await exportGraphFormat(rootDir, "graphml", "./exports/graph.graphml");
await pushGraphNeo4j(rootDir, {
  uri: "bolt://127.0.0.1:7687",
  username: "neo4j",
  passwordEnv: "NEO4J_PASSWORD",
  dryRun: true
});

await runWatchCycle(rootDir, { repo: true });
console.log(await getWatchStatus(rootDir));
console.log(await listManagedSourceRecords(rootDir));
await reloadManagedSources(rootDir, { all: true, compile: true });
await installGitHooks(rootDir);

const watcher = await watchVault(rootDir, { lint: true, repo: true });
```

## Schema Layer

Each workspace carries a root markdown file named `swarmvault.schema.md`.

The engine treats that file as vault-specific operating guidance for compile and query work. Currently:

- `initVault()` creates the default schema file
- `initVault()` also creates a human-only `wiki/insights/` area
- `initVault({ obsidian: true })` can also seed a minimal `.obsidian/` workspace
- `swarmvault.config.json` can define `projects` with root matching and optional per-project schema files
- compile and query prompts include the schema content
- generated pages store `schema_hash`
- generated pages also carry lifecycle metadata such as `status`, `created_at`, `updated_at`, `compiled_from`, `managed_by`, and `project_ids`
- saved visual outputs also carry `output_assets`
- `lintVault()` marks generated pages stale when the schema changes

## Provider Model

The engine supports:

- `heuristic`
- `openai`
- `anthropic`
- `gemini`
- `ollama`
- `openrouter`
- `groq`
- `together`
- `xai`
- `cerebras`
- `openai-compatible`
- `custom`

Providers are capability-driven. Each provider declares support for features such as:

- `chat`
- `structured`
- `vision`
- `tools`
- `embeddings`
- `streaming`
- `local`
- `image_generation`

This matters because many "OpenAI-compatible" backends only implement part of the OpenAI surface.

## Main Engine Surfaces

### Ingest

- `addManagedSource(rootDir, input, { compile, brief, maxPages, maxDepth })` registers and syncs a recurring source, then optionally compiles and writes a source brief
- `listManagedSourceRecords(rootDir)` lists registry-backed managed sources from `state/sources.json`
- `reloadManagedSources(rootDir, { id, all, compile, brief, maxPages, maxDepth })` re-syncs one managed source or the full registry
- `deleteManagedSource(rootDir, id)` removes a managed-source registry entry and transient sync state without deleting canonical vault artifacts
- `ingestInput(rootDir, input, { includeAssets, maxAssetSize })` ingests a local file path or URL
- `addInput(rootDir, input, { author, contributor })` captures supported URLs into normalized markdown before ingesting them, or falls back to generic URL ingest
- `ingestDirectory(rootDir, inputDir, { repoRoot, include, exclude, maxFiles, gitignore, extractClasses })` recursively ingests a local directory as a repo-aware code/content source tree
- `importInbox(rootDir, inputDir?)` recursively imports supported inbox files plus markdown and HTML browser-clipper style bundles
- managed sources support local directories, public GitHub repo root URLs, and bounded same-domain docs hubs
- registry data lives in `state/sources.json`, working state lives under `state/sources/<id>/`, and source briefs are written to `wiki/outputs/source-briefs/<id>.md`
- JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Kotlin, Scala, Lua, Zig, C#, C, C++, PHP, Ruby, and PowerShell inputs are treated as code sources and compiled into both source pages and `wiki/code/` module pages
- `.rst` and `.rest` inputs are treated as first-class text sources with lightweight heading and directive normalization before analysis
- code manifests can carry `repoRelativePath`, and compile writes `state/code-index.json` so local imports can resolve across an ingested repo tree
- repo-aware manifests, graph nodes, and graph pages can also carry `sourceClass` so first-party, third-party, resource, and generated material can be filtered and reported separately
- HTML and markdown URL ingests localize remote image references into `raw/assets/<sourceId>/` by default and rewrite the stored markdown to local relative paths
- PDF and DOCX ingests now write extracted-text and metadata sidecars under `state/extracts/`, and image ingest keeps the same sidecar model for vision extraction
- Tree-sitter-backed languages now verify runtime and grammar compatibility per language; failures stay local to the affected source and surface as diagnostics instead of aborting the whole compile

### Compile + Query

- `compileVault(rootDir, { approve })` writes wiki pages, graph data, and search state using the vault schema as guidance, or stages a review bundle
- compile also writes graph orientation pages such as `wiki/graph/report.md`, `wiki/graph/report.json`, and `wiki/graph/communities/<community>.md`
- compile propagates semantic tags onto page frontmatter and source-backed graph nodes, and records deterministic `contradicts` edges plus a Contradictions section in the graph report when conflicting claims are found
- `benchmarkVault(rootDir, { questions })` writes `state/benchmark.json` and folds the latest benchmark summary into `wiki/graph/report.md` and `wiki/graph/report.json`
- semantic graph query and embedding-backed similarity enrichment cache vectors under `state/embeddings.json` so graph-semantic refresh stays incremental
- `queryVault(rootDir, { question, save, format, review })` answers against the compiled vault using the same schema layer and saves by default
- `exploreVault(rootDir, { question, steps, format, review })` runs a save-first multi-step exploration loop and writes a hub page plus step outputs
- `searchVault(rootDir, query, limit)` searches compiled pages directly
- `queryGraphVault(rootDir, question, { traversal, budget })` runs deterministic local graph search, preferring semantic seed matches from `tasks.embeddingProvider` when configured and falling back to lexical search plus matching group patterns otherwise
- `pathGraphVault(rootDir, from, to)` returns the shortest graph path between two targets
- `explainGraphVault(rootDir, target)` returns node, community, neighbor, provenance, and group-pattern details
- `listGraphHyperedges(rootDir, target?, limit?)` returns graph hyperedges globally or for a specific node/page target
- `listGodNodes(rootDir, limit)` returns the most connected bridge-heavy graph nodes
- project-aware compile also builds `wiki/projects/index.md` plus `wiki/projects/<project>/index.md` rollups without duplicating page trees
- human-authored insight pages in `wiki/insights/` are indexed into search and available to query without being rewritten by compile
- `chart` and `image` formats save wrapper markdown pages plus local output assets under `wiki/outputs/assets/<slug>/`

### Automation

- `watchVault(rootDir, options)` watches the inbox and optionally tracked repo roots, then appends run records to `state/jobs.ndjson`
- `runWatchCycle(rootDir, options)` runs the same inbox/repo refresh logic once without starting a watcher
- `getWatchStatus(rootDir)` reads the latest watch-status artifact plus pending semantic refresh entries
- `syncTrackedRepos(rootDir)` refreshes previously ingested repo roots, updates changed manifests, and removes deleted repo manifests
- `syncTrackedReposForWatch(rootDir)` is the repo-watch sync path that defers non-code semantic refresh into `state/watch/`
- large ingest and compile passes emit low-noise progress on TTYs, and report presentation rolls up tiny fragmented communities without mutating the canonical graph artifact
- `installGitHooks(rootDir)`, `uninstallGitHooks(rootDir)`, and `getGitHookStatus(rootDir)` manage local `post-commit` and `post-checkout` hook blocks for the nearest git repository
- `installAgent(rootDir, agent, { hook })` writes agent instructions and returns the primary `target`, all touched `targets`, and optional merge warnings for agents such as Aider
- `lintVault(rootDir, options)` runs structural lint, optional deep lint, optional contradiction-only filtering through `{ conflicts: true }`, and optional web-augmented evidence gathering
- `listSchedules(rootDir)`, `runSchedule(rootDir, jobId)`, and `serveSchedules(rootDir)` manage recurring local jobs from config
- compile, query, explore, lint, and watch also write canonical markdown session artifacts to `state/sessions/`
- scheduled `query` and `explore` jobs stage saved outputs through approvals when they write artifacts
- optional orchestration roles can enrich `lint`, `explore`, and compile post-pass behavior without bypassing the approval flow

### Web Search Adapters

- `createWebSearchAdapter(rootDir, id, config)` constructs a normalized web search adapter
- `getWebSearchAdapterForTask(rootDir, "deepLintProvider")` resolves the configured adapter for `lint --deep --web`

### MCP

- `createMcpServer(rootDir)` creates an MCP server instance
- `startMcpServer(rootDir)` runs the MCP server over stdio
- `exportGraphHtml(rootDir, outputPath)` exports the graph workspace as a standalone HTML file
- `exportGraphFormat(rootDir, "svg" | "graphml" | "cypher", outputPath)` exports the graph into interoperable file formats
- `pushGraphNeo4j(rootDir, options)` upserts the current graph into Neo4j over Bolt/Aura with shared-database-safe `vaultId` namespacing

The MCP surface includes tools for workspace info, page search, page reads, source listing, querying, ingestion, compile, lint, graph report reads, hyperedge reads, and graph-native read operations such as graph query, node explain, neighbor lookup, shortest path, and god-node listing, along with resources for config, graph, manifests, schema, page content, and session artifacts.

## Artifacts

Running the engine produces a local workspace with these main areas:

- `swarmvault.schema.md`: vault-specific compile and query instructions
- `inbox/`: capture staging area for markdown bundles and imported files
- `raw/sources/`: immutable source copies
- `raw/assets/`: copied attachments referenced by ingested markdown bundles and remote URL ingests
- `wiki/`: generated markdown pages, the append-only `log.md` activity trail, staged candidates, saved query outputs, exploration hub pages, and a human-only `insights/` area
- `wiki/graph/`: generated graph report pages and per-community summaries derived from `state/graph.json`
- `wiki/graph/report.json`: machine-readable graph report data used by the viewer and export surfaces
- `wiki/outputs/assets/`: local chart/image artifacts and JSON manifests for saved visual outputs
- `wiki/code/`: generated module pages for ingested code sources
- `wiki/projects/`: generated project rollups over canonical pages
- `wiki/candidates/`: staged concept and entity pages awaiting confirmation on a later compile
- `state/manifests/`: source manifests
- `state/sources.json`: managed-source registry state
- `state/sources/`: managed-source working state such as GitHub checkouts and crawl metadata
- `state/extracts/`: extracted markdown plus JSON sidecars describing extractor kind, warnings, PDF page counts, and image-vision metadata
- `state/analyses/`: model analysis output
- `state/code-index.json`: repo-aware code module aliases and local resolution data
- `state/benchmark.json`: latest benchmark/trust summary for the current vault
- `state/graph.json`: compiled graph, including semantic-similarity edges and hyperedge-style group patterns
- `state/search.sqlite`: full-text index
- `state/sessions/`: canonical session artifacts
- `state/approvals/`: staged review bundles from `compileVault({ approve: true })`
- `state/schedules/`: persisted schedule state and leases
- `state/watch/`: watch-status and pending semantic refresh artifacts for repo automation
- `state/jobs.ndjson`: watch-mode automation logs

Saved outputs are indexed immediately into the graph page registry and search index, then linked back into compiled source, concept, and entity pages immediately through the lightweight artifact sync path. New concept and entity pages stage into `wiki/candidates/` first and promote to active pages on the next matching compile. Insight pages are indexed into search and page reads, but compile does not mutate them. Project-scoped pages receive `project_ids`, project tags, and layered root-plus-project schema hashes when all contributing sources resolve to the same configured project.
Code sources also emit module, symbol, and parser-backed rationale nodes into `state/graph.json`, so local imports, exports, inheritance, same-module call edges, and rationale links are queryable through the same viewer and search pipeline.
Ingest, inbox import, compile, query, lint, review, and candidate operations also append human-readable entries to `wiki/log.md`.
PDF sources now go through a local text-extraction pass before analysis, and image sources use the configured `visionProvider` for structured OCR/diagram extraction when a real multimodal provider is available. When image extraction is unavailable, SwarmVault records an explicit warning in the extraction sidecar and carries that warning forward into analysis instead of silently treating the source as empty.
Compile and repo-refresh runs also keep benchmark artifacts current by default, so graph report consumers can show freshness and stale-state without requiring a separate benchmark command first. The graph report now also carries deterministic “why this is surprising” explanations plus group-pattern sections built from hyperedges.

## Notes

- The engine expects Node `>=24`
- The local search layer currently uses the built-in `node:sqlite` module, which may emit an experimental warning in Node 24
- The viewer source lives in the companion `@swarmvaultai/viewer` package, and the built assets are bundled into the engine package for CLI installs

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- GitHub: https://github.com/swarmclawai/swarmvault
