# @swarmvaultai/cli

`@swarmvaultai/cli` is the global command-line entry point for SwarmVault.

It gives you the `swarmvault` command for building a local-first knowledge vault from files, reStructuredText and DOCX documents, URLs, browser clips, saved query outputs, and guided exploration runs.

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
swarmvault init --obsidian --profile personal-research
swarmvault init --obsidian --profile reader,timeline
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://example.com/docs/getting-started
swarmvault source add ./exports/customer-call.srt --guide
swarmvault source session file-customer-call-srt-12345678
swarmvault source list
swarmvault source reload --all
sed -n '1,120p' swarmvault.schema.md
swarmvault ingest ./notes.md
swarmvault ingest ./repo
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault compile
swarmvault benchmark
swarmvault query "What keeps recurring?"
swarmvault query "Turn this into slides" --format slides
swarmvault explore "What should I research next?" --steps 3
swarmvault lint --deep
swarmvault graph query "Which nodes bridge the biggest clusters?"
swarmvault graph explain "concept:drift"
swarmvault watch status
swarmvault watch --repo --once
swarmvault hook install
swarmvault graph serve
swarmvault graph export --html ./exports/graph.html
swarmvault graph export --cypher ./exports/graph.cypher
swarmvault graph push neo4j --dry-run
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

`--profile` accepts `default`, `personal-research`, or a comma-separated preset list such as `reader,timeline`. For fully custom vault behavior, edit the `profile` block in `swarmvault.config.json`; that deterministic profile layer works alongside the human-written `swarmvault.schema.md`. The `personal-research` starter profile also sets `profile.guidedIngestDefault: true` and `profile.deepLintDefault: true`, so guided ingest/source and lint flows are on by default until you override them with `--no-guide` or `--no-deep`.

### `swarmvault scan <directory> [--port <port>] [--no-serve]`

Quick-start a scratch vault from a local directory in one command.

- initializes the current directory as a SwarmVault workspace
- ingests the supplied directory as local sources
- compiles the vault immediately
- starts `graph serve` unless you pass `--no-serve`
- respects `--port` when you want a specific viewer port

Use this when you want the fastest repo or docs-tree walkthrough without first deciding on managed-source registration.

### `swarmvault source add|list|reload|review|guide|session|delete`

Manage recurring source roots through a registry-backed workflow.

- `source add <input>` supports local files, local directories, public GitHub repo root URLs such as `https://github.com/karpathy/micrograd`, and docs/wiki/help/reference/tutorial hubs
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

### `swarmvault ingest <path-or-url>`

Ingest a local file path, directory path, or URL into immutable source storage and write manifests to `state/manifests/`.

- local directories recurse by default
- directory ingest respects `.gitignore` unless you pass `--no-gitignore`
- repo-aware directory ingest records `repoRelativePath` and later compile writes `state/code-index.json`
- use `source add` instead when the same local directory, public GitHub repo root, or docs hub should stay registered and reloadable
- URL ingest still localizes remote image references by default
- local file and archive ingest supports markdown, text, reStructuredText, HTML, PDF, Word, RTF, OpenDocument, EPUB, CSV/TSV, Excel, PowerPoint, Jupyter notebooks, BibTeX, Org-mode, AsciiDoc, transcripts, Slack exports, email, calendar, structured config/data, developer manifests, images, and code
- add `--guide` when you want a resumable source session, source brief, source review, source guide, and approval-bundled canonical page edits when `profile.guidedSessionMode` is `canonical_review`, with `wiki/insights/` fallback for `insights_only`
- set `profile.guidedIngestDefault: true` when guided mode should be the default for `ingest`, and use `--no-guide` to force a plain ingest for one run
- code-aware directory ingest currently covers JavaScript, JSX, TypeScript, TSX, Bash/shell scripts, Python, Go, Rust, Java, Kotlin, Scala, Dart, Lua, Zig, C#, C, C++, PHP, Ruby, PowerShell, Elixir, OCaml, Objective-C, ReScript, Solidity, HTML, CSS, and Vue single-file components

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
- `--no-include-assets`
- `--max-asset-size <bytes>`

Repo ingest defaults to `first_party` material. The extra `--include-*` flags opt dependency trees, resource bundles, and generated output back in when you actually want them in the vault.

Large repo ingest now emits low-noise progress on materially large batches, and parser compatibility failures stay local to the affected source instead of aborting unrelated analysis.

### `swarmvault add <url>`

Capture supported URLs through a normalized markdown layer before ingesting them into the vault.

- arXiv abstract URLs and bare arXiv ids become durable markdown captures
- DOI URLs and bare DOI strings normalize into article-style research captures
- generic article URLs use a readability-style capture path with normalized research frontmatter
- X/Twitter URLs use a graceful public capture path
- unsupported URLs fall back to generic URL ingest instead of failing
- optional metadata: `--author <name>` and `--contributor <name>`
- normalized captures record fields such as `source_type`, `source_url`, `canonical_url`, `title`, `authors`, `published_at`, `updated_at`, `doi`, and `tags` when available
- use `source add` instead when the URL is a public GitHub repo root or a docs hub that should stay synced over time

### `swarmvault inbox import [dir]`

Import supported files from the configured inbox directory. This is meant for browser-clipper style markdown bundles, HTML clip bundles, and other capture workflows. Local image and asset references are preserved and copied into canonical storage under `raw/assets/`.

### `swarmvault compile [--approve]`

