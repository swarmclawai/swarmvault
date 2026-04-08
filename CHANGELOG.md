# Changelog

## Unreleased

Nothing yet.

## 0.1.28

- Added `aider` and `copilot` as first-class `swarmvault install --agent` targets, while expanding install results to return the primary `target`, all touched `targets`, and safe merge warnings
- Added graph-first hook/plugin installs for `opencode`, `gemini`, and `copilot`, alongside the existing Claude hook path, and kept Aider intentionally file/config-based with a YAML-backed `.aider.conf.yml` merge
- Hardened generated git hooks so they prefer the resolved `swarmvault` executable path and only fall back to `command -v swarmvault`, avoiding PATH-only install failures
- Expanded engine tests, installed-artifact smoke coverage, OSS docs, site docs, and skill metadata for the new agent targets, hook artifacts, and live installed-package validation path

## 0.1.27

- Added a small pinned live OSS validation corpus plus a per-language/per-source-type tiny matrix, keeping the release gate focused on small real repos and fast deterministic fixtures instead of expensive large-repo runs
- Fixed local HTML file ingest so `.html` sources are classified as `html` and get readability-style extracted text before analysis, search, and source-page generation
- Hardened the installed-package smoke runner around the new tiny matrix and agent-CLI checks, including more robust OpenCode validation against the live installed package path
- Refreshed the local graph viewer UI with a more deliberate graph-first layout, componentized panels, and updated docs screenshots captured from the live redesigned viewer
- Updated OSS docs, site docs, and release-validation docs for the new OSS corpus workflow, tiny validation matrix, and screenshot-sync process
## 0.1.26

- Added interactive-only CLI notices with a cached update prompt, a one-time repo-star prompt, and `SWARMVAULT_NO_NOTICES=1`, while keeping those notices disabled for `--json`, CI, MCP, and long-running serve/watch flows
- Added real screenshot-backed docs updates plus richer worked examples across the README and site, and documented the release/test workflow so docs stay in sync with shipped behavior
- Added optional embedding-backed semantic graph query with `tasks.embeddingProvider`, incremental vector caching in `state/embeddings.json`, and `similarityBasis` on `semantically_similar_to` edges
- Added repo-aware `sourceClass` handling for `first_party`, `third_party`, `resource`, and `generated` material, including first-party-default directory ingest, source-class filters in search/viewer, and graph-report warnings/breakdowns for large mixed repos
- Expanded engine tests, provider-registry coverage, and installed-artifact smoke validation to cover semantic graph query, source-class classification, and the real packaged install path

## 0.1.25

- Fixed the published `@swarmvaultai/cli` manifest so real npm installs resolve `@swarmvaultai/engine` to the released semver instead of an invalid `workspace:*` dependency
- Hardened the installed-package smoke runner by isolating npm cache state under the smoke artifact directory, avoiding machine-local `~/.npm` cache corruption from producing false failures
- Re-ran the tarball-installed and live npm-installed release gates after the packaging fix so the graph-quality release is validated against the same artifacts users actually install

## 0.1.24

- Added compile-time graph enrichment with deterministic `semantically_similar_to` edges, bounded `similarityReasons`, and first-class `hyperedges` derived from multi-node graph motifs instead of ad hoc report-only heuristics
- Upgraded `wiki/graph/report.md` and the new `wiki/graph/report.json` companion with stronger surprise scoring, explicit `why` explanations, supporting path relations/evidence classes, and a new `Group Patterns` section grounded in hyperedge data
- Expanded graph tooling across `graph query`, `graph explain`, GraphML/Cypher export, MCP, and the local workspace so similarity edges and group patterns are queryable, explorable, and exported instead of being hidden inside markdown only
- Updated engine tests, OSS docs, site docs, and the root spec notes for the richer graph-quality model while explicitly keeping deeper hyperedge visualization and direct Neo4j push deferred

## 0.1.23

