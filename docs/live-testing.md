# Live Testing

SwarmVault has a separate live-testing track for the **published npm package**, not just the source checkout.

The goal is to verify the real user install path for `@swarmvaultai/cli` and the core vault flows against a temporary workspace.

## Local Commands

From the OSS repo:

```bash
pnpm install
pnpm release:preflight
pnpm live:smoke:heuristic
pnpm exec playwright install chromium
pnpm live:smoke:heuristic:browser
pnpm live:smoke:neo4j
pnpm live:oss:corpus
pnpm skill:inspect
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
SWARMVAULT_RUN_OPENCODE_AGENT_SMOKE=1
SWARMVAULT_RUN_LOCAL_EMBEDDINGS_SMOKE=1
SWARMVAULT_LOCAL_EMBEDDINGS_MODEL=nomic-embed-text
SWARMVAULT_LOCAL_EMBEDDINGS_BASE_URL=http://localhost:11434/v1
```

The Neo4j live-smoke lane uses a local Docker-managed Neo4j container and does not require a hosted Neo4j account, but it does require a running Docker daemon.

To test a real provider path with OpenAI:

```bash
export OPENAI_API_KEY=...
pnpm live:smoke:openai
```

Optional flags:

```bash
node ./scripts/live-smoke.mjs --lane heuristic --version 0.7.26 --keep-artifacts
node ./scripts/live-smoke.mjs --lane heuristic --install-spec /tmp/swarmvaultai-engine.tgz --install-spec /tmp/swarmvaultai-cli.tgz
node ./scripts/live-smoke.mjs --lane heuristic --browser-check
node ./scripts/live-smoke.mjs --lane neo4j --install-spec /tmp/swarmvaultai-engine.tgz --install-spec /tmp/swarmvaultai-cli.tgz
node ./scripts/live-oss-corpus.mjs --lane heuristic --version 0.7.26 --keep-artifacts
node ./scripts/live-oss-corpus.mjs --lane heuristic --repo ky --repo react-markdown
node ./scripts/live-oss-corpus.mjs --lane heuristic --include-canary
```

Use `pnpm pack` for local tarball preflight installs. Raw `npm pack` preserves workspace dependency specs in the CLI package and does not reflect the publish-time manifest rewrite.

`pnpm release:preflight` is the default local release gate. It runs `check`, `test`, `build`, the site build, the skill dry-run, then validates the installed-package path with local tarballs through heuristic smoke, browser smoke, and the OSS corpus.

The OSS corpus runner also validates the **installed npm package path**. It clones a pinned set of small public repositories, installs the published CLI into an isolated prefix and npm cache, and runs `init`, repo ingest, compile, benchmark, graph query, query, and graph export against those repos.

The default gated corpus is intentionally small to keep provider cost and run time bounded:

- `sindresorhus/ky`
- `remarkjs/react-markdown`
- `pallets/itsdangerous`
- `necolas/normalize.css`

The optional canary repo is:

- `apple/sample-food-truck`

That canary is not part of the default gated lane. It is there to exercise a mixed-language Apple-style project layout without slowing the normal release gate.

## ClawHub Skill Checks

The ClawHub/OpenClaw skill is a separate published artifact under `skills/swarmvault/`.

Before release:

- run `pnpm check` so `check-clawhub-skill.mjs` validates the skill bundle shape, version sync, metadata, and README contract
- run `pnpm skill:publish -- --dry-run` to confirm the exact publish command, changelog text, and tags

After publish:

```bash
pnpm skill:inspect
```

Confirm the published skill includes `README.md` plus the expected examples, references, troubleshooting notes, and validation prompts.

## What The Smoke Runner Covers

### Heuristic lane

