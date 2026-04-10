# Changelog

## 0.7.21

- Added `profile.deepLintDefault` so vault profiles can make `swarmvault lint` run the advisory deep-lint pass by default, while `--no-deep` still forces a structural-only lint run when needed
- Updated the CLI, README surfaces, package docs, skill docs, and website configuration/lint docs so the new deep-lint default behavior is documented alongside the existing guided-ingest profile defaults

## 0.7.2

- Added a standalone `templates/llm-wiki-schema.md` starter so people can begin with the LLM Wiki pattern and the raw/wiki/schema three-layer architecture before installing the full CLI
- Added three new worked example vaults for chapter-by-chapter book companions, contradiction-aware research deep-dives, and personal Memex workflows, with real source material under `worked/` for docs and release validation
- Added `profile.guidedIngestDefault` so starter profiles such as `personal-research` can make guided ingest the default for `ingest`, `source add`, and `source reload`, while `--no-guide` still forces the lighter path when needed
- Reframed the OSS docs and published skill bundle around the LLM Wiki / Memex model, and tightened README parity checks so the English, Chinese, and Japanese READMEs stay aligned on the new template and example surfaces

## 0.7.1

- Fixed clean-checkout test runs by emitting the bundled engine hook scripts before `pnpm test`, and raised the tiny validation code-matrix timeout to stay stable on slower CI runners where repo ingest can legitimately exceed Vitest's default 5 second test limit

## 0.7.0

- Expanded non-code ingest coverage with the full Word family (`.docx`/`.docm`/`.dotx`/`.dotm`), Excel family (`.xlsx`/`.xlsm`/`.xlsb`/`.xls`/`.xltx`/`.xltm` including legacy biff8), and PowerPoint family (`.pptx`/`.pptm`/`.potx`/`.potm`), plus first-class Rich Text (`.rtf`), BibTeX (`.bib`), Org-mode (`.org`), AsciiDoc (`.adoc`/`.asciidoc`), OpenDocument (`.odt`/`.odp`/`.ods`), and Jupyter (`.ipynb`) extractors; broadened the image pipeline to explicitly route `.heic`/`.heif`/`.avif`/`.jxl`/`.bmp`/`.tif`/`.tiff`/`.svg`/`.ico` alongside `.png`/`.jpg`/`.webp`; and extended the structured-data preview to `.xml`/`.ini`/`.env`/`.properties`/`.cfg`/`.conf` so config/data files match what the README advertises
- Added parser-backed ingestion for Elixir (`.ex`/`.exs`), OCaml (`.ml`/`.mli`), Objective-C (`.m`/`.mm`, leaving `.h` headers routed through the C/C++ analyzer), ReScript (`.res`/`.resi`), Solidity (`.sol`), Vue single-file components (`.vue`), HTML (`.html`/`.htm`), and CSS (`.css`) sources via tree-sitter AST walkers, exposing each source's modules, classes, protocols, functions, inheritance edges, and import references through the existing module-page, graph, search, and code-index pipeline
- Restored Swift to the documented graceful-degradation path by disabling parser-backed Swift analysis by default, avoiding Node 24 V8 out-of-memory crashes during test and OSS-corpus runs while keeping an explicit opt-in escape hatch for local experiments
- Replaced several regex-shaped code import parsers with parser-backed AST extraction for Python, Go, Rust, Java, Kotlin, Scala, C#, PHP, and C/C++ includes, reducing brittle language handling and improving grouped import fidelity
- Hardened repo-aware code resolution for real multi-crate and multi-root projects by expanding Rust crate alias handling, stripping trailing symbol segments when imports target module files, and broadening Lua local module candidate resolution
- Refactored agent hook installation to ship built hook bundles from the engine package instead of embedding large inline hook scripts in source, keeping installed hook artifacts aligned with the packaged runtime
- Made MCP tool handlers fail per-request instead of crashing the whole stdio server, and isolated schedule-loop listing/job failures so one bad schedule no longer tears down the scheduler
- Tightened configuration defaults and release prep by centralizing workspace directory defaults and keeping the engine build wired for bundled hooks

