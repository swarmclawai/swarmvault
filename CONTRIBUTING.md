# Contributing

SwarmVault is early-stage. Contributions are welcome, but changes should preserve the core product direction:

- Local-first by default
- Markdown and graph artifacts as first-class outputs
- Provenance and anti-drift over "magic"
- Provider flexibility without hard-coding a single vendor

## Setup

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

## Pull Requests

- Keep changes scoped and intentional
- Update docs when behavior changes
- Add or adjust tests when the runtime behavior changes
- Do not remove provenance, freshness, or compatibility checks to make a feature easier to ship

## Repo Structure

- `packages/engine`: ingest, compile, query, lint, providers, and graph/search generation
- `packages/cli`: the `swarmvault` command
- `packages/viewer`: the local graph UI used by `swarmvault graph serve`

## Issues

If you are filing a bug, include:

- Node version
- Provider type and model
- Reproduction steps
- Expected behavior
- Actual behavior

## Design Notes

SwarmVault is not trying to be a generic chat wrapper around a file upload. The intended contribution direction is toward a compounding vault workflow where outputs become reusable artifacts.
