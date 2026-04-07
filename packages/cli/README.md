# @swarmvaultai/cli

`@swarmvaultai/cli` is the global command-line entry point for SwarmVault.

It gives you the `swarmvault` command for building a local-first knowledge vault from files, URLs, browser clips, saved query outputs, and guided exploration runs.

## Install

SwarmVault requires Node `>=24`.

```bash
npm install -g @swarmvaultai/cli
```

Installed commands:

- `swarmvault`
- `vault` as a compatibility alias

## First Run

```bash
mkdir my-vault
cd my-vault
swarmvault init
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault compile
swarmvault query "What keeps recurring?" --save
swarmvault explore "What should I research next?" --steps 3
swarmvault lint --deep
swarmvault graph serve
```

## Commands

### `swarmvault init`

Create a workspace with:

- `inbox/`
- `raw/`
- `wiki/`
- `wiki/insights/`
- `state/`
- `state/sessions/`
- `agent/`
- `swarmvault.config.json`
- `swarmvault.schema.md`

The schema file is the vault-specific instruction layer. Edit it to define naming rules, categories, grounding expectations, and exclusions before a serious compile.

### `swarmvault ingest <path-or-url>`

Ingest a local file path or URL into immutable source storage and write a manifest to `state/manifests/`.

### `swarmvault inbox import [dir]`

Import supported files from the configured inbox directory. This is meant for browser-clipper style markdown bundles and other capture workflows. Local image and asset references are preserved and copied into canonical storage under `raw/assets/`.

### `swarmvault compile`

Compile the current manifests into:

- generated markdown in `wiki/`
- structured graph data in `state/graph.json`
- local search data in `state/search.sqlite`

The compiler also reads `swarmvault.schema.md` and records a `schema_hash` plus lifecycle metadata such as `status`, `created_at`, `updated_at`, `compiled_from`, and `managed_by` in generated pages so schema edits can mark pages stale without losing lifecycle state.

### `swarmvault query "<question>" [--save]`

Query the compiled vault. The query layer also reads `swarmvault.schema.md`, so answers follow the vault’s own structure and grounding rules.

With `--save`, the answer is written into `wiki/outputs/` and immediately registered in:

- `wiki/index.md`
- `wiki/outputs/index.md`
- `state/graph.json`
- `state/search.sqlite`

Saved outputs also carry related page, node, and source metadata so later compiles can link them back into the wiki.

Human-authored pages in `wiki/insights/` are also indexed into search and query context, but SwarmVault does not rewrite them after initialization.

### `swarmvault explore "<question>" [--steps <n>]`

Run a save-first multi-step research loop.

Each step:

- queries the vault
- saves the answer into `wiki/outputs/`
- generates follow-up questions
- chooses the next follow-up deterministically

The command also writes a hub page linking the root question, saved step pages, and generated follow-up questions.

### `swarmvault lint [--deep] [--web]`

Run anti-drift and vault health checks such as stale pages, missing graph artifacts, and other structural issues.

`--deep` adds an LLM-powered advisory pass that can report:

- `coverage_gap`
- `contradiction_candidate`
- `missing_citation`
- `candidate_page`
- `follow_up_question`

`--web` can only be used with `--deep`. It enriches deep-lint findings with external evidence snippets and URLs from a configured web-search provider.

### `swarmvault watch [--lint] [--debounce <ms>]`

Watch the inbox directory and trigger import and compile cycles when files change. With `--lint`, each cycle also runs linting. Each cycle writes a canonical session artifact to `state/sessions/`, and compatibility run metadata is still appended to `state/jobs.ndjson`.

### `swarmvault mcp`

Run SwarmVault as a local MCP server over stdio. This exposes the vault to compatible clients and agents through tools and resources such as:

- `workspace_info`
- `search_pages`
- `read_page`
- `list_sources`
- `query_vault`
- `ingest_input`
- `compile_vault`
- `lint_vault`

The MCP surface also exposes `swarmvault://schema`, `swarmvault://sessions`, `swarmvault://sessions/{path}`, and includes `schemaPath` in `workspace_info`.

### `swarmvault graph serve`

Start the local graph UI backed by `state/graph.json`.

### `swarmvault install --agent <codex|claude|cursor>`

Install agent-specific rules into the current project so an agent understands the SwarmVault workspace contract and workflow.

## Provider Configuration

SwarmVault defaults to a local `heuristic` provider so the CLI works without API keys, but real vaults will usually point at an actual model provider.

Example:

```json
{
  "providers": {
    "ollama-local": {
      "type": "ollama",
      "model": "qwen3:latest",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "capabilities": ["chat", "structured", "vision", "local"]
    }
  },
  "tasks": {
    "compileProvider": "ollama-local",
    "queryProvider": "ollama-local",
    "lintProvider": "ollama-local",
    "visionProvider": "ollama-local"
  }
}
```

Generic OpenAI-compatible APIs are supported through config when the provider follows the OpenAI request shape closely enough.

Deep lint web augmentation uses a separate `webSearch` config block. Example:

```json
{
  "webSearch": {
    "providers": {
      "evidence": {
        "type": "http-json",
        "endpoint": "https://search.example/api/search",
        "method": "GET",
        "apiKeyEnv": "SEARCH_API_KEY",
        "apiKeyHeader": "Authorization",
        "apiKeyPrefix": "Bearer ",
        "queryParam": "q",
        "limitParam": "limit",
        "resultsPath": "results",
        "titleField": "title",
        "urlField": "url",
        "snippetField": "snippet"
      }
    },
    "tasks": {
      "deepLintProvider": "evidence"
    }
  }
}
```

## Troubleshooting

- If you are running from a source checkout and `graph serve` says the viewer build is missing, run `pnpm build` in the repository first
- If a provider claims OpenAI compatibility but fails structured generation, declare only the capabilities it actually supports
- If `lint --deep --web` fails immediately, make sure a `webSearch` provider is configured and mapped to `tasks.deepLintProvider`
- Node 24 may emit an experimental warning for `node:sqlite`; that is expected in the current release

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- GitHub: https://github.com/swarmclawai/swarmvault
