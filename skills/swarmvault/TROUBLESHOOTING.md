# Troubleshooting

## `swarmvault` command not found

The ClawHub skill does not bundle the CLI binary by itself. Install the published package and verify it:

```bash
npm install -g @swarmvaultai/cli
swarmvault --version
```

If the binary still is not found, check that npm's global bin directory is on `PATH`.

## Node version too old

SwarmVault requires Node `>=24`.

```bash
node --version
```

Upgrade Node before troubleshooting provider or compile behavior.

## The vault compiles, but quality is weak

Check whether the vault is still using the built-in `heuristic` provider. That is a valid local/offline default, but its synthesis is intentionally lighter. Add a model provider in `swarmvault.config.json` when you want richer synthesis quality or optional capabilities such as embeddings, vision, or image generation.

For local semantic graph query, `embeddingProvider` must point at an embedding-capable backend such as `ollama` or another OpenAI-compatible embeddings service. The built-in `heuristic` provider does not generate embeddings.

## Audio or video files ingest, but no transcript appears

Audio and video ingest need `tasks.audioProvider` to point at a provider with `audio` capability. Without that, SwarmVault still ingests the source and records an extraction warning instead of failing the whole run.

The quickest fully-local fix is `swarmvault provider setup --local-whisper --apply`, which installs a `local-whisper` provider (whisper.cpp shell-out), downloads the default ggml model into `~/.swarmvault/models/`, and wires `tasks.audioProvider` at it. If the command reports the binary missing, install whisper.cpp first (`brew install whisper-cpp` on macOS, `sudo apt install whisper.cpp` on Debian/Ubuntu) and re-run. Override binary or model paths with `localWhisper.binaryPath` / `localWhisper.modelPath` in `swarmvault.config.json` or `SWARMVAULT_WHISPER_BINARY` in the environment.

Local video extraction also needs `ffmpeg` on PATH or `SWARMVAULT_FFMPEG_BINARY`. Public video URL ingest with `swarmvault ingest --video <url>` or `swarmvault add --video <url>` needs `yt-dlp` on PATH or `SWARMVAULT_YTDLP_BINARY`.

YouTube transcript ingest does not need a model provider, but it can still fail when the video has no accessible captions or the upstream transcript fetch path is unavailable.

## Source reviews or dashboards did not appear

If you expected a source-scoped guide or review page, use one of these flows:

```bash
swarmvault ingest <input> --guide
swarmvault source add <input> --guide
swarmvault source session <source-id-or-session-id>
```

Then verify:

- `wiki/outputs/source-briefs/`
- `wiki/outputs/source-sessions/`
- `wiki/outputs/source-guides/`
- `wiki/dashboards/index.md`
- `wiki/dashboards/timeline.md`
- `wiki/dashboards/source-sessions.md`
- `wiki/dashboards/source-guides.md`
- `state/approvals/`

## `wiki/graph/report.md`, share kit, or search artifacts are missing

Run:

```bash
swarmvault compile
swarmvault doctor
```

Then verify:

- `wiki/graph/report.md`
- `wiki/graph/share-card.md`
- `wiki/graph/share-card.svg`
- `wiki/graph/share-kit/`
- `state/graph.json`
- `state/retrieval/`

If the vault lives inside git and you want a quick graph-level delta, run `swarmvault diff`.

## Artifacts appear in the wrong directory

Check whether `SWARMVAULT_OUT` is set:

```bash
echo "$SWARMVAULT_OUT"
```

When it is set, generated `raw/`, `wiki/`, `state/`, `agent/`, and `inbox/` directories resolve under that output root. `swarmvault.config.json` and `swarmvault.schema.md` remain in the project root.

## Graph status reports stale

Run:

```bash
swarmvault graph status .
```

If it recommends `swarmvault graph update`, the detected changes are code-only and can use the faster graph refresh path. If it recommends `swarmvault compile`, graph/report artifacts are missing, a non-code tracked source changed, or a pending semantic refresh already exists.

## Vault doctor reports warnings

`swarmvault doctor` is the broad health summary. It checks graph artifacts, retrieval, review queues, watch state, migrations, managed sources, and task ledgers, then prints concrete follow-up commands. The `swarmvault graph serve` workbench shows the same full check list with details and copyable suggested commands.

Safe derived retrieval repairs can be applied with:

```bash
swarmvault doctor --repair
```

If the graph or wiki pages are missing, run `swarmvault compile`; if review or candidate counts are high, inspect `swarmvault review list` and `swarmvault candidate list`.

## Context pack is empty or missing expected evidence

Context packs are built from compiled graph and search artifacts. Run `swarmvault compile` first when the vault is new, then build a narrower pack:

```bash
swarmvault context build "Prepare the next agent" --target ./src --budget 8000
```

Then verify:

- `wiki/context/`
- `state/context-packs/`

If many items are listed as omitted, increase `--budget` or narrow `--target`.

## Task is missing or does not show in the graph

Tasks are durable local artifacts. Start or inspect them with:

```bash
swarmvault task list
swarmvault task start "Prepare the next agent" --target ./src
swarmvault task resume <task-id>
```

Then verify:

- `wiki/memory/index.md`
- `wiki/memory/tasks/`
- `state/memory/tasks/`

Run `swarmvault compile` after creating or updating tasks when you want task and decision nodes to appear in `state/graph.json` and the graph viewer. Existing `memory` commands remain compatibility aliases.

## Agent install or hooks seem stale

Re-run the relevant install command in the project root:

```bash
swarmvault install --agent claude --hook
swarmvault install --agent gemini --hook
swarmvault install --agent opencode --hook
swarmvault install --agent copilot --hook
```

For Aider:

```bash
swarmvault install --agent aider
```

## Update paths

Update the skill:

```bash
clawhub update swarmvault
```

Update the CLI:

```bash
npm install -g @swarmvaultai/cli@latest
```

## More Help

- Docs: https://www.swarmvault.ai/docs
- Providers: https://www.swarmvault.ai/docs/providers
- Web troubleshooting: https://www.swarmvault.ai/docs/getting-started/troubleshooting
- GitHub issues: https://github.com/swarmclawai/swarmvault/issues
