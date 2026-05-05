# @swarmvaultai/cli

`@swarmvaultai/cli` is the global command-line entry point for SwarmVault.

It gives you the `swarmvault` command for building a local-first knowledge vault from files, audio/video transcripts, YouTube URLs, reStructuredText and DOCX documents, browser clips, saved query outputs, and guided exploration runs.

## Install

SwarmVault requires Node `>=24`.

```bash
npm install -g @swarmvaultai/cli
```

Installed commands:

- `swarmvault`
- `vault` as a compatibility alias

## Maintainer Validation

Release preflight includes a direct CLI surface smoke before tarball smoke:

```bash
pnpm live:cli-surface
```

The smoke parses `packages/cli/src/index.ts` with the TypeScript compiler API, checks that every stable Commander command path and alias is classified in the surface manifest, runs `--help` across the full command tree, and exercises direct JSON behavior checks for the core local workflows.

## First Run

```bash
mkdir my-vault
cd my-vault
swarmvault init --obsidian --profile personal-research
swarmvault init --obsidian --profile reader,timeline
swarmvault demo
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://github.com/owner/repo --branch main --checkout-dir .swarmvault-checkouts/repo
swarmvault source add https://example.com/docs/getting-started
swarmvault source add ./exports/customer-call.srt --guide
swarmvault source session file-customer-call-srt-12345678
swarmvault source list
swarmvault source reload --all
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault ingest ./customer-call.mp3
swarmvault ingest https://www.youtube.com/watch?v=dQw4w9WgXcQ
swarmvault ingest --video https://example.com/product-demo.mp4
swarmvault ingest ./repo
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile --max-tokens 120000
swarmvault diff
swarmvault graph share --post
swarmvault graph share --svg ./share-card.svg
swarmvault graph share --bundle ./share-kit
swarmvault benchmark
swarmvault query "What keeps recurring?" --commit
swarmvault context build "Ship this feature safely" --target ./src --budget 8000
swarmvault task start "Ship this feature safely" --target ./src --agent codex
swarmvault retrieval status
swarmvault doctor --repair
swarmvault query "Turn this into slides" --format slides
swarmvault explore "What should I research next?" --steps 3
swarmvault lint --deep
swarmvault graph blast ./src/index.ts
swarmvault graph status ./src
swarmvault check-update ./src
swarmvault graph stats
swarmvault graph validate --strict
swarmvault graph update .
swarmvault update .
swarmvault graph cluster
swarmvault cluster-only
swarmvault graph tree --output ./exports/tree.html
swarmvault tree --output ./exports/tree.html
swarmvault graph query "Which nodes bridge the biggest clusters?"
swarmvault graph explain "concept:drift"
swarmvault watch status
swarmvault watch --repo --once
swarmvault hook install
swarmvault graph serve
swarmvault graph export --report ./exports/report.html
swarmvault graph export --html ./exports/graph.html
swarmvault graph export --cypher ./exports/graph.cypher
swarmvault graph export --neo4j ./exports/graph.cypher
swarmvault graph merge ./exports/graph.json ./other-graph.json --out ./exports/merged-graph.json
swarmvault merge-graphs ./exports/graph.json ./other-graph.json --out ./exports/merged-graph.json
swarmvault graph push neo4j --dry-run
swarmvault clone https://github.com/owner/repo --no-viz
```

## Commands

### `swarmvault init [--obsidian] [--profile <alias-or-presets>]`

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

Set `SWARMVAULT_OUT=<dir>` when generated artifacts should be isolated from the project root. Config and schema files stay at the root; relative `raw/`, `wiki/`, `state/`, `agent/`, and `inbox/` workspace directories resolve under the output root.

`--profile` accepts `default`, `personal-research`, or a comma-separated preset list such as `reader,timeline`. For fully custom vault behavior, edit the `profile` block in `swarmvault.config.json`; that deterministic profile layer works alongside the human-written `swarmvault.schema.md`. The `personal-research` preset also sets `profile.guidedIngestDefault: true` and `profile.deepLintDefault: true`, so guided ingest/source and lint flows are on by default until you override them with `--no-guide` or `--no-deep`.

### `swarmvault scan <directory|github-url> [--port <port>] [--no-serve] [--no-viz] [--mcp] [--branch <name>] [--ref <ref>] [--checkout-dir <path>]`

Quick-start a scratch vault from a local directory or public GitHub repo root URL in one command.

- initializes the current directory as a SwarmVault workspace
- ingests the supplied directory as local sources, or registers/syncs the supplied public GitHub repo root URL
- compiles the vault immediately
- writes `wiki/graph/share-card.md`, `wiki/graph/share-card.svg`, and `wiki/graph/share-kit/`, then prints the paths
- starts `graph serve` unless you pass `--no-serve` or `--no-viz`
- `--no-viz` is a compatibility alias for `--no-serve`
- `--mcp` starts the MCP stdio server after compile instead of the graph viewer
- respects `--port` when you want a specific viewer port
- for GitHub repo URLs, supports `--branch`, `--ref`, and `--checkout-dir`