## 0.6.7

- Added a one-time interactive heuristic-provider notice for compile/query/explore so default local users are pointed at a stronger fully-local Ollama + Gemma setup without leaking notices into `--json`, CI, MCP, or long-running flows
- Improved graph benchmark honesty and CLI reporting so reduction ratios can go negative on tiny vaults instead of being silently clamped to zero, making small-corpus graph results easier to interpret correctly
- Hardened repo-aware code analysis for real-world imports by fixing TypeScript runtime-extension sibling resolution, Rust crate-root `mod` / `crate::` alias handling, Ruby bare `require_relative` sibling resolution, and PowerShell dot-source imports that use `$PSScriptRoot`
- Added deterministic export-safety coverage for hostile HTML/XML graph strings plus a real Cursor `.mdc` rule file with `alwaysApply: true`, and updated installed-package smoke to verify the published CLI writes the expected Cursor rule artifact
- Tightened non-code and lint quality by avoiding obvious false entities like `The`/`This` when parser-backed analysis can identify real named terms, and by preventing `uncited_claims` from firing on the compiler's own `No claims extracted.` placeholder bullet

## 0.6.6

- Fixed installed-CLI handling for common real-world text files and scripts so extensionless executable `node`, `python`, and `ruby` shebang scripts are classified as code, TypeScript family files use a correct `text/typescript` mime, and common config, manifest, lock, license, and dotfiles no longer fall through as unsupported binary sources
- Fixed multiple path-boundary checks to use a real directory fence instead of naive string prefix checks, closing sibling-prefix traversal bugs in page reads, viewer asset/page serving, inbox attachment resolution, and MCP session resource loading
- Fixed source brief, source review, source guide, and source session artifacts so their `schemaHash` tracks the effective vault schema instead of the graph timestamp, avoiding false freshness churn and misattributed artifact invalidation after compile-only changes
- Fixed `uncited_claims` linting so it only inspects the actual `## Claims` section instead of unrelated bullets or embedded source text elsewhere in the page, and hardened the viewer server to return structured 500 responses instead of dropping the request on handler errors

## 0.6.5

- Fixed source-page, source-brief, source-review, and query context shaping so non-code sources keep their stable manifest titles instead of leaking body snippets and extracted metadata into headings, summaries, and review artifacts
- Replaced brittle markdown title cleanup in source analysis with a markdown-AST-backed path, reducing false title/body conflation on normal markdown and other text-heavy sources
- Fixed no-op managed file re-adds so unchanged `source add` runs no longer trigger compile/brief side effects or promote unrelated pages
- Tightened packaged smoke coverage for the installed CLI path, including clean source-page title assertions for markdown, transcript, and email sources plus a less brittle semantic-graph query check based on seeded source nodes and embedding-backed traversal

## 0.6.4

- Suppressed the noisy Node 24 `node:sqlite` ExperimentalWarning during normal CLI search-index and search-query runs so installed-package users no longer get spurious stderr output on the default local path
- Fixed managed file sources so a missing backing file now clears stale `lastSyncCounts` instead of preserving the last successful import counts while reporting `status: "missing"`
- Corrected source-generated artifact metadata so source briefs, source reviews, source guides, and source sessions carry their real `origin` values instead of being mislabeled as generic query outputs
- Added regression coverage for the missing-file managed-source case, the source-artifact origin metadata, and installed-package warning leakage in both the packaged smoke lane and the OSS corpus lane

## 0.6.3

