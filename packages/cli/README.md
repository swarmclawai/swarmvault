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
swarmvault init --obsidian
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault ingest ./repo
swarmvault compile
swarmvault query "What keeps recurring?"
swarmvault query "Turn this into slides" --format slides
swarmvault explore "What should I research next?" --steps 3
swarmvault lint --deep
swarmvault graph query "Which nodes bridge the biggest clusters?"
swarmvault graph explain "concept:drift"
swarmvault watch --repo --once
swarmvault hook install
swarmvault graph serve
swarmvault graph export --html ./exports/graph.html
```

## Commands

### `swarmvault init [--obsidian]`

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
- optional `.obsidian/` workspace files when `--obsidian` is passed

The schema file is the vault-specific instruction layer. Edit it to define naming rules, categories, grounding expectations, and exclusions before a serious compile.

### `swarmvault ingest <path-or-url>`

Ingest a local file path, directory path, or URL into immutable source storage and write manifests to `state/manifests/`.

- local directories recurse by default
- directory ingest respects `.gitignore` unless you pass `--no-gitignore`
- repo-aware directory ingest records `repoRelativePath` and later compile writes `state/code-index.json`
- URL ingest still localizes remote image references by default
- code-aware directory ingest currently covers JavaScript, TypeScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, and PowerShell

Useful flags:

- `--repo-root <path>`
- `--include <glob...>`
- `--exclude <glob...>`
- `--max-files <n>`
- `--no-gitignore`
- `--no-include-assets`
- `--max-asset-size <bytes>`

### `swarmvault inbox import [dir]`

Import supported files from the configured inbox directory. This is meant for browser-clipper style markdown bundles and other capture workflows. Local image and asset references are preserved and copied into canonical storage under `raw/assets/`.

### `swarmvault compile [--approve]`

Compile the current manifests into:

- generated markdown in `wiki/`
- structured graph data in `state/graph.json`
- local search data in `state/search.sqlite`

The compiler also reads `swarmvault.schema.md` and records a `schema_hash` plus lifecycle metadata such as `status`, `created_at`, `updated_at`, `compiled_from`, and `managed_by` in generated pages so schema edits can mark pages stale without losing lifecycle state.

For ingested code trees, compile also writes `state/code-index.json` so local imports and module aliases can resolve across the repo-aware code graph.

New concept and entity pages are staged into `wiki/candidates/` first. A later matching compile promotes them into `wiki/concepts/` or `wiki/entities/`.

With `--approve`, compile writes a staged review bundle into `state/approvals/` without applying active wiki changes.

### `swarmvault review list|show|accept|reject`

Inspect and resolve staged approval bundles created by `swarmvault compile --approve`.

- `review list` shows pending, accepted, and rejected entry counts per bundle
- `review show <approvalId>` shows each staged entry plus its current and staged content
- `review accept <approvalId> [targets...]` applies pending entries to the live wiki
- `review reject <approvalId> [targets...]` marks pending entries as rejected without mutating active wiki paths

Targets can be page ids such as `concept:approval-concept` or relative wiki paths such as `concepts/approval-concept.md`.

### `swarmvault candidate list|promote|archive`

Inspect and resolve staged concept and entity candidates.

- `candidate list` shows every current candidate plus its active destination path
- `candidate promote <target>` promotes a candidate immediately into `wiki/concepts/` or `wiki/entities/`
- `candidate archive <target>` removes a candidate from the staged set

Targets can be page ids or relative paths under `wiki/candidates/`.

### `swarmvault query "<question>" [--no-save] [--format markdown|report|slides|chart|image]`

Query the compiled vault. The query layer also reads `swarmvault.schema.md`, so answers follow the vault’s own structure and grounding rules.

By default, the answer is written into `wiki/outputs/` and immediately registered in:

- `wiki/index.md`
- `wiki/outputs/index.md`
- `state/graph.json`
- `state/search.sqlite`

Saved outputs also carry related page, node, and source metadata so SwarmVault can refresh related source, concept, and entity pages immediately.

Human-authored pages in `wiki/insights/` are also indexed into search and query context, but SwarmVault does not rewrite them after initialization.

### `swarmvault explore "<question>" [--steps <n>] [--format markdown|report|slides|chart|image]`

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

### `swarmvault watch [--lint] [--repo] [--once] [--debounce <ms>]`

Watch the inbox directory and trigger import and compile cycles when files change. With `--repo`, each cycle also refreshes tracked repo roots that were previously ingested through directory ingest. With `--once`, SwarmVault runs one refresh cycle immediately instead of starting a long-running watcher. With `--lint`, each cycle also runs linting. Each cycle writes a canonical session artifact to `state/sessions/`, and compatibility run metadata is still appended to `state/jobs.ndjson`.

### `swarmvault hook install|uninstall|status`

Manage SwarmVault's local git hook blocks for the nearest git repository.

- `hook install` writes marker-based `post-commit` and `post-checkout` hooks
- `hook uninstall` removes only the SwarmVault-managed hook block
- `hook status` reports whether those managed hook blocks are installed

The installed hooks run `swarmvault watch --repo --once` from the vault root so repo-aware source changes are re-ingested and recompiled after commit and checkout.

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

Start the local graph workspace backed by `state/graph.json`, `/api/search`, `/api/page`, and local graph query/path/explain endpoints.

### `swarmvault graph query "<question>" [--dfs] [--budget <n>]`

Run a deterministic local graph traversal seeded from local search and graph labels.

### `swarmvault graph path <from> <to>`

Return the shortest high-confidence path between two graph targets.

### `swarmvault graph explain <target>`

Inspect graph metadata, community membership, neighbors, and provenance for a node or page.

### `swarmvault graph god-nodes [--limit <n>]`

List the most connected bridge-heavy nodes in the current graph.

### `swarmvault graph export --html <output>`

Export the graph workspace as a standalone HTML file with embedded graph and page data for offline sharing. The exported file keeps read-only graph browsing, search, and page preview. The live graph query/path/explain actions remain part of `graph serve` and the MCP surface.

### `swarmvault install --agent <codex|claude|cursor|goose|pi|gemini|opencode>`

Install agent-specific rules into the current project so an agent understands the SwarmVault workspace contract and workflow.

For Claude Code, you can also install the recommended graph-first pre-search hook:

```bash
swarmvault install --agent claude --hook
```

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
