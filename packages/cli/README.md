# @swarmvaultai/cli

`@swarmvaultai/cli` is the globally installable entry point for SwarmVault.

It gives you the `swarmvault` command for creating and operating a local-first LLM knowledge vault that compiles into markdown, graph data, and local search artifacts.

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
swarmvault ingest ./notes.md
swarmvault compile
swarmvault query "What themes keep recurring?" --save
swarmvault graph serve
```

## Commands

### `swarmvault init`

Creates a new SwarmVault workspace in the current directory, including:

- `raw/`
- `wiki/`
- `state/`
- `agent/`
- `swarmvault.config.json`

### `swarmvault ingest <path-or-url>`

Adds a local file or URL to the vault and records a manifest in `state/manifests/`.

### `swarmvault compile`

Compiles the current manifests into:

- generated markdown in `wiki/`
- structured graph data in `state/graph.json`
- local search data in `state/search.sqlite`

### `swarmvault query "<question>" [--save]`

Queries the compiled vault. Use `--save` to write the result into `wiki/outputs/` so the answer becomes part of the vault.

### `swarmvault lint`

Runs anti-drift checks and other health checks against the current vault state.

### `swarmvault graph serve`

Starts the local graph UI backed by `state/graph.json`.

### `swarmvault install --agent <codex|claude|cursor>`

Writes agent-specific rules into the current project so your coding agent understands the SwarmVault directory contract and workflow.

## Provider Configuration

SwarmVault defaults to a local heuristic provider so the CLI can run without API keys, but real vaults should usually point at an actual model provider.

Inside an existing `swarmvault.config.json`, your `providers` and `tasks` sections can look like this:

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

Generic OpenAI-compatible APIs are also supported through config alone when the provider follows the same request shape closely enough.

## Troubleshooting

- If `graph serve` says the viewer build is missing, run `pnpm build` in the repository first
- If a provider claims OpenAI compatibility but fails structured generation, declare only the capabilities it actually supports
- Node 24 may emit an experimental warning for `node:sqlite`; this is expected in the current release
