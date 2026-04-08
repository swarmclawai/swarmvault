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

![SwarmVault graph workspace](https://www.swarmvault.ai/images/screenshots/graph-workspace.png)

```bash
swarmvault init --obsidian
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault add 10.5555/example-doi
swarmvault ingest ./notes
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph query "How does auth connect to billing?"
swarmvault watch status
swarmvault watch --repo --once
swarmvault hook install
swarmvault graph serve
```

```text
my-vault/
├── swarmvault.schema.md
├── raw/                   immutable source files and localized assets
├── wiki/                  compiled source, concept, entity, code, output, and graph pages
├── state/                 graph.json, embeddings.json, search.sqlite, sessions, approvals, schedules
├── .obsidian/             optional local workspace config
└── agent/                 generated agent-facing helpers
```

## What You Get

- A markdown-first wiki that stays usable in Obsidian or plain Git
- A structured graph artifact with provenance, freshness, projects, and saved outputs
- Graph-first report pages plus deterministic local graph query, path, explain, god-node, semantic-similarity, and group-pattern surfaces
- Optional embedding-backed semantic graph query with a cached `state/embeddings.json` index and lexical fallback when no embedding provider is configured
- Automatic benchmark artifacts plus worked examples for measuring graph-guided context reduction after compile and repo-refresh runs
- Research-aware URL capture for arXiv, DOI, article, and X/Twitter sources with normalized frontmatter
- Save-first `query` and `explore` workflows, including `report`, `slides`, `chart`, and `image` outputs
- Reviewable approval and candidate queues instead of silent page mutation
- Local full-text search and a graph workspace for graph, search, preview, and review
- Project-aware schemas and rollups for larger multi-root vaults
- Repo-aware code ingestion with parser-backed module analysis and local import resolution
- Repo-aware watch mode and local git hooks for post-commit and post-checkout refreshes
- Repo-aware source classification so first-party material stays the default focus even when the repo also contains dependencies, app bundles, and generated output
- Pending semantic refresh tracking for non-code repo changes, surfaced in `watch status` and the local graph workspace
- Human-only `wiki/insights/` pages that SwarmVault can read but does not rewrite
- Session artifacts for compile, query, explore, lint, watch, and schedule runs
- CLI, MCP, and installable agent instructions for Codex, Claude Code, Cursor, Goose, Pi, Gemini CLI, OpenCode, Aider, and GitHub Copilot CLI
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

On the first successful interactive run, SwarmVault prints a one-time repo-star prompt and checks whether a newer published CLI exists. Those notices stay off for `--json`, CI, MCP, and the long-running serve/watch flows. Set `SWARMVAULT_NO_NOTICES=1` to disable them entirely.

## Quickstart

```bash
mkdir my-vault
cd my-vault
swarmvault init --obsidian
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault ingest https://example.com/article
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault add 10.5555/example-doi
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
swarmvault graph export --graphml ./exports/graph.graphml
```

You can also use the capture and automation loop:

```bash
swarmvault inbox import
swarmvault watch status
swarmvault watch --lint --repo
swarmvault hook install
```

And you can expose the vault to compatible agents over MCP:

```bash
swarmvault mcp
```

## Worked Examples

If you want something richer than a quickstart, use the small example vaults that also back the docs and release checks:

- `worked/code-repo/` for repo ingest, code pages, graph reports, and benchmark flow
- `worked/capture/` for research-aware `swarmvault add` capture
- `worked/mixed-corpus/` for compile, review, and save-first output loops

The site examples guide walks through those flows with commands and screenshots:

- https://www.swarmvault.ai/docs/getting-started/examples

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
| Aider | `swarmvault install --agent aider` |
| GitHub Copilot CLI | `swarmvault install --agent copilot` |

Codex, Goose, Pi, and OpenCode share the same canonical `AGENTS.md` managed block. Claude Code uses `CLAUDE.md`, Gemini CLI uses `GEMINI.md`, Aider uses `CONVENTIONS.md` plus `.aider.conf.yml`, GitHub Copilot CLI uses `.github/copilot-instructions.md` plus `AGENTS.md`, and Cursor writes `.cursor/rules/swarmvault.mdc`.

If you want Claude Code to bias toward SwarmVault's graph-orientation pages before broad file search, install it with:

```bash
swarmvault install --agent claude --hook
```

OpenCode and Gemini CLI also support graph-first hook installs:

```bash
swarmvault install --agent opencode --hook
swarmvault install --agent gemini --hook
```

GitHub Copilot CLI supports repository hooks too:

```bash
swarmvault install --agent copilot --hook
```

The Copilot hook is intentionally stricter than the others because the current Copilot CLI hook surface is decision-based rather than advisory: it guards broad grep/glob tool use until `wiki/graph/report.md` has been read in the current session.

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
- `swarmvault ingest <input> [--repo-root <path>] [--include <glob...>] [--exclude <glob...>] [--max-files <n>] [--include-third-party] [--include-resources] [--include-generated] [--no-gitignore] [--no-include-assets] [--max-asset-size <bytes>]`: ingest a local file path, directory path, or URL, localize remote image references by default when the input is a URL, extract PDF text locally, use the configured `visionProvider` for image-aware extraction when available, and default repo ingest to first-party material unless the extra source classes are explicitly included
- `swarmvault add <url> [--author <name>] [--contributor <name>]`: capture arXiv IDs/URLs, DOI strings/URLs, X/Twitter URLs, and generic article URLs into normalized markdown, or fall back to generic URL ingest
- `swarmvault inbox import [dir]`: import browser-clipper style bundles and inbox captures
- `swarmvault compile [--approve]`: build wiki pages, graph data, and the search index using the vault schema as guidance, or stage a review bundle before applying changes
- `swarmvault benchmark [--question "<text>" ...]`: measure graph-guided context reduction and write `state/benchmark.json`; compile and repo-refresh runs also keep the latest benchmark/report data fresh automatically
- `swarmvault query "<question>" [--no-save] [--format markdown|report|slides|chart|image]`: answer questions against the compiled vault and save the result by default
- `swarmvault explore "<question>" [--steps <n>] [--format markdown|report|slides|chart|image]`: run a save-first multi-step research loop and write a hub page plus step outputs
- `swarmvault lint [--deep] [--web]`: run structural lint, optional LLM-powered deep lint, and optional web-augmented evidence gathering
- `swarmvault schedule list|run|serve`: run configured recurring jobs for compile, lint, query, and explore
- `swarmvault watch [--lint] [--repo] [--once]`: watch the inbox, optionally refresh tracked repo roots, or run a one-shot refresh cycle
- `swarmvault watch status`: show watched repo roots plus pending semantic refresh entries for tracked non-code changes
- `swarmvault hook install|uninstall|status`: manage local git hooks that run repo-aware one-shot refreshes after checkout and commit
- `swarmvault mcp`: start a local MCP server over stdio
- `swarmvault review list|show|accept|reject`: inspect and resolve staged approval bundles
- `swarmvault candidate list|promote|archive`: inspect and resolve staged concept and entity candidates
- `swarmvault graph query "<question>" [--dfs] [--budget <n>]`: run a deterministic local graph traversal seeded from semantic graph matches when `tasks.embeddingProvider` is configured, with lexical fallback plus group-pattern matching
- `swarmvault graph path <from> <to>`: return the shortest high-confidence path between two graph targets
- `swarmvault graph explain <target>`: inspect graph metadata, community membership, neighbors, provenance, and group-pattern membership for a node or page
- `swarmvault graph god-nodes [--limit <n>]`: list the most connected bridge-heavy nodes in the current graph
- `swarmvault graph serve`: open the local graph workspace with graph, search, and page preview
- `swarmvault graph export --html|--svg|--graphml|--cypher <output>`: export the graph workspace as HTML, SVG, GraphML, or Cypher
- `swarmvault install --agent codex|claude|cursor|goose|pi|gemini|opencode|aider|copilot`: install agent-specific rules

Human-authored insight pages placed in `wiki/insights/` are indexed into search and exposed to query, but SwarmVault does not rewrite them after initialization.

When `ingest` targets a remote HTML or markdown URL, SwarmVault downloads referenced remote images into `raw/assets/<sourceId>/`, rewrites the stored markdown to local relative links, and records those files as manifest attachments. Use `--no-include-assets` to keep remote image references untouched, or `--max-asset-size` to cap the bytes fetched for a single remote asset.

For sources that produce extracted text, SwarmVault now writes both:
- `state/extracts/<sourceId>.md`: canonical extracted text used by compile, query, and benchmark
- `state/extracts/<sourceId>.json`: extractor metadata such as extractor kind, warnings, provider/model info for image vision extraction, and PDF page counts

For semantic graph query, SwarmVault can also write:
- `state/embeddings.json`: cached embedding vectors keyed by graph content hash when `tasks.embeddingProvider` is configured

When `ingest` targets a local directory, SwarmVault walks the tree recursively, respects `.gitignore` by default, records `repoRelativePath` on matching manifests, and later writes `state/code-index.json` during compile so local imports can resolve across the code graph.

Code-aware ingestion currently ships for JavaScript, TypeScript, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, and PowerShell. JavaScript and TypeScript use the TypeScript compiler API; the other shipped languages use parser-backed local analyzers that emit the same module-page and graph model.

## Compounding Loop

SwarmVault is designed so useful work compounds:

- `query` writes output pages into `wiki/outputs/` by default
- `query --no-save` keeps the answer ephemeral
- saved outputs are indexed immediately into search and the graph page registry
- saved outputs immediately refresh related source, concept, and entity pages
- `chart` and `image` saves also write local assets into `wiki/outputs/assets/<slug>/`
- compile also writes `wiki/graph/report.md`, `wiki/graph/report.json`, `wiki/graph/index.md`, and per-community graph summary pages with richer surprising-connection and group-pattern sections
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
pnpm live:oss:corpus
```

The heuristic published-package smoke lane validates saved visual outputs, project-aware code ingestion, research-aware `add` capture, benchmark artifacts, graph report generation, standalone graph exports (`html`, `svg`, `graphml`, `cypher`), review-staged scheduled query runs, watch automation plus `watch status`, richer graph workspace APIs, and MCP graph/query surfaces against the real npm install path.

The OSS corpus lane runs the published CLI against a pinned set of small public repositories so release testing exercises real repo shapes without letting provider costs or run times balloon. The default gated corpus currently covers:

- `sindresorhus/ky`
- `remarkjs/react-markdown`
- `pallets/itsdangerous`
- `necolas/normalize.css`

The installed-package heuristic lane also includes a tiny controlled fixture matrix under `smoke/fixtures/tiny-matrix/` so every shipped code language and local source kind stays covered in a cheap, repeatable run:

- code: JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, C#, C, C++, PHP, Ruby, PowerShell
- local file kinds: markdown, text, HTML, PDF, image, and code

See [docs/live-testing.md](./docs/live-testing.md) for the published-package smoke flow, OSS corpus runner, CI workflow, and the manual live checklist.

## Worked Examples

Small example vaults live under `worked/` and mirror the trust and capture workflows used in docs and smoke tests:

- `worked/code-repo/`
- `worked/mixed-corpus/`
- `worked/capture/`

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

## License

MIT