Use this when you want the fastest repo or docs-tree walkthrough without first deciding on managed-source registration.

### `swarmvault clone <directory|github-url> [--no-viz] [--mcp] [--branch <name>] [--ref <ref>] [--checkout-dir <path>]`

Compatibility alias for `swarmvault scan`.

- initializes, ingests or registers the input, and compiles in one command
- supports the same public GitHub repo checkout flags as `scan`
- accepts `--no-serve`, `--no-viz`, `--mcp`, and `--port`

### `swarmvault demo [--port <port>] [--no-serve]`

Create a temporary sample vault with bundled sources, compile it immediately, and launch the graph viewer unless you pass `--no-serve`.

- writes the demo vault under the system temp directory
- requires no API keys or extra setup
- is the fastest way to inspect the full init + ingest + compile + graph workflow on a clean machine
- writes `wiki/graph/share-card.md`, `wiki/graph/share-card.svg`, and `wiki/graph/share-kit/` inside the demo vault
- respects `--port` when you want a specific viewer port

### `swarmvault diff`

Compare the current `state/graph.json` against the last committed graph in git.

- when a prior committed graph exists, prints added and removed nodes, pages, and edges
- when no git baseline exists, falls back to a summary of the current graph state
- supports `--json` for structured automation output

### `swarmvault doctor [--repair]`

Run a whole-vault health check before handing the workspace to an agent or opening the live viewer.

- checks workspace config and schema presence
- reports graph, page, source, review, candidate, task, watch, migration, and retrieval state
- emits prioritized recommended next actions before the full check list
- emits suggested follow-up commands for warnings and errors
- supports `--json` for structured automation output
- add `--repair` to rebuild safe derived retrieval artifacts
- the live viewer workbench shows the same recommendations and checks with details, copyable suggested commands, and safe direct repair

### `swarmvault source add|list|reload|review|guide|session|delete`

Manage recurring source roots through a registry-backed workflow.

- `source add <input>` supports local files, local directories, public GitHub repo root URLs such as `https://github.com/karpathy/micrograd`, and docs/wiki/help/reference/tutorial hubs
- for public GitHub repo roots, `source add` supports `--branch <name>`, `--ref <ref>`, and `--checkout-dir <path>` so recurring sources can pin a branch, tag, commit, or reusable checkout directory
- by default `source add` registers the source, syncs it into the vault, runs one compile, and writes a source brief to `wiki/outputs/source-briefs/<source-id>.md`
- add `--guide` when you want a resumable source session, source brief, source review, source guide, and approval-bundled canonical page edits when `profile.guidedSessionMode` is `canonical_review`, with `wiki/insights/` fallback for `insights_only`
- set `profile.guidedIngestDefault: true` when guided mode should be the default for `source add` and `source reload`, and use `--no-guide` for individual light-path runs
- `source list` shows every managed source with its kind, status, and current brief path
- `source reload [id]` re-syncs one source, or use `--all` to refresh everything in the registry and compile once
- `source review <id>` stages a lighter source-scoped review artifact
- `source guide <id>` remains a compatibility alias for the guided session flow
- `source session <id>` resumes the latest guided session for a managed source id, raw source id, source scope id, or session id
- `source delete <id>` unregisters the source and removes transient sync state under `state/sources/<id>/`, but leaves canonical `raw/`, `wiki/`, and saved output artifacts intact

Useful flags:

- `--all`
- `--guide`
- `--no-guide`
- `--answers-file <path>`
- `--no-compile`
- `--no-brief`
- `--max-pages <n>`
- `--max-depth <n>`

Managed sources write registry state to `state/sources.json`. Guided sessions write durable anchors to `wiki/outputs/source-sessions/` and session state to `state/source-sessions/`. In an interactive TTY, `--guide` can ask the session questions immediately; otherwise use `source session <id>` or `--answers-file <path>` to resume and stage the approval bundle later. Local directory entries remain compatible with `watch --repo`; remote GitHub and docs-crawl sources are manual `source reload` sources in this release.

Source-scoped artifacts are intentionally split by role:

| Artifact | Created by | Purpose |
|----------|-----------|---------|
| Source brief | `source add`, `ingest` (always) | Auto summary written to `wiki/outputs/source-briefs/` |
| Source review | `source review`, `source add --guide`, `ingest --review`, `ingest --guide` | Lighter staged assessment in `wiki/outputs/source-reviews/` |
| Source guide | `source guide`, `source add --guide`, `ingest --guide` | Guided walkthrough with approval-bundled updates in `wiki/outputs/source-guides/` |
| Source session | `source session`, `source add --guide`, `ingest --guide` | Resumable workflow state in `wiki/outputs/source-sessions/` and `state/source-sessions/` |