- Added a release-sync guard that verifies root, CLI, engine, viewer, MCP/server, and skill versions stay aligned before publish, and wired that guard into both `pnpm check` and every package `prepublishOnly` hook
- Added a one-command `pnpm release:preflight` path that builds local tarballs and proves the installed-package workflow through heuristic smoke, browser smoke, and the OSS corpus before release
- Expanded CI and post-release automation so pull requests run a tarball-installed packaged smoke lane, while release/manual live-smoke automation now also covers the browser-verified heuristic path and the OSS corpus
- Clarified the live-testing scripts so published-package audits and local tarball preflight validation are clearly separated, reducing false confidence when testing unreleased changes

## 0.6.2

- Added parser-backed Bash and Dart code ingestion, including tree-sitter-backed function, import, type, and call extraction wired through the existing module-page, graph, search, and code-index pipeline
- Added repo-aware Bash include resolution for `source` and `.` plus Dart import resolution for relative imports and same-package `package:` imports using `pubspec.yaml`
- Added shebang-aware detection for extensionless executable shell scripts during local and repo ingest so shell-heavy repositories are indexed without requiring a `.sh` suffix
- Expanded the tiny validation matrix, code-ingestion tests, tarball-installed smoke coverage, localized README trio, package READMEs, skill docs, and site docs for the new Bash/shell and Dart support surfaces

## 0.6.1

- Added a configurable `profile` layer in `swarmvault.config.json` with composable `presets`, `dashboardPack`, `guidedSessionMode`, and `dataviewBlocks`, while keeping `personal-research` as a starter alias and allowing `swarmvault init --profile reader,timeline`-style preset composition
- Upgraded guided sessions so `canonical_review` profiles stage approval-queued edits for canonical `wiki/sources/`, `wiki/concepts/`, and `wiki/entities/` pages when confidence is high enough, with explicit fallback to `wiki/insights/` for exploratory or low-confidence updates
- Expanded dashboard and guided-artifact frontmatter with Dataview-friendly fields such as `profile_presets`, `session_status`, `question_state`, `canonical_targets`, and `evidence_state`, while keeping every dashboard readable as plain markdown when Dataview blocks are disabled
- Updated the CLI docs, ClawHub skill bundle, localized README trio, and site docs so the installed product describes configurable profiles, composable recipes, guided-session routing, and Obsidian-first dashboard behavior consistently

## 0.6.0

- Turned guided ingest into durable guided source sessions, so `swarmvault ingest --guide`, `swarmvault source add --guide`, `swarmvault source reload --guide`, and the new `swarmvault source session <id>` now create resumable session state under `state/source-sessions/` and markdown anchors under `wiki/outputs/source-sessions/`
- Kept guided work inside the existing approval queue while upgrading it to stage real durable integration artifacts, with clear labeling for source-review, source-guide, and guided-update entries plus accept/reject status flowing back into the saved session state
- Expanded the personal-research profile and dashboards so research-oriented vaults surface active source sessions, pending guided bundles, accepted guided updates, and reading/thesis activity directly in `wiki/dashboards/`
- Updated packaged smoke coverage, skill docs, localized README parity, and site docs so the installed CLI proves the full guided-session path instead of the older one-shot guide wording

## 0.5.0

- Added guided-ingest workflows with `swarmvault ingest --guide`, `swarmvault source add --guide`, `swarmvault source reload --guide`, and `swarmvault source guide <id>`, all built on the existing approval system with labeled guided bundles instead of a separate review subsystem
- Added `swarmvault init --profile personal-research`, a more opinionated research-oriented starter schema, and new vault guidance that steers one-source-at-a-time integration, evolving summaries, open questions, and thesis tracking
- Added integration-oriented source guide artifacts under `wiki/outputs/source-guides/` plus new markdown-first dashboards for reading progress, guided-source activity, and research-map navigation
- Expanded deterministic tests, packaged live-smoke coverage, and release docs for guided ingest so the tarball- and npm-installed CLI now prove guide bundle staging, dashboard generation, and source-led approval labeling end to end

## 0.4.0

