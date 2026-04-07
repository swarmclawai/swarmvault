# Changelog

## Unreleased

Nothing yet.

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
