# SwarmVault

SwarmVault is a local-first LLM knowledge compiler.

It takes raw research inputs such as markdown, PDFs, images, and URLs, stores them immutably, and compiles them into a persistent markdown wiki, a structured graph, and a local search index. Instead of losing work inside chat history, your summaries, query outputs, and graph structure stay on disk as reviewable artifacts.

Each vault also carries a user-editable schema file, `swarmvault.schema.md`, which teaches the compiler and query layer how that vault should be organized.

## What It Does

SwarmVault is designed around a simple loop:

1. Ingest source material into a local workspace
2. Edit the vault schema to define naming rules, categories, and grounding expectations
3. Compile those sources into `wiki/` and `state/graph.json`
4. Query the compiled vault and optionally save answers back into the wiki
5. Keep the vault healthy with linting, inbox automation, and MCP access

The open source runtime gives you:

- Markdown-first outputs that stay usable in Obsidian or plain Git
- A structured graph artifact for relationships, provenance, and freshness
- A vault-specific schema file that guides compile and query behavior
- Local full-text search over compiled pages
- CLI workflows for ingest, inbox import, compile, query, lint, watch, MCP, and graph serving
- Pluggable model providers, including OpenAI, Anthropic, Gemini, Ollama, generic OpenAI-compatible APIs, and custom adapters

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
swarmvault init
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault compile
swarmvault query "What are the main ideas?" --save
swarmvault graph serve
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
|   |-- sources/
|   |-- concepts/
|   |-- entities/
|   `-- outputs/
|-- state/
|   |-- manifests/
|   |-- extracts/
|   |-- analyses/
|   |-- graph.json
|   |-- search.sqlite
|   `-- jobs.ndjson
`-- agent/
```

## Schema Layer

Every vault carries a root schema file:

```text
swarmvault.schema.md
```

This is a markdown instruction layer, not a separate DSL. In `v0.1.4`, SwarmVault reads that file during compile and query so each vault can define its own:

- naming rules
- concept and entity categories
- relationship expectations
- grounding and citation requirements
- exclusions and scope boundaries

Generated pages include a `schema_hash` in frontmatter, which lets lint mark pages stale when the schema changes.

## Core Commands

- `swarmvault init`: create a workspace, default config, and default schema file
- `swarmvault ingest <input>`: ingest a local file path or URL
- `swarmvault inbox import [dir]`: import browser-clipper style bundles and inbox captures
- `swarmvault compile`: build wiki pages, graph data, and the search index using the vault schema as guidance
- `swarmvault query "<question>" --save`: answer questions and optionally persist them into `wiki/outputs/`, guided by the vault schema
- `swarmvault lint`: run anti-drift and health checks
- `swarmvault watch --lint`: watch the inbox and run import/compile cycles on changes
- `swarmvault mcp`: start a local MCP server over stdio
- `swarmvault graph serve`: open the local graph viewer
- `swarmvault install --agent codex|claude|cursor`: install agent-specific rules

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
      "capabilities": ["chat", "structured"]
    }
  },
  "tasks": {
    "compileProvider": "primary",
    "queryProvider": "primary",
    "lintProvider": "primary",
    "visionProvider": "primary"
  }
}
```

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

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault

## License

MIT