- Added first-class personal-knowledge ingest for transcripts (`.srt`, `.vtt`), Slack exports, email (`.eml`, `.mbox`), and calendar files (`.ics`) using parser- and library-backed extraction instead of code-first heuristics
- Added grouped-source normalization for human-export inputs, source-scoped review generation under `wiki/outputs/source-reviews/`, and `--review` support for both `swarmvault ingest` and managed sources
- Added markdown-first dashboard pages under `wiki/dashboards/` for recent sources, timeline, contradictions, and open questions so vaults stay navigable in plain Obsidian-style workflows
- Fixed the expanded tiny-matrix CI instability by splitting the code and local-source matrices, increasing the non-code timeout, hardening temp-dir cleanup, and proving the new personal-knowledge flow through tarball-installed heuristic/browser smoke

## 0.3.0

- Broadened non-code ingest so SwarmVault now treats books, datasets, spreadsheets, and slide decks as first-class sources with library-backed EPUB, CSV/TSV, XLSX, and PPTX extraction instead of repo/code-only workflows
- Added grouped multi-part ingest support and a uniform single-input summary envelope so one source file can expand into multiple manifests safely, including chapter-split EPUB ingestion with stable group metadata and stale-part pruning
- Expanded source-page rendering, searchable extracted text, validation fixtures, installed-package heuristic smoke, localized README parity, ClawHub skill docs, and site copy for mainstream knowledge-work sources rather than code-first messaging

## 0.2.2

- Added frontmatter-aware markdown semantic hashing so compile and analysis caches ignore operational frontmatter churn while still invalidating on title, summary, aliases, tags, authors, publication, canonical URL, and source-type changes
- Added large-graph overview mode for `swarmvault graph serve` and `swarmvault graph export --html`, including deterministic sampling, viewer presentation metadata, and `--full` escapes for rendering the complete canvas
- Tightened local embeddings UX by making embedding-capable backends explicit in docs and runtime errors, adding Ollama-first local examples, and adding an opt-in installed-package smoke lane for local embeddings
- Expanded installed-artifact validation to cover overview-mode graph presentation on packaged builds, including browser-backed proof for the standard graph workspace plus tarball-installed overview checks

## 0.2.1

- Added parser-backed Lua and Zig code ingestion, including repo-aware module/import resolution, module pages, code-index integration, and graph/search coverage through the existing local analyzer pipeline
- Updated the tiny validation matrix and code-ingestion tests to require Lua, Zig, JSX, and TSX so packaged releases keep proving the full shipped code-language set instead of relying on docs-only claims
- Corrected the OSS README trio, package READMEs, ClawHub skill docs, and site support tables so they accurately list the languages and file types already supported today, including JSX, TSX, reStructuredText, Lua, and Zig
- Tightened the packaged live-smoke gate so the required heuristic/browser release path remains focused on SwarmVault correctness, while the slower OpenCode host-agent smoke stays available as an explicit opt-in check

## 0.2.0

- Added first-class managed sources with `swarmvault source add|list|reload|delete`, a persistent `state/sources.json` registry, transient source workspaces under `state/sources/`, and auto-generated source briefs under `wiki/outputs/source-briefs/`
- Added public GitHub repo root URL import for managed sources, using shallow checkouts plus the existing repo-aware ingest, compile, graph, and search pipeline instead of a separate remote-repo path
- Added bounded same-domain docs crawl for recurring documentation sources, with docs-hub detection, crawl limits, localized page ingest, and deterministic fallback briefs when provider-backed briefing is unavailable
- Expanded deterministic tests and installed-package heuristic smoke to cover managed local directory sources, docs crawl, source briefs, and the real tarball-installed `source` workflow
- Upgraded the published ClawHub/OpenClaw skill from a single-file instruction bundle into a verification-ready text package with a dedicated README, examples, references, troubleshooting guide, and validation prompts
- Added repo-level ClawHub skill validation plus a publish helper so `pnpm check` verifies the skill bundle shape, version sync, metadata, and listing content before release
- Added explicit ClawHub install, update, and post-publish inspect guidance to the OSS docs and site install docs so the skill release flow stays aligned with the real published CLI workflow

