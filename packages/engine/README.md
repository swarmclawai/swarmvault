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
  defaultVaultConfig,
  defaultVaultSchema,
  importInbox,
  ingestInput,
  initVault,
  installAgent,
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

const result = await queryVault(rootDir, "What changed most recently?", true);
console.log(result.answer);

const watcher = await watchVault(rootDir, { lint: true });
```

## Schema Layer

Each workspace carries a root markdown file named `swarmvault.schema.md`.

The engine treats that file as vault-specific operating guidance for compile and query work. In `v0.1.4`:

- `initVault()` creates the default schema file
- `loadVaultSchema()` resolves the canonical file and legacy `schema.md` fallback
- compile and query prompts include the schema content
- generated pages store `schema_hash`
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
- `queryVault(rootDir, question, save)` answers against the compiled vault using the same schema layer
- `searchVault(rootDir, query, limit)` searches compiled pages directly

### Automation

- `watchVault(rootDir, options)` watches the inbox and appends run records to `state/jobs.ndjson`
- `lintVault(rootDir)` runs health and anti-drift checks

### MCP

- `createMcpServer(rootDir)` creates an MCP server instance
- `startMcpServer(rootDir)` runs the MCP server over stdio

The MCP surface includes tools for workspace info, page search, page reads, source listing, querying, ingestion, compile, and lint, along with resources for config, graph, manifests, schema, and page content.

## Artifacts

Running the engine produces a local workspace with these main areas:

- `swarmvault.schema.md`: vault-specific compile and query instructions
- `inbox/`: capture staging area for markdown bundles and imported files
- `raw/sources/`: immutable source copies
- `raw/assets/`: copied attachments referenced by ingested markdown bundles
- `wiki/`: generated markdown pages and saved outputs
- `state/manifests/`: source manifests
- `state/extracts/`: extracted text
- `state/analyses/`: model analysis output
- `state/graph.json`: compiled graph
- `state/search.sqlite`: full-text index
- `state/jobs.ndjson`: watch-mode automation logs

## Notes

- The engine expects Node `>=24`
- The local search layer currently uses the built-in `node:sqlite` module, which may emit an experimental warning in Node 24
- The viewer source lives in the companion `@swarmvaultai/viewer` package, and the built assets are bundled into the engine package for CLI installs

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- GitHub: https://github.com/swarmclawai/swarmvault
