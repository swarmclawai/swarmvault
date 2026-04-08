# SwarmVault Skill

Use the SwarmVault skill when you want a local-first knowledge vault that compiles files, URLs, code, and research captures into durable markdown pages, a searchable graph, and reviewable outputs on disk.

## Install

Install the skill from ClawHub:

```bash
clawhub install swarmvault
```

Install the CLI it depends on:

```bash
npm install -g @swarmvaultai/cli
swarmvault --version
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

## Quickstart

```bash
swarmvault init --obsidian
swarmvault ingest ./src --repo-root .
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault query "What is the auth flow?"
swarmvault graph serve
swarmvault mcp
```

The default `heuristic` provider is useful for smoke tests and offline fallback, but not for serious synthesis quality. For real usage, configure a stronger provider in `swarmvault.config.json`.

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
3. Add sources with `swarmvault ingest`, `swarmvault add`, or `swarmvault inbox import`.
4. Compile with `swarmvault compile` or `swarmvault compile --approve`.
5. Inspect `wiki/` and `state/` artifacts before broad re-search.
6. Use `swarmvault query`, `swarmvault explore`, `swarmvault review`, `swarmvault candidate`, and `swarmvault lint` to keep the vault current and reviewable.
7. Use `swarmvault graph serve`, `swarmvault graph export`, `swarmvault graph push neo4j`, or `swarmvault mcp` when the vault needs to be explored or shared elsewhere.

## What SwarmVault Writes

- `raw/sources/` and `raw/assets/` for canonical input storage
- `wiki/` for compiled source, concept, entity, code, graph, and output pages
- `wiki/candidates/` for staged concept/entity pages
- `state/graph.json` for the compiled graph
- `state/search.sqlite` for local search
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