### `swarmvault ingest <path-or-url> [--commit]`

Ingest a local file path, directory path, or URL into immutable source storage and write manifests to `state/manifests/`.

- local directories recurse by default
- directory ingest respects `.gitignore` and `.swarmvaultignore` unless you pass `--no-gitignore` or `--no-swarmvaultignore`
- repo-aware directory ingest records `repoRelativePath` and later compile writes `state/code-index.json`
- use `source add` instead when the same local directory, public GitHub repo root, or docs hub should stay registered and reloadable
- URL ingest still localizes remote image references by default
- YouTube URLs short-circuit to direct transcript capture instead of generic HTML fetch
- public video URLs passed with `--video` use `yt-dlp` for audio extraction before provider-backed transcription
- local file and archive ingest supports markdown, text, reStructuredText, HTML, PDF, Word, RTF, OpenDocument, EPUB, CSV/TSV, Excel, PowerPoint, Jupyter notebooks, BibTeX, Org-mode, AsciiDoc, transcripts, Slack exports, email, calendar, audio, video, structured config/data, developer manifests, images, and code
- add `--guide` when you want a resumable source session, source brief, source review, source guide, and approval-bundled canonical page edits when `profile.guidedSessionMode` is `canonical_review`, with `wiki/insights/` fallback for `insights_only`
- set `profile.guidedIngestDefault: true` when guided mode should be the default for `ingest`, and use `--no-guide` to force a plain ingest for one run
- code-aware directory ingest currently covers JavaScript, JSX, TypeScript, TSX, Bash/shell scripts, Python, Go, Rust, Java, Kotlin, Scala, Dart, Lua, Zig, C#, C, C++, PHP, Ruby, PowerShell, Elixir, OCaml, Objective-C, ReScript, Solidity, HTML, CSS, Vue single-file components, Svelte single-file components, and SQL files with table/view graph relations. Julia, Verilog/SystemVerilog, and R files are detected as code sources and emit explicit parser-asset diagnostics until packaged WASM grammars are available.

Useful flags:

- `--repo-root <path>`
- `--answers-file <path>`
- `--no-guide`
- `--include <glob...>`
- `--exclude <glob...>`
- `--max-files <n>`
- `--include-third-party`
- `--include-resources`
- `--include-generated`
- `--no-gitignore`
- `--no-swarmvaultignore`
- `--video`
- `--no-include-assets`
- `--max-asset-size <bytes>`
- `--commit`

Repo ingest defaults to `first_party` material. The extra `--include-*` flags opt dependency trees, resource bundles, and generated output back in when you actually want them in the vault.

Large repo ingest now emits low-noise progress on materially large batches, and parser compatibility failures stay local to the affected source instead of aborting unrelated analysis.

Audio and video files use `tasks.audioProvider` when you configure a provider with `audio` capability. Local video extraction shells out to `ffmpeg`; public video URL extraction with `--video` shells out to `yt-dlp`. When no audio provider or extractor binary is configured, SwarmVault still ingests the source and records an explicit extraction warning instead of failing. YouTube transcript ingest does not require a model provider.

When `--commit` is set, SwarmVault stages `wiki/` and `state/` changes and creates a git commit when the vault root is inside a git worktree. Outside git, it becomes a no-op instead of failing.

### `swarmvault add <url>`

Capture supported URLs through a normalized markdown layer before ingesting them into the vault.

- arXiv abstract URLs and bare arXiv ids become durable markdown captures
- DOI URLs and bare DOI strings normalize into article-style research captures
- generic article URLs use a readability-style capture path with normalized research frontmatter
- X/Twitter URLs use a graceful public capture path
- unsupported URLs fall back to generic URL ingest instead of failing
- optional metadata: `--author <name>` and `--contributor <name>`
- `--video` treats the URL as a public video and routes extracted audio through `tasks.audioProvider`
- normalized captures record fields such as `source_type`, `source_url`, `canonical_url`, `title`, `authors`, `published_at`, `updated_at`, `doi`, and `tags` when available
- use `source add` instead when the URL is a public GitHub repo root or a docs hub that should stay synced over time

### `swarmvault inbox import [dir]`

Import supported files from the configured inbox directory. This is meant for browser-clipper style markdown bundles, HTML clip bundles, and other capture workflows. Local image and asset references are preserved and copied into canonical storage under `raw/assets/`.

### `swarmvault compile [--approve] [--commit] [--max-tokens <n>]`

Compile the current manifests into:

