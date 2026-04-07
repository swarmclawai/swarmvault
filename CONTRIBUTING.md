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

For published-package live smoke checks:

```bash
pnpm live:smoke:heuristic
pnpm live:smoke:ollama
OPENAI_API_KEY=... pnpm live:smoke:openai
```

See [docs/live-testing.md](./docs/live-testing.md) for the full live-testing workflow and manual checklist.

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

## Documentation Site

The documentation website lives in a **separate repository**: `swarmclawai/swarmvault-site`.

When you change CLI commands, add new features, or modify behavior:

- Update the corresponding MDX file in `web/src/content/docs/`
- If you add a new command or page, also update the navigation in `web/src/lib/docs-nav.ts`
- The docs site uses Next.js 16 with static export — run `npm run build` in `web/` to verify

This sync is currently manual. Documentation PRs should be opened against the `swarmvault-site` repository.

## Design Notes

SwarmVault is not trying to be a generic chat wrapper around a file upload. The intended contribution direction is toward a compounding vault workflow where outputs become reusable artifacts.
