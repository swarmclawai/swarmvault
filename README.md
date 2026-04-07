# SwarmVault

**A local-first knowledge compiler for AI agents.**

SwarmVault turns raw files, URLs, screenshots, PDFs, saved answers, and code into a durable working vault. Instead of losing useful work inside chat history, you get a reviewable markdown wiki, a structured graph, a local search index, session logs, and saved outputs that stay on disk.

It is built for the compounding loop most coding agents still miss:

1. ingest source material into a local workspace
2. compile it into a schema-shaped wiki and graph
3. query or explore the vault
4. save the useful results back into the vault
5. review changes instead of trusting silent rewrites

Every vault carries a user-editable `swarmvault.schema.md` file, so the compiler and query layer can learn how that specific vault should be organized.

```bash
swarmvault init --obsidian
swarmvault ingest ./notes
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph query "How does auth connect to billing?"
swarmvault watch --repo --once
swarmvault hook install
swarmvault graph serve
```

```text
my-vault/
├── swarmvault.schema.md
├── raw/                   immutable source files and localized assets
├── wiki/                  compiled source, concept, entity, code, output, and graph pages
├── state/                 graph.json, search.sqlite, sessions, approvals, schedules
├── .obsidian/             optional local workspace config
└── agent/                 generated agent-facing helpers
```

## What You Get

- A markdown-first wiki that stays usable in Obsidian or plain Git
- A structured graph artifact with provenance, freshness, projects, and saved outputs
- Graph-first report pages plus deterministic local graph query, path, explain, and god-node tools
- Save-first `query` and `explore` workflows, including `report`, `slides`, `chart`, and `image` outputs
- Reviewable approval and candidate queues instead of silent page mutation
- Local full-text search and a graph workspace for graph, search, preview, and review
- Project-aware schemas and rollups for larger multi-root vaults
- Repo-aware code ingestion with parser-backed module analysis and local import resolution
- Repo-aware watch mode and local git hooks for post-commit and post-checkout refreshes
- Human-only `wiki/insights/` pages that SwarmVault can read but does not rewrite
- Session artifacts for compile, query, explore, lint, watch, and schedule runs
- CLI, MCP, and installable agent instructions for Codex, Claude Code, Cursor, Goose, Pi, Gemini CLI, and OpenCode
- Pluggable providers including OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Groq, Together, xAI, Cerebras, generic OpenAI-compatible APIs, and custom adapters

## How It Works

SwarmVault is not a “chat with your docs” wrapper. The vault itself is the product.

- Ingest stores raw inputs immutably and localizes remote assets when needed.
- Compile turns those inputs into durable source, concept, entity, code, and output pages.
- Query and explore write useful results back into `wiki/outputs/` by default.
- Review and candidate queues keep generated changes inspectable before promotion.
- Search, graph serving, scheduling, watch mode, and MCP expose the same local artifacts instead of creating a second hidden system.

The extraction layer is intentionally split:

- deterministic parsing and source analysis where the runtime can do it locally
- provider-backed synthesis where a vault-specific schema, cross-source reasoning, or advisory linting actually benefits from a model