- generated markdown in `wiki/`
- structured graph data in `state/graph.json`
- local retrieval data in `state/retrieval/`
- share cards at `wiki/graph/share-card.md` and `wiki/graph/share-card.svg`, plus a portable share kit at `wiki/graph/share-kit/`

The compiler also reads `swarmvault.schema.md` and records a `schema_hash` plus lifecycle metadata such as `status`, `created_at`, `updated_at`, `compiled_from`, and `managed_by` in generated pages so schema edits can mark pages stale without losing lifecycle state.

For ingested code trees, compile also writes `state/code-index.json` so local imports and module aliases can resolve across the repo-aware code graph.

New concept and entity pages are staged into `wiki/candidates/` first. A later matching compile promotes them into `wiki/concepts/` or `wiki/entities/`.

With `--approve`, compile writes a staged review bundle into `state/approvals/` without applying active wiki changes.

Useful flags:

- `--approve`
- `--commit`
- `--max-tokens <n>`

`--max-tokens <n>` keeps the generated wiki inside a bounded token budget by dropping lower-priority pages from final `wiki/` output and reporting token-budget stats in the compile result. `--commit` immediately commits `wiki/` and `state/` changes when the vault lives in a git repo.

### `swarmvault benchmark [--question "<text>" ...]`

Measure graph-guided context reduction against a naive full-corpus read.

- writes the latest result to `state/benchmark.json`
- updates `wiki/graph/report.md` and `wiki/graph/report.json` with the current benchmark summary
- accepts repeatable `--question` inputs for vault-specific benchmarks
- compile and repo-aware refresh runs also keep the benchmark/report artifacts up to date by default

### `swarmvault review list|show|accept|reject`

Inspect and resolve staged approval bundles created by `swarmvault compile --approve`.

- `review list` shows pending, accepted, and rejected entry counts per bundle
- `review show <approvalId>` shows each staged entry plus its current and staged content, including a section-level change summary when available
- `review show <approvalId> --diff` adds a unified diff between current and staged content
- `review accept <approvalId> [targets...]` applies pending entries to the live wiki
- `review reject <approvalId> [targets...]` marks pending entries as rejected without mutating active wiki paths

Targets can be page ids such as `concept:approval-concept` or relative wiki paths such as `concepts/approval-concept.md`.

### `swarmvault candidate list|promote|archive`

Inspect and resolve staged concept and entity candidates.

- `candidate list` shows every current candidate plus its active destination path
- `candidate promote <target>` promotes a candidate immediately into `wiki/concepts/` or `wiki/entities/`
- `candidate archive <target>` removes a candidate from the staged set

Targets can be page ids or relative paths under `wiki/candidates/`.

### `swarmvault query "<question>" [--no-save] [--commit] [--format markdown|report|slides|chart|image]`

Query the compiled vault. The query layer also reads `swarmvault.schema.md`, so answers follow the vault’s own structure and grounding rules.

By default, the answer is written into `wiki/outputs/` and immediately registered in:

- `wiki/index.md`
- `wiki/outputs/index.md`
- `state/graph.json`
- `state/retrieval/`

Saved outputs also carry related page, node, and source metadata so SwarmVault can refresh related source, concept, and entity pages immediately.

Human-authored pages in `wiki/insights/` are also indexed into search and query context, but SwarmVault does not rewrite them after initialization.

By default, query uses the local SQLite retrieval index. When an embedding-capable provider is available and `retrieval.hybrid` is not disabled, semantic page matches are fused into the same candidate set before answer generation. `tasks.embeddingProvider` is the explicit way to choose that backend, but SwarmVault can also fall back to a `queryProvider` with embeddings support. Set `retrieval.rerank: true` when you want the configured `queryProvider` to rerank the merged top hits. `--commit` immediately commits saved `wiki/` and `state/` changes when the vault root is inside a git repo.

### `swarmvault context build|list|show|delete`

Build and manage agent-ready context packs from the compiled vault.

- `context build "<goal>"` assembles relevant pages, graph nodes, edges, hyperedges, citations, and explicit omitted entries into a bounded bundle
- `--target <path-or-node>` anchors the pack around a file, page id, node id, or graph label
- `--task <id>` links the newly built context pack to an active task
- `--memory <id>` remains a compatibility alias for `--task`
- `--budget <tokens>` caps the estimated token budget; over-budget candidates are listed in `omittedItems`
- `--format markdown|json|llms` controls the printed output shape, while every pack is still saved as JSON
- saved artifacts live under `state/context-packs/`, with companion markdown pages under `wiki/context/`
- `context list`, `context show <id>`, and `context delete <id>` manage saved packs

Use this before handing work to an agent, starting a PR review, or preserving the evidence bundle behind a design/debugging decision.

### `swarmvault task start|update|finish|list|show|resume`

Record a durable local task ledger for agent work.

