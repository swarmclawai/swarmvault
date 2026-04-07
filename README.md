# SwarmVault

SwarmVault is a local-first LLM knowledge compiler.

It takes raw research inputs such as markdown, PDFs, images, and URLs, stores them immutably, and compiles them into a persistent markdown wiki, a structured graph, and a local search index. Instead of losing work inside chat history, your summaries, query outputs, exploration runs, and graph structure stay on disk as reviewable artifacts.

Each vault also carries a user-editable schema file, `swarmvault.schema.md`, which teaches the compiler and query layer how that vault should be organized.

## What It Does

SwarmVault is designed around a simple loop:

1. Ingest source material into a local workspace
2. Edit the vault schema to define naming rules, categories, and grounding expectations
3. Compile those sources into `wiki/` and `state/graph.json`
4. Query or explore the compiled vault and save useful answers back into the wiki
5. Keep the vault healthy with linting, inbox automation, and MCP access

The open source runtime gives you:

- Markdown-first outputs that stay usable in Obsidian or plain Git
- A structured graph artifact for relationships, provenance, and freshness
- A vault-specific schema file that guides compile and query behavior
- Human-only insight pages in `wiki/insights/` that SwarmVault can read but does not rewrite
- Visual output artifacts that save wrapper markdown pages plus local chart/image assets
- Local full-text search over compiled pages
- Canonical session artifacts in `state/sessions/` for compile, query, explore, lint, and watch runs
- CLI workflows for ingest, inbox import, compile, query, explore, lint, scheduling, watch, MCP, and graph serving
- Pluggable model providers, including OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Groq, Together, xAI, Cerebras, generic OpenAI-compatible APIs, and custom adapters
- Optional role orchestration for research, audit, context, and safety work
- Optional web-search augmentation for deep lint findings

## Install

SwarmVault requires Node `>=24`.

```bash
npm install -g @swarmvaultai/cli
```

This installs the `swarmvault` command. The `vault` alias is also available for compatibility.

## Quickstart

```bash
mkdir my-vault
cd my-vault
swarmvault init --obsidian
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault ingest https://example.com/article
swarmvault compile
swarmvault query "What are the main ideas?"
swarmvault query "Turn this into slides" --format slides
swarmvault query "Show this as a chart" --format chart
swarmvault explore "What should I investigate next?" --steps 3
swarmvault lint --deep
swarmvault schedule list
swarmvault review list
swarmvault candidate list
swarmvault graph serve
swarmvault graph export --html ./exports/graph.html
```

You can also use the capture and automation loop:

```bash
swarmvault inbox import
swarmvault watch --lint
```

And you can expose the vault to compatible agents over MCP:

```bash
swarmvault mcp
```

## Workspace Layout

After `swarmvault init`, the workspace looks like this:

