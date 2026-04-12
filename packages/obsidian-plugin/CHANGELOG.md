# Changelog

## 0.7.30

- Prepared the plugin for community marketplace submission: rewrote the manifest description, removed disallowed fields, and moved the minimum CLI version into a new `cli-compat.json` that is bundled at build time rather than read from `this.manifest`.
- Copied the manifest to the repo root so the marketplace validator can fetch it from the standard URL.
- Tightened the release-sync check to enforce the marketplace allow-list of manifest keys and to require byte-identical plugin and root manifests.

## 0.7.29

- First Obsidian plugin release shipped alongside the monorepo.
- Status bar with workspace detection, compile freshness indicator, and running-command counter.
- Command palette entries: init, ingest, add, compile, lint, query from current note, ask, watch start/stop/once/status, graph viewer start/stop, verify CLI, open run log.
- Query from current note with four output modes (inline, append, wiki/outputs, ephemeral pane) and page_id to wikilink citation rewriting.
- Run Log pane streaming live stdout and stderr for every CLI invocation.
- Managed-processes registry that drains long-running watch and serve subprocesses on plugin unload.
- Windows `.cmd` shim fallback, ENOENT to `CliNotFoundError`, cancellable invocations with SIGTERM then SIGKILL 3s grace.

## 0.7.28 (initial scaffold)

- Package scaffolded with esbuild build, vitest test harness, manifest pinned to monorepo version.
- `SwarmVaultPlugin` loads and unloads cleanly; status bar indicator; settings tab with CLI path and Verify CLI button.
- Child-process wrapper (`src/cli/run.ts`) with `execFile`-based invocation, JSON parsing, async-iterable stdout/stderr streaming, cancellation, and Windows `.cmd` fallback.
- Release-sync check extended to pin plugin `package.json`, `manifest.json`, and `swarmvaultCliMinVersion` to the monorepo root version.