- `task start "<goal>" --target <path-or-node>` creates `state/memory/tasks/<id>.json`, `wiki/memory/tasks/<id>.md`, updates `wiki/memory/index.md`, and builds an initial context pack
- `task update <id>` records notes, decisions, changed paths, context packs, sessions, sources, pages, nodes, git refs, or status changes
- `task finish <id> --outcome <text>` marks the task completed and can add one or more `--follow-up` entries
- `task list`, `task show <id>`, and `task resume <id> --format markdown|json|llms` expose the task history for the next agent

`query`, `explore`, and `context build` accept `--task <id>` so saved outputs and context packs can attach to an active task. The 2.0 `memory` command group and `--memory <id>` flag remain compatibility aliases.

### `swarmvault retrieval status|rebuild|doctor`

Inspect and maintain the local retrieval index under `state/retrieval/`.

- `retrieval status` reports backend, configured hybrid/rerank behavior, manifest freshness, page count, and the current SQLite shard path
- `retrieval rebuild` rebuilds the local shard from current wiki pages and refreshes `state/retrieval/manifest.json`
- `retrieval doctor` checks for stale or missing retrieval artifacts; add `--repair` to rebuild missing or stale artifacts immediately

### `swarmvault explore "<question>" [--steps <n>] [--format markdown|report|slides|chart|image]`

Run a save-first multi-step research loop.

Each step:

- queries the vault
- saves the answer into `wiki/outputs/`
- generates follow-up questions
- chooses the next follow-up deterministically

The command also writes a hub page linking the root question, saved step pages, and generated follow-up questions.

### `swarmvault lint [--deep] [--no-deep] [--web] [--conflicts]`

Run anti-drift and vault health checks such as stale pages, missing graph artifacts, contradiction findings, and other structural issues.

`--deep` adds an LLM-powered advisory pass that can report:

- `coverage_gap`
- `contradiction`
- `contradiction_candidate`
- `missing_citation`
- `candidate_page`
- `follow_up_question`

Set `profile.deepLintDefault: true` when deep lint should be the default for `swarmvault lint`, and use `--no-deep` when one run should stay structural only.

`--web` can only be used when deep lint is enabled, either explicitly with `--deep` or through `profile.deepLintDefault`. It enriches deep-lint findings with external evidence snippets and URLs from a configured web-search provider. Web search is currently scoped to deep lint; other commands (compile, query, explore) use only local vault state.

`--conflicts` filters the results down to contradiction-focused findings so you can audit conflicting claims without the rest of the lint output.

### `swarmvault watch [--lint] [--repo] [--once] [--code-only] [--debounce <ms>]`

Watch the inbox directory and trigger import and compile cycles when files change. With `--repo`, each cycle also refreshes tracked repo roots that were previously ingested through directory ingest. With `--once`, SwarmVault runs one refresh cycle immediately instead of starting a long-running watcher. With `--code-only`, SwarmVault forces the narrower AST-only refresh path and skips non-code semantic re-analysis until you run a normal `compile`. With `--lint`, each cycle also runs linting. Each cycle writes a canonical session artifact to `state/sessions/`, and compatibility run metadata is still appended to `state/jobs.ndjson`.

When `--repo` sees non-code changes under tracked repo roots, SwarmVault records those files under `state/watch/pending-semantic-refresh.json`, marks affected compiled pages stale, and exposes the pending set through `watch status` and the local graph workspace instead of silently re-ingesting them.

When `--repo` sees only code-file changes under tracked repo roots, SwarmVault takes the faster code-only path: it refreshes code pages and graph structure without re-running non-code semantic analysis for unchanged sources.

### `swarmvault watch status`

Show watched repo roots, the latest watch run, and any pending semantic refresh entries for tracked non-code repo changes.

### `swarmvault graph update [path]`

Refresh code-derived graph artifacts from tracked repo roots or one explicit repo path.

- aliases to `swarmvault graph refresh [path]`
- runs the same code-only repo refresh path as `swarmvault watch --repo --code-only --once`
- without `path`, uses configured or auto-discovered watched repo roots
- with `path`, refreshes that repo root instead of the tracked set
- aborts if nodes or edges drop by more than 25% compared with the existing graph; pass `--force` or set `SWARMVAULT_FORCE_UPDATE=1` when the shrink is expected
- `--json` returns the same one-shot watch result shape, including repo import/update/remove counts and pending semantic refresh entries

### `swarmvault check-update [path]`

Compatibility alias for `swarmvault graph status [path]`.

- performs the same read-only graph/report freshness check
- keeps automation-friendly JSON output for cron or hook wrappers
- recommends `swarmvault update`/`swarmvault graph update` for code-only drift and `swarmvault compile` when semantic refresh is required

### `swarmvault update [path]`

Compatibility alias for `swarmvault graph update [path]`.