- Expanded `swarmvault add` from arXiv/X capture into a broader research-aware capture surface with DOI URLs, bare DOI strings, and generic article URLs that normalize into markdown with stable research frontmatter such as `source_type`, `canonical_url`, `authors`, `published_at`, and `tags`
- Added automatic benchmark refresh on successful compile and repo-refresh-driven compile runs, keeping `state/benchmark.json` current by default instead of requiring a separate manual benchmark step
- Added `wiki/graph/report.json` as a machine-readable graph report companion and upgraded the markdown report plus local graph workspace with benchmark freshness, surprising-connection summaries, recent research-source surfacing, and source-type filtering
- Expanded engine tests, packaged smoke coverage, and OSS/site docs to validate DOI/article capture, benchmark/report freshness transitions, and the richer graph-report trust surfaces

## 0.1.22

- Added first-class mixed-corpus extraction artifacts under `state/extracts/`, keeping extracted markdown in `state/extracts/<sourceId>.md` and adding JSON sidecars with extractor metadata, warnings, provider/model info, and PDF page counts
- Added local PDF text extraction with `pdfjs-dist` so PDF sources contribute real extracted text, analysis, search context, and citations instead of degrading to the old empty-source placeholder
- Added image-aware extraction through the configured `visionProvider`, including structured OCR/diagram extraction when a real multimodal provider is available and explicit warning propagation when image extraction cannot run
- Expanded engine tests and installed-package heuristic smoke coverage to validate PDF extraction, image extraction, and mixed-corpus ingest through the packed npm artifacts

## 0.1.21

- Added `swarmvault add <url>` as an opinionated capture layer for arXiv IDs/URLs and X/Twitter URLs, with graceful fallback to generic URL ingest when a specialized capture is unavailable
- Added `swarmvault benchmark` plus `state/benchmark.json`, and surfaced benchmark summaries in `wiki/graph/report.md` to make graph-guided context reduction measurable instead of implied
- Added `swarmvault watch status` plus pending semantic refresh tracking under `state/watch/` so non-code repo changes are reported, logged, and marked stale instead of being silently skipped
- Expanded `swarmvault graph export` with deterministic `--svg`, `--graphml`, and `--cypher` outputs in addition to the existing HTML export
- Added worked example vault documentation, updated the OSS/site docs for the new capture, benchmark, watch, and graph-export surfaces, and fixed the repo-watch test race that flaked CI after `v0.1.20`

## 0.1.20

- Added repo-aware watch automation with `swarmvault watch --repo` plus `swarmvault watch --repo --once` so tracked repo roots refresh through the same pipeline as inbox automation
- Added `swarmvault hook install|uninstall|status` with marker-based `post-commit` and `post-checkout` git hooks that run repo-aware one-shot refreshes from the vault root
- Added `swarmvault install --agent claude --hook` to install the recommended Claude Code graph-first pre-search hook alongside `CLAUDE.md`
- Expanded parser-backed code ingestion with Ruby and PowerShell while documenting Kotlin, Swift, and Scala as still deferred until matching vendored parser assets are available
- Updated OSS docs, the site docs, and the ClawHub skill for the new watch, hook, Claude hook, and code-language surfaces

## 0.1.19

- Added graph-first orientation pages under `wiki/graph/`, including a top-level report plus per-community summaries generated from the compiled graph
- Added deterministic local graph navigation with `graph query`, `graph path`, `graph explain`, and `graph god-nodes`, plus matching read-only MCP graph tools
- Added parser-backed code rationale nodes and `rationale_for` edges while explicitly keeping non-code rationale extraction deferred until it can be implemented without regex-first document sweeps
- Updated the OSS docs, site docs, and spec notes for the new graph surfaces, graph trust semantics, and deferred export/non-code rationale gaps

## 0.1.18

- Replaced the regex-style non-JS/TS code path with parser-backed local analyzers for Python, Go, Rust, Java, C#, C, C++, and PHP, while keeping the TypeScript compiler path for JavaScript and TypeScript
- Added repo-aware directory ingest, `repoRelativePath` manifests, and `state/code-index.json` so local imports can resolve across an ingested repo tree
- Expanded module pages, graph edges, engine tests, and the installed-package smoke runner to cover repo-directory ingest plus the new code-language set
- Updated the OSS docs, package READMEs, skill metadata, site docs, and root spec for the parser-backed code-analysis and repo-ingest workflow

