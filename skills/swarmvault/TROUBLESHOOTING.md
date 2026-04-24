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

## Audio files ingest, but no transcript appears

Audio ingest needs `tasks.audioProvider` to point at a provider with `audio` capability. Without that, SwarmVault still ingests the source and records an extraction warning instead of failing the whole run.

The quickest fully-local fix is `swarmvault provider setup --local-whisper --apply`, which installs a `local-whisper` provider (whisper.cpp shell-out), downloads the default ggml model into `~/.swarmvault/models/`, and wires `tasks.audioProvider` at it. If the command reports the binary missing, install whisper.cpp first (`brew install whisper-cpp` on macOS, `sudo apt install whisper.cpp` on Debian/Ubuntu) and re-run. Override binary or model paths with `localWhisper.binaryPath` / `localWhisper.modelPath` in `swarmvault.config.json` or `SWARMVAULT_WHISPER_BINARY` in the environment.

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
```

Then verify:

- `wiki/graph/report.md`
- `wiki/graph/share-card.md`
- `wiki/graph/share-card.svg`
- `wiki/graph/share-kit/`
- `state/graph.json`
- `state/search.sqlite`

If the vault lives inside git and you want a quick graph-level delta, run `swarmvault diff`.

## Context pack is empty or missing expected evidence

Context packs are built from compiled graph and search artifacts. Run `swarmvault compile` first when the vault is new, then build a narrower pack:

```bash
swarmvault context build "Prepare the next agent" --target ./src --budget 8000
```

Then verify:

- `wiki/context/`
- `state/context-packs/`

If many items are listed as omitted, increase `--budget` or narrow `--target`.

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