- runs the same code-only repo refresh path
- accepts `--lint` and `--force`
- returns the same JSON shape as `graph update`

### `swarmvault graph tree [--output <html>] [--root <path>] [--label <name>] [--max-children <n>]`

Write a collapsible HTML source tree for the current `state/graph.json`.

- groups sources by path, then shows module, symbol, and rationale nodes underneath each source
- defaults to `wiki/graph/tree.html`
- `--root` reads a different vault root without changing directories
- `--max-children` caps very wide folders or modules with a `+N more` row
- `--json` returns the output path, source count, node count, and tree payload

### `swarmvault tree [--output <html>] [--root <path>] [--label <name>] [--max-children <n>]`

Compatibility alias for `swarmvault graph tree`.

- writes the same source/module/symbol tree
- returns the same JSON shape as `graph tree`

### `swarmvault graph merge <graph...> --out <path> [--label <name>]`

Merge multiple graph JSON files into one namespaced graph artifact.

- accepts native SwarmVault `state/graph.json` payloads
- accepts NetworkX/node-link style JSON with `nodes` plus `links` or `edges`
- prefixes ids from every input to avoid collisions
- maps explicit extracted/inferred/ambiguous edge evidence into SwarmVault edge semantics
- `--json` returns the merged graph, input summaries, and warnings

### `swarmvault merge-graphs <graph...> --out <path> [--label <name>]`

Compatibility alias for `swarmvault graph merge`.

- accepts the same SwarmVault and NetworkX/node-link graph inputs
- returns the same JSON shape as `graph merge`

### `swarmvault graph status [path]`

Read-only graph freshness check for tracked repo roots or one explicit repo path.

- reports graph and graph-report presence
- lists tracked repo roots and changed files without writing watch status
- separates code-only changes from semantic refresh changes
- recommends `swarmvault graph update` for code-only graph drift
- recommends `swarmvault compile` when graph/report artifacts are missing, non-code files changed, or a semantic refresh is pending
- supports global `--json` for automation

### `swarmvault watch [path] [--once] [--code-only] [--lint]`

Watch or refresh one explicit repo root without first writing `watch.repoRoots`.

- positional `[path]` is treated as a repo-root override and turns on repo mode
- `--once` runs one refresh cycle and exits
- `--code-only` limits the refresh to parser-backed repo graph artifacts
- repeated `--root <path>` remains available when you need multiple roots

### `swarmvault graph stats`

Summarize the current compiled graph without opening the viewer.

- reports source, page, node, edge, hyperedge, and community counts
- breaks down node types, evidence classes, source classes, edge relations, and hyperedge relations
- keeps the same lightweight shape as the MCP `graph_stats` tool
- supports global `--json` for automation

### `swarmvault graph validate [graph] [--strict]`

Validate graph artifact integrity before exporting, merging, pushing, or publishing generated graph evidence.

- defaults to the current vault's compiled `state/graph.json`
- accepts an explicit graph JSON path for exported or merged graph artifacts
- checks duplicate ids, dangling node/page/community/hyperedge references, confidence bounds, empty critical fields, and conflicted-edge evidence consistency
- exits non-zero when errors are present; with `--strict`, warnings also fail the command
- supports global `--json` for automation

### `swarmvault graph cluster [--resolution <n>]`

Recompute communities, node degrees, bridge scores, god-node flags, and graph report artifacts from the existing `state/graph.json` without re-ingesting or re-analyzing sources.

- writes refreshed graph metrics back to `state/graph.json`
- updates `wiki/graph/report.md`, `wiki/graph/report.json`, share artifacts, and per-community graph pages
- uses `graph.communityResolution` by default, or `--resolution <n>` for a one-off override
- splits oversized or low-cohesion communities after the initial Louvain pass so large-repo reports stay scannable
- `--json` returns counts plus the graph/report paths

### `swarmvault cluster-only [vault] [--resolution <n>]`

Compatibility alias for `swarmvault graph cluster`.

- recomputes communities and graph report artifacts without ingest or semantic analysis
- accepts an optional vault root when the command is run from outside the vault
- returns the same JSON shape as `graph cluster`

### `swarmvault graph export --neo4j <path>`

Compatibility alias for `swarmvault graph export --cypher <path>`.

- writes a Neo4j-ready Cypher import file
- can be combined with other `graph export` formats in the same run

### `swarmvault hook install|uninstall|status`

Manage SwarmVault's local git hook blocks for the nearest git repository.

- `hook install` writes marker-based `post-commit` and `post-checkout` hooks
- `hook uninstall` removes only the SwarmVault-managed hook block
- `hook status` reports whether those managed hook blocks are installed