## 0.1.17

- Added `opencode` as an `install --agent` target, sharing the managed `AGENTS.md` rules path with Codex, Goose, and Pi
- Expanded the published-package smoke runner with an Anthropic lane plus optional Codex, Claude Code, and OpenCode agent-CLI checks when local binaries and credentials are available
- Updated OSS docs, the ClawHub skill, and the public site docs to list `opencode` alongside the other supported agent-rule targets

## 0.1.16

- Fixed the CLI `--version` output to read from the installed package metadata at runtime instead of a stale hardcoded string
- Re-ran the published-install smoke path after release to catch version-surface drift in the real npm package

## 0.1.15

- Added `swarmvault install --agent goose|pi|gemini`, with shared `AGENTS.md` handling for Codex, Goose, and Pi plus `GEMINI.md` support for Gemini CLI
- Added named provider presets for `openrouter`, `groq`, `together`, `xai`, and `cerebras` as first-class config types over the OpenAI-compatible adapter
- Expanded code-aware ingestion beyond JS/TS to include Python, Go, Rust, and Java module pages, graph nodes, and code relations
- Added regression coverage for the new provider presets, multi-language code ingestion, and the new agent install targets
- Updated OSS docs, package READMEs, the ClawHub skill, and the public site docs for the new agent, provider, and code-language surfaces

## 0.1.14

- Fixed the published CLI manifest so real `npm install -g @swarmvaultai/cli` resolves `@swarmvaultai/engine` to the released semver instead of a `workspace:*` dependency
- Re-ran the published-install OpenAI smoke lane against the registry package after publish to confirm `0.1.14` installs and passes with `gpt-4o-mini`
- Updated live-testing docs to note that tarball preflight validation must use `pnpm pack`, not raw `npm pack`, when workspace dependencies are involved

## 0.1.13

- Fixed the OpenAI provider structured-output path so `gpt-4o-mini` and other strict-schema models work for provider-backed `lint --deep`, including Responses API payload extraction, strict JSON-schema normalization, and null-placeholder cleanup before Zod parsing
- Added provider regression coverage for OpenAI structured responses and optional-field normalization, plus a successful installed-path OpenAI smoke run with `gpt-4o-mini`
- Updated the SwarmVault ClawHub/OpenClaw skill frontmatter to the parser-safe JSON metadata shape with explicit installer metadata so skill catalog/install metadata stays consistent with the documented OpenClaw format

## 0.1.12

- Added remote image localization for HTML and markdown URL ingests, with local asset copies under `raw/assets/<sourceId>/`, rewritten local markdown links, and non-fatal size-limited fetch control through `swarmvault ingest --no-include-assets` plus `--max-asset-size`
- Added regression coverage for HTML URL localization, markdown URL localization, and oversized-asset skip behavior without failing ingest
- Expanded the installed-package live smoke runner to validate remote URL asset capture and to support local tarball preflight installs before publish
- Updated `spec.md`, OSS docs, and site docs to remove stale “missing” items like `wiki/log.md` and to document the shipped remote-asset ingest behavior

## 0.1.11

- Fixed saved `query` and `explore` refreshes so they no longer auto-promote staged candidate concept and entity pages outside the compile flow
- Added a regression test for preserving candidate pages across output-save graph/index refreshes
- Expanded the published-install live smoke lane to validate project-aware code ingestion, candidate and review flows, richer graph workspace APIs, watch automation, and MCP search/chart queries

## 0.1.10

- Fixed provider-backed `lint --deep` and orchestration parsing so non-canonical model severities like `medium`, `critical`, or `low` normalize after structured parsing instead of breaking JSON-schema generation
- Added a regression test that exercises the JSON-schema path used by provider-backed deep lint
- Updated the published-install smoke documentation and site MCP/install docs to reflect the current validation and query format behavior

## 0.1.8

- Fixed the MCP `query_vault` tool schema so it accepts the shipped `chart` and `image` output formats
- Expanded the published-package live smoke coverage to validate saved visual outputs, standalone graph export, and approval-gated scheduled query runs from a real npm install
- Updated the OSS release docs for the broader `0.1.8` live validation flow

