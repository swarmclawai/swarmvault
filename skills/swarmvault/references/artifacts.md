# Artifact Reference

SwarmVault is save-first. The files on disk are the product.

## Canonical Inputs

- `swarmvault.schema.md` - vault instructions, naming rules, exclusions, freshness rules
- `raw/sources/` - immutable canonical sources
- `raw/assets/` - localized remote or imported assets

## Compiled Knowledge

- `wiki/sources/` - source pages
- `wiki/concepts/` and `wiki/entities/` - promoted canonical pages
- `wiki/code/` - parser-backed module pages
- `wiki/projects/` - project rollups
- `wiki/outputs/` - saved query and explore outputs
- `wiki/candidates/` - staged concept/entity pages
- `wiki/graph/report.md` - trust and orientation report

## State And Review

- `state/graph.json` - compiled graph artifact
- `state/search.sqlite` - local full-text index
- `state/code-index.json` - repo-aware symbol/import index
- `state/extracts/` - extraction markdown and JSON sidecars for PDF/image/doc sources
- `state/approvals/` - review bundles from `compile --approve`
- `state/benchmark.json` - latest benchmark/trust artifact
- `state/watch/` - pending semantic refresh and watch status artifacts
- `state/sessions/` - saved compile/query/explore/lint/watch history
- `state/jobs.ndjson` - watch run log

## How To Use These

- Read generated pages before re-asking the same question.
- Use report and approval artifacts to explain what changed.
- Prefer schema edits or new sources over editing generated provenance directly.