## 0.1.33

- Added parser-backed Kotlin and Scala code ingestion, including vendored WASM grammar loading, package-aware symbol/import extraction, and repo-aware module-page generation
- Added explicit `.rst` and `.rest` ingest support with lightweight heading and directive normalization so reStructuredText sources remain searchable and analyzable without a separate rendering step
- Hardened tree-sitter compatibility handling so missing or incompatible grammar/runtime paths produce source-local diagnostics instead of aborting unrelated code analysis
- Added low-noise progress reporting for large ingest and compile batches, and rolled up tiny fragmented communities in graph-report presentation without mutating the canonical graph
- Expanded the tiny validation matrix, installed-artifact smoke checks, package docs, localized root READMEs, site docs, and skill metadata for the new Kotlin, Scala, and `.rst` surfaces

## 0.1.32

- Fixed a watch shutdown race so `watchVault().close()` waits for any in-flight watch cycle to finish before returning, preventing late file writes from racing temp-workspace cleanup and automation teardown

## 0.1.31

- Added deterministic contradiction detection that compares claims across sources by topic overlap and opposing polarity, surfaces `contradicts` edges in the graph, and writes a Contradictions section to `wiki/graph/report.md`
- Added `swarmvault lint --conflicts` for contradiction-focused findings, with optional LLM-powered contradiction detection through `--deep`
- Added semantic auto-tagging during analysis that extracts up to 5 broad domain tags per source, propagated to page frontmatter, graph nodes, and search
- Added section-level change summaries to `swarmvault review show` so approval entries describe what changed without needing to read full diffs
- Added `swarmvault review show --diff` for unified diff output between current and staged page content
- Bumped analysis format version to 6 so existing cached analyses regenerate with the new tags field
- Added full-parity English, Simplified Chinese, and Japanese OSS README support with a parity check wired into `pnpm check`

## 0.1.30

- Added `swarmvault graph push neo4j` plus `graphSinks.neo4j` config, shared-database-safe `vaultId` namespacing, first-party-default filtering, dry-run reporting, and upsert-only Bolt/Aura sync through the official Neo4j driver
- Refactored graph interchange mapping so Cypher export and Neo4j push share the same stable node, relationship, hyperedge, and group-member normalization logic instead of drifting between two schemas
- Added direct graph-sink tests plus a Docker-backed Neo4j live-smoke lane, while documenting the local Docker daemon requirement for that validation path
- Hardened URL-based ingest and remote asset fetches by validating resolved addresses and blocking private or reserved IP targets before fetch
- Fixed the site docs renderer so richer markdown no longer hangs static generation on deeper heading levels, and replaced the worst inline markdown regex loop with a bounded scanner

## 0.1.29

- Added first-class DOCX ingest with local text and metadata extraction, expanded inbox import to preserve browser-style HTML clip bundles with rewritten local assets, and refreshed the docs/README screenshot from a real packaged viewer run
- Hardened packaged validation with an opt-in browser-backed heuristic smoke lane that exercises `graph serve` and standalone exported HTML through real Chromium selection, path highlighting, and deselection
- Improved the local viewer with Claude’s redesigned layout and interaction polish, then added embedded-graph fallbacks for `graph path` and `graph explain` so standalone exports no longer depend on live API routes for those interactions
- Fixed the Claude hook install to use a generated helper script plus structured `additionalContext`, hardened Cypher export escaping, improved Go same-package receiver/method resolution, and added viewer/browser regression coverage for those paths
- Included the local hardening fixes from the parallel bug-fix pass: safer CLI integer parsing and shutdown handling, more resilient watch/log persistence, tighter JSON extraction and truncation helpers, and embedding-cache reads that skip unreadable pages without aborting the run

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
