# SwarmVault Skill

Use the SwarmVault skill when you want a local-first knowledge vault that compiles books, articles, notes, datasets, spreadsheets, slide decks, screenshots, URLs, code, and research captures into durable markdown pages, a searchable graph, and reviewable outputs on disk.

SwarmVault is inspired by Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) gist, then extended into a local toolchain with graph/search artifacts, review flows, automation, and optional provider-backed synthesis.

## Install

Install the skill from ClawHub:

```bash
clawhub install swarmvault
```

Install the CLI it depends on:

```bash
npm install -g @swarmvaultai/cli
swarmvault --version
swarmvault source add https://github.com/karpathy/micrograd
```

Requirements:

- Node `>=24`
- A working `swarmvault` or `vault` binary on `PATH`

Update paths:

```bash
clawhub update swarmvault
npm install -g @swarmvaultai/cli@latest
```

## When To Use This Skill

- You want knowledge work to stay on disk instead of disappearing into chat history.
- The repo already contains `swarmvault.config.json` or `swarmvault.schema.md`.
- You want markdown wiki pages, graph artifacts, local search, approvals, candidates, and MCP exposure from the same workspace.
- You want a save-first compile/query/review loop for source collections, codebases, or research material.
- You want one workflow for mixed non-code material such as EPUBs, CSV/TSV files, XLSX workbooks, and PPTX decks.

## Quickstart

```bash
swarmvault init --obsidian
swarmvault source add https://github.com/karpathy/micrograd
swarmvault ingest ./src --repo-root .
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph serve
swarmvault mcp
```

For very large graphs, `swarmvault graph serve` and `swarmvault graph export --html` automatically start in overview mode. Add `--full` when you explicitly want the full canvas rendered.

The default `heuristic` provider is a valid local/offline starting point. Add a model provider in `swarmvault.config.json` when you want richer synthesis quality or optional capabilities such as embeddings, vision, or image generation.

For local semantic graph query without API keys, point `tasks.embeddingProvider` at an embedding-capable local backend such as Ollama, not `heuristic`.

Supported non-code ingest includes `.pdf`, `.docx`, `.epub`, `.csv`, `.tsv`, `.xlsx`, `.pptx`, images, markdown/text notes, browser clips, and research URLs captured through `swarmvault add`.

## What The Skill Package Includes

- `SKILL.md` - operational instructions for the model
- [`examples/quickstart.md`](examples/quickstart.md) - first-run setup flow
- [`examples/repo-workflow.md`](examples/repo-workflow.md) - repo ingest, compile, review, and graph workflow
- [`examples/research-workflow.md`](examples/research-workflow.md) - research capture and query workflow
- [`references/commands.md`](references/commands.md) - high-signal command cheat sheet
- [`references/artifacts.md`](references/artifacts.md) - what shows up under `raw/`, `wiki/`, and `state/`
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) - common setup and runtime fixes
- [`validation/smoke-prompts.md`](validation/smoke-prompts.md) - release-validation prompts and expected outcomes

The published ClawHub package is intentionally text-only in this release.

## Core Workflow

1. Initialize the vault with `swarmvault init`.
2. Treat `swarmvault.schema.md` as the vault contract before serious compile or query work.
3. Use `swarmvault source add` when the input is a recurring local directory, public GitHub repo root, or docs hub that should stay registered.
4. Add one-off material with `swarmvault ingest`, `swarmvault add`, or `swarmvault inbox import`.
5. Compile with `swarmvault compile` or `swarmvault compile --approve`.
6. Inspect `wiki/` and `state/` artifacts before broad re-search.
7. Use `swarmvault query`, `swarmvault explore`, `swarmvault review`, `swarmvault candidate`, and `swarmvault lint` to keep the vault current and reviewable.
8. Use `swarmvault graph serve`, `swarmvault graph export`, `swarmvault graph push neo4j`, or `swarmvault mcp` when the vault needs to be explored or shared elsewhere.

## What SwarmVault Writes

- `raw/sources/` and `raw/assets/` for canonical input storage
- `wiki/` for compiled source, concept, entity, code, graph, and output pages
- `wiki/outputs/source-briefs/` for recurring-source onboarding briefs
- `wiki/candidates/` for staged concept/entity pages
- `state/graph.json` for the compiled graph
- `state/search.sqlite` for local search
- `state/sources.json` plus `state/sources/<id>/` for managed-source registry state and working sync data
- `state/approvals/` for compile approval bundles
- `state/sessions/` and `state/jobs.ndjson` for saved run history

## Agent And MCP Integration

Supported agent installs:

- `swarmvault install --agent codex`
- `swarmvault install --agent claude --hook`
- `swarmvault install --agent cursor`
- `swarmvault install --agent gemini --hook`
- `swarmvault install --agent opencode --hook`
- `swarmvault install --agent aider`
- `swarmvault install --agent copilot --hook`

Expose the vault over MCP with:

```bash
swarmvault mcp
```

## Links

- Docs: https://www.swarmvault.ai/docs
- Providers: https://www.swarmvault.ai/docs/providers
- Troubleshooting: https://www.swarmvault.ai/docs/getting-started/troubleshooting
- npm: https://www.npmjs.com/package/@swarmvaultai/cli
- GitHub: https://github.com/swarmclawai/swarmvault