The installed hooks run `swarmvault watch --repo --once --code-only` from the vault root so commit and checkout refreshes update code pages and graph structure quickly. Run a normal `swarmvault compile` when you also want non-code semantic re-analysis.

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
- `blast_radius`
- `build_context_pack`
- `list_context_packs`
- `read_context_pack`
- `start_task`
- `update_task`
- `finish_task`
- `list_tasks`
- `read_task`
- `resume_task`
- `start_memory_task`
- `update_memory_task`
- `finish_memory_task`
- `list_memory_tasks`
- `read_memory_task`
- `resume_memory_task`
- `retrieval_status`
- `rebuild_retrieval`
- `doctor_retrieval`
- `doctor_vault`
- `query_graph`
- `graph_report`
- `graph_stats`
- `cluster_graph`
- `get_node`
- `get_community`
- `get_neighbors`
- `get_hyperedges`
- `shortest_path`
- `god_nodes`

`compile_vault` also accepts `maxTokens` for bounded wiki output, `graph_stats` returns lightweight graph counts, `cluster_graph` mirrors `swarmvault graph cluster`, `get_community` resolves community members and pages, `blast_radius` traces reverse import impact for a file or module target, `build_context_pack` creates the same bounded agent evidence bundles as `swarmvault context build`, the task tools mirror `swarmvault task`, the memory tools mirror the compatibility command group, `doctor_vault` mirrors `swarmvault doctor`, and retrieval tools inspect or repair the local index.

The MCP surface also exposes `swarmvault://schema`, `swarmvault://sessions`, `swarmvault://sessions/{path}`, `swarmvault://context-packs`, `swarmvault://tasks`, `swarmvault://memory-tasks`, and includes `schemaPath` in `workspace_info`.

### `swarmvault graph serve`

Start the local graph workspace backed by `state/graph.json`, `/api/search`, `/api/page`, local graph query/path/explain endpoints, and the workbench APIs for doctor, retrieval repair, capture, context packs, task start, and source reload.

The workbench renders prioritized vault doctor recommendations, every check with details, suggested commands that can be copied back to a terminal, safe one-click retrieval repair through `doctor --repair`, selectable capture modes (`ingest`, normalized `add`, or `inbox`), title/tag capture fields, editable token budgets for context packs and task starts, and action receipts after workbench operations complete.

It also exposes `/api/bookmarklet` and `/api/clip`, so a running local viewer can capture the current browser URL, page title, selected text, markdown, HTML excerpts, and tags through the workbench or bookmarklet without leaving the browser. URL-only bookmarklet clips use normalized `add`; selected text is imported through the inbox path.

### `swarmvault graph query "<question>" [--dfs] [--budget <n>]`

Run a deterministic local graph traversal seeded from local search, graph labels, and matching group patterns.

### `swarmvault graph path <from> <to>`

Return the shortest high-confidence path between two graph targets.

### `swarmvault graph explain <target>`

Inspect graph metadata, community membership, neighbors, provenance, and group-pattern membership for a node or page.

### `swarmvault graph god-nodes [--limit <n>]`

List the most connected bridge-heavy nodes in the current graph.

### `swarmvault graph share [--post] [--svg [path]] [--bundle [dir]]`

Print a shareable summary of the compiled graph.

- default output is the same markdown shape written to `wiki/graph/share-card.md`
- `--post` prints only the concise social-post text
- `--svg [path]` writes the 1200x630 visual share card, defaulting to `wiki/graph/share-card.svg`
- `--bundle [dir]` writes `share-card.md`, `share-post.txt`, `share-card.svg`, `share-preview.html`, and `share-artifact.json`, defaulting to `wiki/graph/share-kit`
- `--json` emits the structured share artifact for automation; with `--svg`, it also includes `svgPath`; with `--bundle`, it includes `bundlePath` and named output paths
- useful immediately after `swarmvault scan`, `swarmvault demo`, or a normal compile

### `swarmvault graph blast <target> [--depth <n>]`

Trace the reverse-import blast radius of changing a file or module.

- accepts a file path, module label, or module id
- follows reverse `imports` edges through the compiled graph
- reports affected modules by depth so you can estimate downstream impact before editing

### `swarmvault graph export --html|--html-standalone|--report|--svg|--graphml|--cypher|--json|--obsidian|--canvas <output>`

Export the current graph as one or more shareable formats:

- `--html` for the full self-contained read-only graph workspace
- `--html-standalone` for a lighter vis.js export with node search, legend, and sidebar inspection
- `--report` for a self-contained HTML graph report with stats, key nodes, communities, and warnings
- `--svg` for a static shareable diagram
- `--graphml` for graph-tool interoperability
- `--cypher` for Neo4j-style import scripts
- `--json` for a deterministic machine-readable graph package
- `--obsidian` for an Obsidian-friendly markdown vault that preserves wiki folders, appends graph connections, emits orphan-node stubs and community notes, copies assets, and writes a minimal `.obsidian/` config
- `--canvas` for an Obsidian canvas grouped by community