- install the published CLI from npm into an isolated temporary prefix
- initialize a fresh workspace
- run `scan <directory> --no-serve` against a small local directory fixture and verify the one-command init + ingest + compile path
- run `source add` against a small local directory fixture and verify `state/sources.json`
- run `source add --guide` against a recurring local transcript file and verify managed file support plus guided-bundle staging
- run `source list`, `source reload --all`, `source delete`, and `source add --no-brief`
- run `source add` against a deterministic local docs fixture over HTTP and verify crawl sync plus source-brief output
- ingest a mixed personal-research fixture with transcripts, Slack export, email, and calendar material, then verify dashboard generation, source-guide staging, and approval labeling
- ingest and compile a markdown fixture
- ingest the tiny local fixture matrix under `smoke/fixtures/tiny-matrix/` and verify the core code-language baseline plus local `markdown`, `text`, `pdf`, `docx`, `epub`, `csv`, `xlsx`, `pptx`, `image`, `code`, `jupyter`, `odt`, `odp`, `ods`, `data`, `bibtex`, `rtf`, `org`, and `asciidoc` source kinds
- ingest remote HTML and markdown fixtures over HTTP and verify remote image localization into `raw/assets/`
- import inbox markdown and HTML bundles with linked local assets
- run `query`
- run saved `query --format chart` and `query --format image`
- configure project roots, re-run `init --obsidian`, ingest JS/TS code sources, and verify module pages plus project rollups
- stage a deterministic candidate concept through a custom compile provider
- run `explore`
- run `lint` and `lint --deep`
- run `graph export --html` and verify the self-contained HTML embeds local asset data
- run `graph export --html-standalone`, `graph export --json`, `graph export --canvas`, and `graph export --obsidian` and verify the lighter/shareable outputs exist with the expected file counts or graph payloads
- run large-graph overview checks against both `graph serve` and `graph export --html`, and verify `--full` disables overview sampling for oversized graphs
- when `--browser-check` is enabled, open both `graph serve` and the exported HTML in a real headless Chromium session, select a graph node, trigger path highlighting, and verify deselection
- run `schedule list` and `schedule run` and verify scheduled saved outputs stage through approvals
- start `graph serve` and verify HTML plus `/api/graph`, `/api/search`, `/api/page`, `/api/asset`, `/api/candidates`, and `/api/reviews`
- promote a candidate through the viewer API and resolve a staged approval bundle through the CLI review commands
- run `watch --lint` and `watch --repo --code-only --once` against the published install and verify `state/jobs.ndjson`, watch sessions, and the code-only refresh path
- start `mcp` and call tools over stdio, including `search_pages` and chart-format `query_vault`
- run `install --agent codex`
- run `install --agent claude`
- run `install --agent opencode --hook`
- run `install --agent gemini --hook`
- run `install --agent copilot --hook`
- run `install --agent aider`
- run `install --agent trae`, `install --agent claw`, and `install --agent droid`
- verify the installed package writes `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, `.aider.conf.yml`, `.github/copilot-instructions.md`, `.trae/rules/swarmvault.md`, `.claw/skills/swarmvault/SKILL.md`, `.factory/rules/swarmvault.md`, and the expected hook/plugin artifacts
- verify the managed git hook block invokes `swarmvault watch --repo --once --code-only`
- when local binaries and credentials are available, run Codex CLI against `AGENTS.md`, Claude Code against `CLAUDE.md`, and Gemini CLI against `GEMINI.md`
- run the OpenCode host-agent check only when `SWARMVAULT_RUN_OPENCODE_AGENT_SMOKE=1` is set, because it depends on an external model path and is not part of the required packaged-artifact release gate
- run the Ollama local-embeddings check only when `SWARMVAULT_RUN_LOCAL_EMBEDDINGS_SMOKE=1` is set, because it depends on a reachable embedding-capable local model and is not part of the required packaged-artifact release gate
- on live npm-installed runs, execute `swarmvault source add https://github.com/karpathy/micrograd` and verify the registry entry, compile artifacts, and source brief

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

### Neo4j lane

- install the published CLI from npm or supplied tarballs
- initialize a fresh workspace
- ingest and compile a markdown fixture
- start a temporary local Neo4j container over Bolt
- run `swarmvault graph push neo4j --dry-run`
- run `swarmvault graph push neo4j`
- verify `SwarmNode`, relationship, `GROUP_MEMBER`, and `SwarmVaultSync` records exist for the pushed `vaultId`

This lane is the direct-graph-sink validation path and complements the file-export checks from `graph export --cypher`.

## Failure Artifacts

The runner writes logs and a temporary workspace under:

```text
.live-smoke-artifacts/
.oss-corpus-artifacts/
```

On success those artifacts are deleted by default. On failure they are kept automatically.

Use `--keep-artifacts` or `KEEP_LIVE_SMOKE_ARTIFACTS=1` to preserve them during local debugging.

## Manual Live Checklist

These checks remain complementary manual gut-checks:

1. Install the published package in a fresh directory on a real machine with Node 24.
2. Run `swarmvault graph serve` and confirm the viewer looks right in a real browser, beyond the automated headless browser check.
3. Launch `swarmvault mcp` from a real MCP client configuration and confirm tool discovery works.
4. Verify `swarmvault ingest <url>` localizes remote images as expected, including `--no-include-assets` and `--max-asset-size` behavior.
5. Compare heuristic output quality versus the Ollama and OpenAI lanes on the same fixture vault.

## CI Workflow

The live smoke workflow is separate from normal PR CI.

- `workflow_dispatch` for manual runs
- `release.published` for published package checks
- PR CI also runs a tarball-installed packaged smoke lane so installed-path regressions are caught before release
- nightly scheduled heuristic smoke

Artifacts from failed runs are uploaded from `.live-smoke-artifacts/`.

The OSS corpus runner is an extended validation lane. It should run before release candidate signoff and again against the live published npm package when a release materially changes repo ingest, graph quality, or query/report behavior.

The tiny fixture matrix is the complementary fast gate: it is fully controlled, cheap to run, and should catch regressions across the core code-language baseline plus the local file kinds it explicitly covers before larger corpus runs do.
