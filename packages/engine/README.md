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
  compileVault,
  createMcpServer,
  createWebSearchAdapter,
  defaultVaultConfig,
  defaultVaultSchema,
  exploreVault,
  importInbox,
  ingestInput,
  initVault,
  installAgent,
  getWebSearchAdapterForTask,
  lintVault,
  loadVaultConfig,
  loadVaultSchema,
  queryVault,
  searchVault,
  startGraphServer,
  startMcpServer,
  watchVault,
} from "@swarmvaultai/engine";
```

The engine also exports the main runtime types for providers, graph artifacts, pages, manifests, query results, lint findings, and watch records.

## Example

```ts
import { compileVault, importInbox, initVault, loadVaultSchema, queryVault, watchVault } from "@swarmvaultai/engine";

const rootDir = process.cwd();

await initVault(rootDir);
const schema = await loadVaultSchema(rootDir);
console.log(schema.path);
await importInbox(rootDir);
await compileVault(rootDir);

const saved = await queryVault(rootDir, "What changed most recently?", true);
console.log(saved.savedTo);

const exploration = await exploreVault(rootDir, "What should I investigate next?", 3);
console.log(exploration.hubPath);

const watcher = await watchVault(rootDir, { lint: true });
```

## Schema Layer

Each workspace carries a root markdown file named `swarmvault.schema.md`.

The engine treats that file as vault-specific operating guidance for compile and query work. Currently:

- `initVault()` creates the default schema file
- `initVault()` also creates a human-only `wiki/insights/` area
- `loadVaultSchema()` resolves the canonical file and legacy `schema.md` fallback
- compile and query prompts include the schema content
- generated pages store `schema_hash`
- generated pages also carry lifecycle metadata such as `status`, `created_at`, `updated_at`, `compiled_from`, and `managed_by`
- `lintVault()` marks generated pages stale when the schema changes

## Provider Model

The engine supports:

- `heuristic`
- `openai`
- `anthropic`
- `gemini`
- `ollama`
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

This matters because many "OpenAI-compatible" backends only implement part of the OpenAI surface.

## Main Engine Surfaces

### Ingest

- `ingestInput(rootDir, input)` ingests a local path or URL
- `importInbox(rootDir, inputDir?)` recursively imports supported inbox files and browser-clipper style bundles

### Compile + Query

- `compileVault(rootDir)` writes wiki pages, graph data, and search state using the vault schema as guidance
- `queryVault(rootDir, question, save)` answers against the compiled vault using the same schema layer and can persist a first-class output page
- `exploreVault(rootDir, question, steps)` runs a save-first multi-step exploration loop and writes a hub page plus step outputs
- `searchVault(rootDir, query, limit)` searches compiled pages directly
- human-authored insight pages in `wiki/insights/` are indexed into search and available to query without being rewritten by compile

### Automation

- `watchVault(rootDir, options)` watches the inbox and appends run records to `state/jobs.ndjson`
- `lintVault(rootDir, options)` runs structural lint, optional deep lint, and optional web-augmented evidence gathering
- compile, query, explore, lint, and watch also write canonical markdown session artifacts to `state/sessions/`

### Web Search Adapters

- `createWebSearchAdapter(rootDir, id, config)` constructs a normalized web search adapter
- `getWebSearchAdapterForTask(rootDir, "deepLintProvider")` resolves the configured adapter for `lint --deep --web`

### MCP

- `createMcpServer(rootDir)` creates an MCP server instance
- `startMcpServer(rootDir)` runs the MCP server over stdio

The MCP surface includes tools for workspace info, page search, page reads, source listing, querying, ingestion, compile, and lint, along with resources for config, graph, manifests, schema, page content, and session artifacts.

## Artifacts

Running the engine produces a local workspace with these main areas:

- `swarmvault.schema.md`: vault-specific compile and query instructions
- `inbox/`: capture staging area for markdown bundles and imported files
- `raw/sources/`: immutable source copies
- `raw/assets/`: copied attachments referenced by ingested markdown bundles
- `wiki/`: generated markdown pages, saved query outputs, exploration hub pages, and a human-only `insights/` area
- `state/manifests/`: source manifests
- `state/extracts/`: extracted text
- `state/analyses/`: model analysis output
- `state/graph.json`: compiled graph
- `state/search.sqlite`: full-text index
- `state/sessions/`: canonical session artifacts
- `state/jobs.ndjson`: watch-mode automation logs

Saved outputs are indexed immediately into the graph page registry and search index, then linked back into compiled source, concept, and entity pages during later compile runs. Insight pages are indexed into search and page reads, but compile does not mutate them.

## Notes

- The engine expects Node `>=24`
- The local search layer currently uses the built-in `node:sqlite` module, which may emit an experimental warning in Node 24
- The viewer source lives in the companion `@swarmvaultai/viewer` package, and the built assets are bundled into the engine package for CLI installs

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- GitHub: https://github.com/swarmclawai/swarmvault