You can combine multiple flags in one run to write several exports at once.

Set `graph.communityResolution` in `swarmvault.config.json` when you want to pin the Louvain clustering resolution used by graph reports and Obsidian community output instead of relying on the adaptive default.

### `swarmvault graph push neo4j`

Push the compiled graph directly into Neo4j over Bolt/Aura instead of writing an intermediate file.

Useful flags:

- `--uri <bolt-uri>`
- `--username <user>`
- `--password-env <env-var>`
- `--database <name>`
- `--vault-id <id>`
- `--include-third-party`
- `--include-resources`
- `--include-generated`
- `--dry-run`

Defaults:

- reads `graphSinks.neo4j` from `swarmvault.config.json` when present
- includes only `first_party` graph material unless you opt into more source classes
- namespaces every remote record by `vaultId` so multiple vaults can safely share one Neo4j database
- upserts current graph records and does not prune stale remote data yet

### `swarmvault install --agent <agent>`

Install agent-specific rules into the current project so an agent understands the SwarmVault workspace contract and workflow.

Hook-capable installs:

```bash
swarmvault install --agent codex --hook
swarmvault install --agent claude --hook
swarmvault install --agent gemini --hook
swarmvault install --agent opencode --hook
swarmvault install --agent copilot --hook
```

Agent target mapping:

- `codex`, `goose`, `pi`, and `opencode` share `AGENTS.md`
- `claude` writes `CLAUDE.md`
- `gemini` writes `GEMINI.md`
- `aider` writes `CONVENTIONS.md` and merges `.aider.conf.yml`
- `copilot` writes `.github/copilot-instructions.md` plus `AGENTS.md`
- `cursor` writes `.cursor/rules/swarmvault.mdc`
- `trae` writes `.trae/rules/swarmvault.md`
- `claw` writes `.claw/skills/swarmvault/SKILL.md`
- `droid` writes `.factory/rules/swarmvault.md`
- `kiro` writes `.kiro/skills/swarmvault/SKILL.md` and `.kiro/steering/swarmvault.md`
- `hermes` writes `~/.hermes/skills/swarmvault/SKILL.md` plus `AGENTS.md`
- `antigravity` writes `.agents/rules/swarmvault.md` and `.agents/workflows/swarmvault.md`, and removes older fully managed `.agent/` files during reinstall
- `vscode` writes `.github/chatmodes/swarmvault.chatmode.md` plus `.github/copilot-instructions.md`

Hook semantics:

- `codex --hook` writes `.codex/hooks.json` plus `.codex/hooks/swarmvault-graph-first.js` and emits model-visible guidance before broad shell search
- `claude --hook` writes `.claude/settings.json` plus `.claude/hooks/swarmvault-graph-first.js` and adds model-visible advisory context through structured hook JSON
- `gemini --hook` writes `.gemini/settings.json` plus `.gemini/hooks/swarmvault-graph-first.js` and stays advisory/model-visible
- `opencode --hook` writes `.opencode/plugins/swarmvault-graph-first.js` and stays advisory/log-only
- `copilot --hook` writes `.github/hooks/swarmvault-graph-first.json` plus `.github/hooks/swarmvault-graph-first.js` and remains decision-based rather than advisory

`aider` is intentionally file/config-based in this release rather than hook-based.

### OpenClaw / ClawHub Skill

If you use OpenClaw through ClawHub, install the packaged skill:

```bash
clawhub install swarmvault
```

That published bundle includes `SKILL.md`, a ClawHub README, examples, references, troubleshooting notes, and release-validation prompts. The CLI binary still comes from npm:

```bash
npm install -g @swarmvaultai/cli
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

Search behavior is configurable separately from provider routing:

```json
{
  "retrieval": {
    "backend": "sqlite",
    "shardSize": 25000,
    "hybrid": true,
    "rerank": false
  }
}
```

- `retrieval.hybrid` defaults to enabled and merges full-text hits with semantic page matches when an embedding-capable provider is available
- `retrieval.rerank` optionally asks the current `queryProvider` to rerank the merged top hits before query answers are generated
- `retrieval.backend` currently supports the local SQLite backend

## Troubleshooting

- If you are running from a source checkout and `graph serve` says the viewer build is missing, run `pnpm build` in the repository first
- If a provider claims OpenAI compatibility but fails structured generation, declare only the capabilities it actually supports
- If `lint --deep --web` fails immediately, make sure a `webSearch` provider is configured and mapped to `tasks.deepLintProvider`
- If you still see a `node:sqlite` experimental warning on Node 24, upgrade to the latest CLI; current releases suppress that upstream warning during normal runs

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- GitHub: https://github.com/swarmclawai/swarmvault
