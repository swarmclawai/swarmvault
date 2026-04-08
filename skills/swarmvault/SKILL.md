---
name: swarmvault
description: "Use SwarmVault when the user needs a local-first knowledge vault that writes durable markdown, graph, search, review, and MCP artifacts to disk from files, URLs, code, and recurring repo workflows."
version: "0.2.1"
metadata: '{"openclaw":{"requires":{"anyBins":["swarmvault","vault"]},"install":[{"id":"node","kind":"node","package":"@swarmvaultai/cli","bins":["swarmvault","vault"],"label":"Install SwarmVault CLI (npm)"}],"emoji":"🗃️","homepage":"https://www.swarmvault.ai/docs"}}'
---

# SwarmVault

Use this skill when the user wants a local-first knowledge base whose outputs stay on disk as markdown, graph, and search artifacts, or when the project already contains `swarmvault.config.json` or `swarmvault.schema.md`.

For onboarding, examples, command references, or troubleshooting, read the bundled `README.md`, `examples/`, `references/`, and `TROUBLESHOOTING.md` before improvising workflow advice.

## Quick checks

- Work from the vault root.
- If the vault does not exist yet, run `swarmvault init`.
- Read `swarmvault.schema.md` before compile or query work. It is the vault's operating contract.
- If `wiki/graph/report.md` exists, use it before broad repo search.

## Core loop

1. Initialize a vault with `swarmvault init` when needed.
2. Update `swarmvault.schema.md` before a serious compile. Use it for naming rules, categories, grounding, freshness expectations, and exclusions.
3. Use `swarmvault source add <input>` when the input is a recurring local directory, public GitHub repo root, or docs hub that should stay registered.
4. Ingest one-off inputs with `swarmvault ingest <path-or-url>`, or ingest a whole repo tree with `swarmvault ingest <directory>`.
5. Use `swarmvault inbox import` for capture-style batches, then `swarmvault watch --lint --repo` when the workflow should stay automated. Install `swarmvault hook install` when git checkouts and commits should trigger repo-aware refreshes automatically.
6. Compile with `swarmvault compile`, or use `swarmvault compile --approve` when changes should go through the local review queue first.
7. Resolve staged work with `swarmvault review list|show|accept|reject` and `swarmvault candidate list|promote|archive`.
8. Ask questions with `swarmvault query "<question>"`. It saves durable answers into `wiki/outputs/` by default; add `--no-save` only for ephemeral checks.
9. Use `swarmvault explore "<question>" --steps <n>` for save-first multi-step research loops, or `--format report|slides|chart|image` when the artifact should be presentation-oriented.
10. Run `swarmvault lint` whenever the schema changed, artifacts look stale, or compile/query results drift.
11. Use `swarmvault mcp` when another agent or tool should browse, search, and query the vault through MCP.
12. Use `swarmvault graph serve` or `swarmvault graph export --html <output>` when graph inspection or sharing will help.

## Working rules

- Prefer changing the schema before re-running compile when organization or grounding is wrong.
- Treat `wiki/` and `state/` as first-class outputs. Inspect them instead of trusting a single chat answer.
- Prefer `wiki/graph/report.md`, `state/graph.json`, and saved wiki pages over ad hoc broad search when they already exist.
- Use `source add` for recurring directories, public GitHub repo roots, and docs hubs. Use `ingest` and `add` for deliberate one-off inputs.
- The default heuristic provider is only for smoke tests or offline defaults. Point real vaults at a stronger provider before serious synthesis.
- If an OpenAI-compatible backend cannot satisfy structured generation, reduce its declared capabilities instead of forcing every task through it.
- Keep raw sources immutable. Put corrections in schema, new sources, or saved outputs rather than manually rewriting generated provenance.

## Files and artifacts

- `swarmvault.schema.md`: vault-specific compile and query rules.
- `raw/sources/` and `raw/assets/`: canonical source storage.
- `wiki/`: generated pages plus saved outputs.
- `wiki/outputs/source-briefs/`: saved onboarding briefs for managed sources.
- `wiki/code/`: module pages for ingested JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Kotlin, Scala, Lua, Zig, C#, C, C++, PHP, Ruby, and PowerShell sources.
- `state/code-index.json`: repo-aware code aliases and local import resolution data.
- `wiki/projects/`: project rollups over canonical pages.
- `wiki/candidates/`: staged concept and entity pages awaiting promotion.
- `state/graph.json`: compiled graph.
- `state/search.sqlite`: local search index.
- `state/sources.json` and `state/sources/<id>/`: managed-source registry entries plus working sync state.
- `state/approvals/`: staged review bundles from `compile --approve`.
- `state/sessions/`: canonical session artifacts for compile, query, explore, lint, watch, review, and candidate actions.
- `state/jobs.ndjson`: watch-mode run log.

## Agent integration

- `swarmvault install --agent codex|claude|cursor|goose|pi|gemini|opencode|aider|copilot` installs agent-specific rules into the current project.
- `swarmvault install --agent claude|opencode|gemini|copilot --hook` installs graph-first hook or plugin support for the agents that expose project hook APIs.
- `swarmvault install --agent aider` installs `CONVENTIONS.md` and wires `.aider.conf.yml` to read it when that config is valid YAML.
- `swarmvault mcp` exposes tools and resources for page search, page reads, source listing, query, ingest, compile, and lint.

## Defaults to preserve

- Keep raw source material immutable under `raw/`.
- Save useful answers unless the user explicitly wants ephemeral output.
- Prefer reviewable flows such as `compile --approve`, `review`, and `candidate` when a change should not activate silently.
- Treat provider setup as part of serious vault operation. If only `heuristic` is configured, say so clearly.