```text
my-vault/
|-- swarmvault.config.json
|-- swarmvault.schema.md
|-- inbox/
|-- raw/
|   |-- sources/
|   `-- assets/
|-- wiki/
|   |-- index.md
|   |-- log.md
|   |-- candidates/
|   |-- code/
|   |-- insights/
|   |-- projects/
|   |-- sources/
|   |-- concepts/
|   |-- entities/
|   `-- outputs/
|       |-- assets/
|       `-- index.md
|-- state/
|   |-- manifests/
|   |-- extracts/
|   |-- analyses/
|   |-- graph.json
|   |-- search.sqlite
|   |-- sessions/
|   |-- approvals/
|   |-- schedules/
|   `-- jobs.ndjson
|-- .obsidian/
`-- agent/
```

## Schema Layer

Every vault carries a root schema file:

```text
swarmvault.schema.md
```

This is a markdown instruction layer, not a separate DSL. SwarmVault reads that file during compile and query so each vault can define its own:

- naming rules
- concept and entity categories
- relationship expectations
- grounding and citation requirements
- exclusions and scope boundaries

Generated pages include a `schema_hash` in frontmatter, which lets lint mark pages stale when the schema changes.

Generated source, concept, entity, output, and index pages also carry lifecycle fields such as `status`, `created_at`, `updated_at`, `compiled_from`, and `managed_by`.

## Core Commands

- `swarmvault init [--obsidian]`: create a workspace, default config, default schema file, and optional `.obsidian/` config
- `swarmvault ingest <input> [--no-include-assets] [--max-asset-size <bytes>]`: ingest a local file path or URL, and localize remote image references by default when the input is a URL
- `swarmvault inbox import [dir]`: import browser-clipper style bundles and inbox captures
- `swarmvault compile [--approve]`: build wiki pages, graph data, and the search index using the vault schema as guidance, or stage a review bundle before applying changes
- `swarmvault query "<question>" [--no-save] [--format markdown|report|slides|chart|image]`: answer questions against the compiled vault and save the result by default
- `swarmvault explore "<question>" [--steps <n>] [--format markdown|report|slides|chart|image]`: run a save-first multi-step research loop and write a hub page plus step outputs
- `swarmvault lint [--deep] [--web]`: run structural lint, optional LLM-powered deep lint, and optional web-augmented evidence gathering
- `swarmvault schedule list|run|serve`: run configured recurring jobs for compile, lint, query, and explore
- `swarmvault watch --lint`: watch the inbox and run import/compile cycles on changes
- `swarmvault mcp`: start a local MCP server over stdio
- `swarmvault review list|show|accept|reject`: inspect and resolve staged approval bundles
- `swarmvault candidate list|promote|archive`: inspect and resolve staged concept and entity candidates
- `swarmvault graph serve`: open the local graph workspace with graph, search, and page preview
- `swarmvault graph export --html <output>`: export the graph workspace as a standalone HTML file
- `swarmvault install --agent codex|claude|cursor|goose|pi|gemini|opencode`: install agent-specific rules

Human-authored insight pages placed in `wiki/insights/` are indexed into search and exposed to query, but SwarmVault does not rewrite them after initialization.

When `ingest` targets a remote HTML or markdown URL, SwarmVault downloads referenced remote images into `raw/assets/<sourceId>/`, rewrites the stored markdown to local relative links, and records those files as manifest attachments. Use `--no-include-assets` to keep remote image references untouched, or `--max-asset-size` to cap the bytes fetched for a single remote asset.

## Compounding Loop

SwarmVault is designed so useful work compounds:

- `query` writes output pages into `wiki/outputs/` by default
- `query --no-save` keeps the answer ephemeral
- saved outputs are indexed immediately into search and the graph page registry
- saved outputs immediately refresh related source, concept, and entity pages
- `chart` and `image` saves also write local assets into `wiki/outputs/assets/<slug>/`
- new concept and entity pages land in `wiki/candidates/` first, then promote on the next matching compile
- `review` turns `compile --approve` bundles into a local accept/reject workflow instead of a dead-end staging directory
- `candidate` lets you promote or archive staged concept and entity pages without waiting for another compile
- `explore` chains several saved queries together and writes a hub page you can revisit
- scheduled `query` and `explore` jobs stage saved output pages through approvals instead of activating them immediately
- `lint --deep` can suggest missing citations, coverage gaps, candidate pages, and follow-up questions without mutating the vault
- orchestration roles can add audit, safety, context, and research feedback without bypassing the approval flow
- compile, query, explore, lint, and watch each write a session artifact to `state/sessions/`
- ingest and inbox import also append to the canonical `wiki/log.md` activity log

## Why This Exists

Most "chat with your docs" tools answer a question and then throw away the work. SwarmVault treats the vault itself as the product. The markdown pages, saved outputs, graph edges, manifests, schema rules, and freshness state are durable artifacts you can inspect, diff, and keep improving.

## Providers

SwarmVault routes by capability, not by brand name.

Built-in provider types:

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

Example provider config:

```json
{
  "providers": {
    "primary": {
      "type": "openai-compatible",
      "baseUrl": "https://your-provider.example/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-4.1-mini",
      "apiStyle": "chat",
      "capabilities": ["chat", "structured", "image_generation"]
    }
  },
  "tasks": {
    "compileProvider": "primary",
    "queryProvider": "primary",
    "lintProvider": "primary",
    "visionProvider": "primary",
    "imageProvider": "primary"
  }
}
```

## Web Search For Deep Lint

`swarmvault lint --deep --web` uses a separate `webSearch` config block instead of the normal LLM provider registry.

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

If `--web` is requested without a configured web-search provider, SwarmVault fails clearly instead of silently skipping evidence gathering.

## Packages

- `@swarmvaultai/cli`: the globally installable CLI
- `@swarmvaultai/engine`: the runtime library behind ingest, compile, query, lint, watch, and MCP
- `@swarmvaultai/viewer`: the graph viewer package used by `swarmvault graph serve`

## Current Notes

- The default `heuristic` provider is meant for local smoke tests and offline defaults, not serious synthesis quality
- The local search layer uses Node's built-in `node:sqlite`, which may emit an experimental warning in Node 24
- The graph viewer is included in the CLI flow; users do not need to install the viewer package separately

## Development

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

Live smoke checks for the published package:

```bash
pnpm live:smoke:heuristic
pnpm live:smoke:ollama
OPENAI_API_KEY=... pnpm live:smoke:openai
```

The heuristic published-package smoke lane validates saved visual outputs, project-aware code ingestion, candidate and review workflows, standalone `graph export --html`, review-staged scheduled query runs, watch automation, richer graph workspace APIs, and MCP search/chart queries against the real npm install path.

See [docs/live-testing.md](./docs/live-testing.md) for the published-package smoke flow, CI workflow, and the manual live checklist.

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

## License

MIT
