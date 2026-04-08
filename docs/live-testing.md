# Live Testing

SwarmVault has a separate live-testing track for the **published npm package**, not just the source checkout.

The goal is to verify the real user install path for `@swarmvaultai/cli` and the core vault flows against a temporary workspace.

## Local Commands

From the OSS repo:

```bash
pnpm install
pnpm live:smoke:heuristic
pnpm live:oss:corpus
```

To test a real provider path with Ollama Cloud:

```bash
pnpm live:smoke:ollama
```

To test a real provider path with Anthropic:

```bash
export ANTHROPIC_API_KEY=...
pnpm live:smoke:anthropic
```

The runner loads `.env.local` from either the umbrella workspace root or the OSS repo root. Supported overrides:

```bash
OLLAMA_API_KEY=...
ANTHROPIC_API_KEY=...
SWARMVAULT_OLLAMA_MODEL=gpt-oss:20b-cloud
SWARMVAULT_OLLAMA_BASE_URL=https://ollama.com/v1
SWARMVAULT_OLLAMA_API_STYLE=chat
SWARMVAULT_ANTHROPIC_MODEL=claude-sonnet-4-20250514
SWARMVAULT_OPENCODE_OLLAMA_MODEL=gpt-oss:20b-cloud
```

To test a real provider path with OpenAI:

```bash
export OPENAI_API_KEY=...
pnpm live:smoke:openai
```

Optional flags:

```bash
node ./scripts/live-smoke.mjs --lane heuristic --version 0.1.14 --keep-artifacts
node ./scripts/live-smoke.mjs --lane heuristic --install-spec /tmp/swarmvaultai-engine.tgz --install-spec /tmp/swarmvaultai-cli.tgz
node ./scripts/live-oss-corpus.mjs --lane heuristic --version 0.1.26 --keep-artifacts
node ./scripts/live-oss-corpus.mjs --lane heuristic --repo ky --repo react-markdown
node ./scripts/live-oss-corpus.mjs --lane heuristic --include-canary
```

Use `pnpm pack` for local tarball preflight installs. Raw `npm pack` preserves workspace dependency specs in the CLI package and does not reflect the publish-time manifest rewrite.

The OSS corpus runner also validates the **installed npm package path**. It clones a pinned set of small public repositories, installs the published CLI into an isolated prefix and npm cache, and runs `init`, repo ingest, compile, benchmark, graph query, query, and graph export against those repos.

The default gated corpus is intentionally small to keep provider cost and run time bounded:

- `sindresorhus/ky`
- `remarkjs/react-markdown`
- `pallets/itsdangerous`
- `necolas/normalize.css`

The optional canary repo is:

- `apple/sample-food-truck`

That Swift canary is not part of the default gated lane.

## What The Smoke Runner Covers

### Heuristic lane

- install the published CLI from npm into an isolated temporary prefix
- initialize a fresh workspace
- ingest and compile a markdown fixture
- ingest the tiny local fixture matrix under `smoke/fixtures/tiny-matrix/` and verify every shipped code language plus local `markdown`, `text`, `html`, `pdf`, `image`, and `code` source kinds
- ingest remote HTML and markdown fixtures over HTTP and verify remote image localization into `raw/assets/`
- import an inbox markdown bundle with a linked local asset
- run `query`
- run saved `query --format chart` and `query --format image`
- configure project roots, re-run `init --obsidian`, ingest JS/TS code sources, and verify module pages plus project rollups
- stage a deterministic candidate concept through a custom compile provider
- run `explore`
- run `lint` and `lint --deep`
- run `graph export --html` and verify the standalone HTML embeds local asset data
- run `schedule list` and `schedule run` and verify scheduled saved outputs stage through approvals
- start `graph serve` and verify HTML plus `/api/graph`, `/api/search`, `/api/page`, `/api/asset`, `/api/candidates`, and `/api/reviews`
- promote a candidate through the viewer API and resolve a staged approval bundle through the CLI review commands
- run `watch --lint` against the published install and verify `state/jobs.ndjson` plus watch sessions
- start `mcp` and call tools over stdio, including `search_pages` and chart-format `query_vault`
- run `install --agent codex`
- run `install --agent claude`
- run `install --agent opencode --hook`
- run `install --agent gemini --hook`
- run `install --agent copilot --hook`
- run `install --agent aider`
- verify the installed package writes `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, `.aider.conf.yml`, `.github/copilot-instructions.md`, and the expected hook/plugin artifacts
- when local binaries and credentials are available, run Codex CLI against `AGENTS.md`, Claude Code against `CLAUDE.md`, OpenCode against `AGENTS.md` using Ollama, and Gemini CLI against `GEMINI.md`

### OpenAI lane

- install the published CLI from npm
- initialize a fresh workspace
- write a temporary OpenAI-backed config override
- ingest and compile a markdown fixture
- run `query`
- run `lint --deep`

The OpenAI lane is intentionally narrower. It is there to validate one real external-provider path without making every live test expensive.

### Ollama lane

- install the published CLI from npm
- initialize a fresh workspace
- write a temporary Ollama-backed config override
- use the OpenAI-compatible `v1` chat surface against Ollama Cloud
- ingest and compile a markdown fixture
- run `query`
- run `lint --deep`

The default cloud model is `gpt-oss:20b-cloud`, and the runner defaults to `SWARMVAULT_OLLAMA_API_STYLE=chat`. You can override both values explicitly.

### Anthropic lane

- install the published CLI from npm
- initialize a fresh workspace
- write a temporary Anthropic-backed config override
- ingest and compile a markdown fixture
- run `query`
- run `lint --deep`

The default Anthropic model is `claude-sonnet-4-20250514`, and you can override it with `SWARMVAULT_ANTHROPIC_MODEL`.

## Failure Artifacts

The runner writes logs and a temporary workspace under:

```text
.live-smoke-artifacts/
.oss-corpus-artifacts/
```

On success those artifacts are deleted by default. On failure they are kept automatically.

Use `--keep-artifacts` or `KEEP_LIVE_SMOKE_ARTIFACTS=1` to preserve them during local debugging.

## Manual Live Checklist

These checks stay manual for now:

1. Install the published package in a fresh directory on a real machine with Node 24.
2. Run `swarmvault graph serve` and confirm the viewer loads in a real browser without console errors.
3. Launch `swarmvault mcp` from a real MCP client configuration and confirm tool discovery works.
4. Verify `swarmvault ingest <url>` localizes remote images as expected, including `--no-include-assets` and `--max-asset-size` behavior.
5. Compare heuristic output quality versus the Ollama and OpenAI lanes on the same fixture vault.

## CI Workflow

The live smoke workflow is separate from normal PR CI.

- `workflow_dispatch` for manual runs
- `release.published` for published package checks
- nightly scheduled heuristic smoke

Artifacts from failed runs are uploaded from `.live-smoke-artifacts/`.

The OSS corpus runner is an extended validation lane. It should run before release candidate signoff and again against the live published npm package when a release materially changes repo ingest, graph quality, or query/report behavior.

The tiny fixture matrix is the complementary fast gate: it is fully controlled, cheap to run, and should catch regressions across every shipped code language and local file kind before larger corpus runs do.
