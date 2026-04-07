# Live Testing

SwarmVault has a separate live-testing track for the **published npm package**, not just the source checkout.

The goal is to verify the real user install path for `@swarmvaultai/cli` and the core vault flows against a temporary workspace.

## Local Commands

From the OSS repo:

```bash
pnpm install
pnpm live:smoke:heuristic
```

To test a real provider path with Ollama Cloud:

```bash
pnpm live:smoke:ollama
```

The runner loads `.env.local` from either the umbrella workspace root or the OSS repo root. Supported overrides:

```bash
OLLAMA_API_KEY=...
SWARMVAULT_OLLAMA_MODEL=gpt-oss:20b-cloud
SWARMVAULT_OLLAMA_BASE_URL=https://ollama.com/v1
SWARMVAULT_OLLAMA_API_STYLE=chat
```

To test a real provider path with OpenAI:

```bash
export OPENAI_API_KEY=...
pnpm live:smoke:openai
```

Optional flags:

```bash
node ./scripts/live-smoke.mjs --lane heuristic --version 0.1.5 --keep-artifacts
```

## What The Smoke Runner Covers

### Heuristic lane

- install the published CLI from npm into an isolated temporary prefix
- initialize a fresh workspace
- ingest and compile a markdown fixture
- import an inbox markdown bundle with a linked local asset
- run `query --save`
- run `explore`
- run `lint` and `lint --deep`
- start `graph serve` and verify HTML plus `/api/graph`
- start `mcp` and call tools over stdio
- run `install --agent codex`

### OpenAI lane

- install the published CLI from npm
- initialize a fresh workspace
- write a temporary OpenAI-backed config override
- ingest and compile a markdown fixture
- run `query --save`
- run `lint --deep`

The OpenAI lane is intentionally narrower. It is there to validate one real external-provider path without making every live test expensive.

### Ollama lane

- install the published CLI from npm
- initialize a fresh workspace
- write a temporary Ollama-backed config override
- use the OpenAI-compatible `v1` chat surface against Ollama Cloud
- ingest and compile a markdown fixture
- run `query --save`
- run `lint --deep`

The default cloud model is `gpt-oss:20b-cloud`, and the runner defaults to `SWARMVAULT_OLLAMA_API_STYLE=chat`. You can override both values explicitly.

## Failure Artifacts

The runner writes logs and a temporary workspace under:

```text
.live-smoke-artifacts/
```

On success those artifacts are deleted by default. On failure they are kept automatically.

Use `--keep-artifacts` or `KEEP_LIVE_SMOKE_ARTIFACTS=1` to preserve them during local debugging.

## Manual Live Checklist

These checks stay manual for now:

1. Install the published package in a fresh directory on a real machine with Node 24.
2. Run `swarmvault watch --lint`, drop a new file into `inbox/`, and verify `state/jobs.ndjson` is appended.
3. Run `swarmvault graph serve` and confirm the viewer loads in a real browser without console errors.
4. Launch `swarmvault mcp` from a real MCP client configuration and confirm tool discovery works.
5. Compare heuristic output quality versus the Ollama and OpenAI lanes on the same fixture vault.

## CI Workflow

The live smoke workflow is separate from normal PR CI.

- `workflow_dispatch` for manual runs
- `release.published` for published package checks
- nightly scheduled heuristic smoke

Artifacts from failed runs are uploaded from `.live-smoke-artifacts/`.