Compile the current manifests into:

- generated markdown in `wiki/`
- structured graph data in `state/graph.json`
- local search data in `state/search.sqlite`

The compiler also reads `swarmvault.schema.md` and records a `schema_hash` plus lifecycle metadata such as `status`, `created_at`, `updated_at`, `compiled_from`, and `managed_by` in generated pages so schema edits can mark pages stale without losing lifecycle state.

For ingested code trees, compile also writes `state/code-index.json` so local imports and module aliases can resolve across the repo-aware code graph.

New concept and entity pages are staged into `wiki/candidates/` first. A later matching compile promotes them into `wiki/concepts/` or `wiki/entities/`.

With `--approve`, compile writes a staged review bundle into `state/approvals/` without applying active wiki changes.

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

### `swarmvault query "<question>" [--no-save] [--format markdown|report|slides|chart|image]`

Query the compiled vault. The query layer also reads `swarmvault.schema.md`, so answers follow the vault’s own structure and grounding rules.

By default, the answer is written into `wiki/outputs/` and immediately registered in:

- `wiki/index.md`
- `wiki/outputs/index.md`
- `state/graph.json`
- `state/search.sqlite`

Saved outputs also carry related page, node, and source metadata so SwarmVault can refresh related source, concept, and entity pages immediately.

Human-authored pages in `wiki/insights/` are also indexed into search and query context, but SwarmVault does not rewrite them after initialization.

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

`--web` can only be used when deep lint is enabled, either explicitly with `--deep` or through `profile.deepLintDefault`. It enriches deep-lint findings with external evidence snippets and URLs from a configured web-search provider.

`--conflicts` filters the results down to contradiction-focused findings so you can audit conflicting claims without the rest of the lint output.

### `swarmvault watch [--lint] [--repo] [--once] [--code-only] [--debounce <ms>]`

Watch the inbox directory and trigger import and compile cycles when files change. With `--repo`, each cycle also refreshes tracked repo roots that were previously ingested through directory ingest. With `--once`, SwarmVault runs one refresh cycle immediately instead of starting a long-running watcher. With `--code-only`, SwarmVault forces the narrower AST-only refresh path and skips non-code semantic re-analysis until you run a normal `compile`. With `--lint`, each cycle also runs linting. Each cycle writes a canonical session artifact to `state/sessions/`, and compatibility run metadata is still appended to `state/jobs.ndjson`.

When `--repo` sees non-code changes under tracked repo roots, SwarmVault records those files under `state/watch/pending-semantic-refresh.json`, marks affected compiled pages stale, and exposes the pending set through `watch status` and the local graph workspace instead of silently re-ingesting them.

When `--repo` sees only code-file changes under tracked repo roots, SwarmVault takes the faster code-only path: it refreshes code pages and graph structure without re-running non-code semantic analysis for unchanged sources.

### `swarmvault watch status`

Show watched repo roots, the latest watch run, and any pending semantic refresh entries for tracked non-code repo changes.

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

The MCP surface also exposes `swarmvault://schema`, `swarmvault://sessions`, `swarmvault://sessions/{path}`, and includes `schemaPath` in `workspace_info`.

### `swarmvault graph serve`

Start the local graph workspace backed by `state/graph.json`, `/api/search`, `/api/page`, and local graph query/path/explain endpoints.

### `swarmvault graph query "<question>" [--dfs] [--budget <n>]`

Run a deterministic local graph traversal seeded from local search, graph labels, and matching group patterns.

### `swarmvault graph path <from> <to>`

Return the shortest high-confidence path between two graph targets.

### `swarmvault graph explain <target>`

Inspect graph metadata, community membership, neighbors, provenance, and group-pattern membership for a node or page.

### `swarmvault graph god-nodes [--limit <n>]`

List the most connected bridge-heavy nodes in the current graph.

### `swarmvault graph export --html|--html-standalone|--svg|--graphml|--cypher|--json|--obsidian|--canvas <output>`

Export the current graph as one or more shareable formats:

- `--html` for the full self-contained read-only graph workspace
- `--html-standalone` for a lighter vis.js export with node search, legend, and sidebar inspection
- `--svg` for a static shareable diagram
- `--graphml` for graph-tool interoperability
- `--cypher` for Neo4j-style import scripts
- `--json` for a deterministic machine-readable graph package
- `--obsidian` for an Obsidian-friendly markdown vault with one note per node plus community notes
- `--canvas` for an Obsidian canvas grouped by community

You can combine multiple flags in one run to write several exports at once.

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

### `swarmvault install --agent <codex|claude|cursor|goose|pi|gemini|opencode|aider|copilot|trae|claw|droid>`

Install agent-specific rules into the current project so an agent understands the SwarmVault workspace contract and workflow.

Hook-capable installs:

```bash
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

Hook semantics:

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

## Troubleshooting

- If you are running from a source checkout and `graph serve` says the viewer build is missing, run `pnpm build` in the repository first
- If a provider claims OpenAI compatibility but fails structured generation, declare only the capabilities it actually supports
- If `lint --deep --web` fails immediately, make sure a `webSearch` provider is configured and mapped to `tasks.deepLintProvider`
- If you still see a `node:sqlite` experimental warning on Node 24, upgrade to the latest CLI; current releases suppress that upstream warning during normal runs

## Links

- Website: https://www.swarmvault.ai
- Docs: https://www.swarmvault.ai/docs
- GitHub: https://github.com/swarmclawai/swarmvault
