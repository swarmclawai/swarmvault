# Changelog

## 0.1.5

- Added a compounding output loop with immediate output-page indexing for `query --save`
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