## 0.1.7

- Added `chart` and `image` output formats for `query` and `explore`, with local wrapper pages in `wiki/outputs/` plus asset bundles in `wiki/outputs/assets/`
- Added graph/viewer/export support for saved visual assets through `output_assets`, `/api/asset`, and standalone HTML embedding
- Added config-backed scheduling with `swarmvault schedule list|run|serve` for recurring `compile`, `lint`, `query`, and `explore` jobs
- Added approval-gated scheduled `query` and `explore` writes so automated outputs stage through review instead of activating immediately
- Added role-based orchestration config for `research`, `audit`, `context`, and `safety`, plus integrations in deep lint, explore, and compile post-pass staging
- Updated the OSS docs, package READMEs, ClawHub skill, changelog, and site docs for the v0.1.7 visual-output, scheduling, and orchestration workflows

## 0.1.6

- Added a reviewable compile flow with `compile --approve`, `review list|show|accept|reject`, `candidate list|promote|archive`, and matching viewer/server approval and candidate queues
- Added JS/TS code-aware ingestion with parser-backed module analysis, `wiki/code/` module pages, module and symbol graph nodes, and code relations such as imports, exports, defines, calls, extends, and implements
- Added project-aware vault organization with `projects` config, layered root-plus-project schemas, `project_ids` metadata, `wiki/projects/` rollups, project-aware search and viewer filters, and expanded Obsidian workspace defaults
- Added richer graph workspace behavior with local search and page APIs, standalone `graph export --html`, backlink and related-page preview navigation, and embedded-data exports for offline sharing
- Updated the OSS docs, package READMEs, live-testing docs, and the public site docs to reflect the current review, code-ingestion, project-schema, graph-workspace, and Obsidian workflows

## 0.1.5

- Added a save-first compounding output loop with immediate output-page indexing for `query`
- Added `swarmvault explore` for save-first multi-step research flows and hub-page generation
- Added advisory `lint --deep` plus optional `lint --deep --web` evidence gathering through pluggable web-search adapters
- Added output relationship metadata and compile-time `Related Outputs` sections on source, concept, and entity pages
- Hardened watch-mode retries, incremental compile artifact validation, grounded query citations, and `watch --json` inbox reporting
- Updated OSS docs and site docs for the compounding workflow and deep-lint configuration

## 0.1.4

- Added the schema layer with canonical `swarmvault.schema.md` creation during `swarmvault init`
- Threaded schema guidance through compile and query so each vault can define its own naming rules, categories, grounding expectations, and exclusions
- Added `schema_hash` tracking to generated pages and stale-page linting when the schema changes
- Exposed schema metadata through MCP with `swarmvault://schema` and `schemaPath` in `workspace_info`
- Updated OSS docs and site docs to explain the schema-guided workflow

## 0.1.3

- Added local MCP support with `swarmvault mcp`, tool registration, and read-oriented MCP resources
- Added inbox capture workflows with `swarmvault inbox import` and attachment-aware markdown bundle imports
- Added local automation with `swarmvault watch` and structured run logs in `state/jobs.ndjson`
- Updated the OSS docs and package READMEs to reflect the current workflow and canonical website URL

## 0.1.2

- Bundled the built graph viewer assets into `@swarmvaultai/engine` so `npm install -g @swarmvaultai/cli` works without fetching the viewer package at install time
- Kept the public docs and package metadata improvements from `0.1.1`

## 0.1.1

- Rewrote the public repo and package documentation to explain the product, workflow, and install path
- Added repository metadata, license metadata, and publish-ready package manifests
- Made `@swarmvaultai/viewer` a public publishable package
- Kept the globally installed command as `swarmvault` with `vault` as a compatibility alias

## 0.1.0

- Initial open source release of the SwarmVault engine and CLI
- Added the local-first vault workflow: `init`, `ingest`, `compile`, `query`, `lint`, `graph serve`, and `install`
- Added the first graph viewer and provider abstraction layer