That keeps the durable artifacts inspectable and lets the vault improve over time instead of resetting every session.

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
swarmvault graph query "Which nodes bridge the largest communities?"
swarmvault graph path "module:src/auth.ts" "concept:billing"
swarmvault graph explain "concept:billing"
swarmvault graph god-nodes
swarmvault graph serve
swarmvault graph export --html ./exports/graph.html
```

You can also use the capture and automation loop:

```bash
swarmvault inbox import
swarmvault watch --lint --repo
swarmvault hook install
```

And you can expose the vault to compatible agents over MCP:

```bash
swarmvault mcp
```

## Platform Support

| Agent | Install target |
|-------|----------------|
| Codex | `swarmvault install --agent codex` |
| Claude Code | `swarmvault install --agent claude` |
| Cursor | `swarmvault install --agent cursor` |
| Goose | `swarmvault install --agent goose` |
| Pi | `swarmvault install --agent pi` |
| Gemini CLI | `swarmvault install --agent gemini` |
| OpenCode | `swarmvault install --agent opencode` |

Codex, Goose, Pi, and OpenCode share the same canonical `AGENTS.md` managed block. Claude Code uses `CLAUDE.md`, Gemini CLI uses `GEMINI.md`, and Cursor writes `.cursor/rules/swarmvault.mdc`.

If you want Claude Code to bias toward SwarmVault's graph-orientation pages before broad file search, install it with:

```bash
swarmvault install --agent claude --hook
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
|   |-- graph/
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
|   |-- code-index.json
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
- `swarmvault ingest <input> [--repo-root <path>] [--include <glob...>] [--exclude <glob...>] [--max-files <n>] [--no-gitignore] [--no-include-assets] [--max-asset-size <bytes>]`: ingest a local file path, directory path, or URL, and localize remote image references by default when the input is a URL
- `swarmvault inbox import [dir]`: import browser-clipper style bundles and inbox captures
- `swarmvault compile [--approve]`: build wiki pages, graph data, and the search index using the vault schema as guidance, or stage a review bundle before applying changes
- `swarmvault query "<question>" [--no-save] [--format markdown|report|slides|chart|image]`: answer questions against the compiled vault and save the result by default
- `swarmvault explore "<question>" [--steps <n>] [--format markdown|report|slides|chart|image]`: run a save-first multi-step research loop and write a hub page plus step outputs
- `swarmvault lint [--deep] [--web]`: run structural lint, optional LLM-powered deep lint, and optional web-augmented evidence gathering
- `swarmvault schedule list|run|serve`: run configured recurring jobs for compile, lint, query, and explore
- `swarmvault watch [--lint] [--repo] [--once]`: watch the inbox, optionally refresh tracked repo roots, or run a one-shot refresh cycle
- `swarmvault hook install|uninstall|status`: manage local git hooks that run repo-aware one-shot refreshes after checkout and commit
- `swarmvault mcp`: start a local MCP server over stdio
- `swarmvault review list|show|accept|reject`: inspect and resolve staged approval bundles
- `swarmvault candidate list|promote|archive`: inspect and resolve staged concept and entity candidates
- `swarmvault graph query "<question>" [--dfs] [--budget <n>]`: run a deterministic local graph traversal seeded from local search
- `swarmvault graph path <from> <to>`: return the shortest high-confidence path between two graph targets
- `swarmvault graph explain <target>`: inspect graph metadata, community membership, neighbors, and provenance for a node or page
- `swarmvault graph god-nodes [--limit <n>]`: list the most connected bridge-heavy nodes in the current graph
- `swarmvault graph serve`: open the local graph workspace with graph, search, and page preview
- `swarmvault graph export --html <output>`: export the graph workspace as a standalone HTML file
- `swarmvault install --agent codex|claude|cursor|goose|pi|gemini|opencode`: install agent-specific rules

Human-authored insight pages placed in `wiki/insights/` are indexed into search and exposed to query, but SwarmVault does not rewrite them after initialization.

When `ingest` targets a remote HTML or markdown URL, SwarmVault downloads referenced remote images into `raw/assets/<sourceId>/`, rewrites the stored markdown to local relative links, and records those files as manifest attachments. Use `--no-include-assets` to keep remote image references untouched, or `--max-asset-size` to cap the bytes fetched for a single remote asset.

When `ingest` targets a local directory, SwarmVault walks the tree recursively, respects `.gitignore` by default, records `repoRelativePath` on matching manifests, and later writes `state/code-index.json` during compile so local imports can resolve across the code graph.

Code-aware ingestion currently ships for JavaScript, TypeScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, and PowerShell. JavaScript and TypeScript use the TypeScript compiler API; the other shipped languages use parser-backed local analyzers that emit the same module-page and graph model.

## Compounding Loop

SwarmVault is designed so useful work compounds:

- `query` writes output pages into `wiki/outputs/` by default
- `query --no-save` keeps the answer ephemeral
- saved outputs are indexed immediately into search and the graph page registry
- saved outputs immediately refresh related source, concept, and entity pages
- `chart` and `image` saves also write local assets into `wiki/outputs/assets/<slug>/`
- compile also writes `wiki/graph/report.md`, `wiki/graph/index.md`, and per-community graph summary pages
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

The heuristic published-package smoke lane validates saved visual outputs, project-aware code ingestion, candidate and review workflows, graph report generation, standalone `graph export --html`, review-staged scheduled query runs, watch automation, richer graph workspace APIs, and MCP graph/query surfaces against the real npm install path.

See [docs/live-testing.md](./docs/live-testing.md) for the published-package smoke flow, CI workflow, and the manual live checklist.

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

## License

MIT
