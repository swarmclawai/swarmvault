# @swarmvaultai/engine

`@swarmvaultai/engine` is the runtime library behind SwarmVault.

It provides the ingest, compile, query, lint, provider, graph, search, and viewer-serving primitives used by the CLI.

## Who This Is For

Use this package if you want to:

- build your own interface on top of the SwarmVault runtime
- integrate vault operations into another Node application
- customize provider loading or workspace orchestration without shelling out to the CLI

If you only want to use SwarmVault as a tool, install `@swarmvaultai/cli` instead.

## Core Exports

```ts
import {
  compileVault,
  createProvider,
  defaultVaultConfig,
  ingestInput,
  initVault,
  installAgent,
  lintVault,
  loadVaultConfig,
  queryVault,
  startGraphServer
} from "@swarmvaultai/engine";
```

The engine also exports the main runtime types for providers, graph artifacts, pages, manifests, and lint findings.

## Example

```ts
import { compileVault, ingestInput, initVault, queryVault } from "@swarmvaultai/engine";

const rootDir = process.cwd();

await initVault(rootDir);
await ingestInput(rootDir, "./research.md");
await compileVault(rootDir);

const result = await queryVault(rootDir, "What changed most recently?", true);
console.log(result.answer);
```

## Provider Model

The engine supports:

- `openai`
- `ollama`
- `anthropic`
- `gemini`
- `openai-compatible`
- `custom`
- `heuristic`

Providers are validated through capabilities such as:

- `chat`
- `structured`
- `vision`
- `tools`
- `embeddings`
- `streaming`
- `local`

This matters because many "OpenAI-compatible" providers implement only part of the OpenAI surface. The engine is designed to route by capability, not by brand name.

## Artifacts

Running the engine produces a local workspace with four main areas:

- `raw/`: immutable source inputs and captured assets
- `wiki/`: generated markdown pages and saved outputs
- `state/`: manifests, extracts, graph state, compile state, and search index
- `agent/`: generated agent rules

Important artifacts include:

- `state/graph.json`
- `state/search.sqlite`
- `wiki/index.md`
- `wiki/sources/*.md`
- `wiki/concepts/*.md`
- `wiki/entities/*.md`
- `wiki/outputs/*.md`

## Notes

- The engine expects Node `>=24`
- The local search layer currently uses the built-in `node:sqlite` module, which may emit an experimental warning in Node 24
- The graph viewer is served from the companion `@swarmvaultai/viewer` package build output
