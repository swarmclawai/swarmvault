# Smoke Prompts

These prompts are the human-readable validation set for the ClawHub skill and the installed-package release flow.

## Maintainer validation prompt

Prompt:

> Verify the CLI surface before release.

Expected shape:

- runs `pnpm live:cli-surface` from the OSS repo before release preflight when CLI command coverage is in scope
- expects the smoke to parse `packages/cli/src/index.ts` with the TypeScript compiler API
- expects every stable command path and alias to be classified in the surface manifest
- expects `--help` coverage across the full command tree plus direct JSON behavior checks for the main local workflows

## First-run prompt

Prompt:

> Set up a SwarmVault workspace for this repo and explain what files I should inspect first.

Expected shape:

- initializes or confirms the vault
- may use `swarmvault demo --no-serve` for the fastest zero-config walkthrough
- may use `swarmvault scan <directory> --no-serve` when the task is a quick local repo walkthrough
- points at `swarmvault.schema.md`
- mentions `wiki/` and `state/`
- prefers `wiki/graph/report.md` once compile exists
- mentions `wiki/graph/share-card.md`, `wiki/graph/share-card.svg`, `wiki/graph/share-kit/`, `swarmvault graph share --post`, `swarmvault graph share --svg`, or `swarmvault graph share --bundle` when the user wants a copyable, visual, or portable summary
- mentions `swarmvault context build`, `wiki/context/`, or `state/context-packs/` when the user asks for agent handoff or bounded review context
- mentions `swarmvault memory`, `wiki/memory/`, or `state/memory/tasks/` when the user asks for durable task memory or handoff history
- uses or suggests `swarmvault doctor` when the user asks whether the vault is ready for handoff, query, or viewer inspection

## Managed source prompt

Prompt:

> Register this public GitHub repo as a recurring source, sync it, and tell me what I should read first.

Expected shape:

- uses `swarmvault source add https://github.com/karpathy/micrograd` or the supplied repo root URL
- may use `--branch`, `--ref`, or `--checkout-dir` when the prompt pins a branch, tag, commit, or reusable checkout
- mentions `state/sources.json`
- points at `wiki/outputs/source-briefs/` and `wiki/graph/report.md`
- treats `source list` and `source reload --all` as the maintenance path

## Repo understanding prompt

Prompt:

> Compile this repo into SwarmVault and tell me how auth works.

Expected shape:

- uses `ingest <dir> --repo-root .` and `compile`
- reads generated module pages or graph report before broad search
- saves the answer unless the user asks for ephemeral output
- may build `swarmvault context build "Explain auth" --target ./src --budget 8000` when the next agent or review needs reusable bounded context

## Context handoff prompt

Prompt:

> Build a bounded handoff pack for the next agent working on auth.

Expected shape:

- compiles first when graph/search artifacts are missing or stale
- uses `swarmvault context build "<goal>" --target <path-or-node> --budget <tokens>`
- points at both `wiki/context/` and `state/context-packs/`
- mentions omitted items when the token budget is too small

## Task ledger prompt

Prompt:

> Start a durable task ledger for the next agent working on auth, record a decision, and show how to resume it.

Expected shape:

- uses `swarmvault task start "<goal>" --target <path-or-node>`
- records a decision or note with `swarmvault task update <id>`
- points at both `wiki/memory/` and `state/memory/tasks/`
- uses `swarmvault task resume <id>` for the next-agent handoff
- mentions that `query`, `explore`, and `context build` can attach to the task with `--task <id>`, with `--memory <id>` as a compatibility alias

## Research prompt

Prompt:

> Add this paper URL to the vault and summarize the main claims and conflicts.

Expected shape:

- uses `swarmvault add`
- may use `swarmvault ingest` for direct audio/video files, `swarmvault ingest --video <url>` for public video URLs, or direct YouTube transcript URLs
- compiles before answering if needed
- points at contradiction/report artifacts when conflicts exist

## Personal knowledge prompt

Prompt:

> Ingest this transcript or export file, run the guided workflow, and tell me what dashboard pages I should open first.

Expected shape:

- uses `swarmvault ingest --guide`, `swarmvault source add --guide`, or `swarmvault source session`
- points at `wiki/outputs/source-sessions/` and `wiki/outputs/source-guides/`
- points at `wiki/dashboards/source-sessions.md`, `wiki/dashboards/source-guides.md`, `wiki/dashboards/timeline.md`, or `wiki/dashboards/reading-log.md`
- treats the approval queue as part of the workflow instead of silently overwriting canonical pages

## Graph prompt

Prompt:

> Show me the fastest way to inspect the graph and then expose the vault to another tool.

Expected shape:

- uses `swarmvault graph serve` or `graph export --html`
- may suggest `swarmvault graph share --post` when a quick copyable summary is enough, `swarmvault graph share --svg [path]` for a visual card, or `swarmvault graph share --bundle [dir]` for a portable share kit
- may suggest `graph export --report`, `graph export --html-standalone`, `graph export --canvas`, or `graph export --obsidian` when a lighter shareable artifact is a better fit
- may suggest `swarmvault diff` when the user is asking what a compile changed
- may use `graph blast <target>` when the user is asking about change impact instead of broad graph browsing
- may use `graph status [path]` when the user needs a read-only stale check before choosing `graph update` or `compile`
- may use `graph stats` when the user needs lightweight counts or relation mix without opening the viewer
- may use `graph validate [graph] --strict` before sharing, merging, pushing, or publishing graph artifacts
- may use `graph tree [--output <html>]` when the user wants file/module/symbol browsing
- may use `graph merge <graph...> --out <path>` when the user needs to combine SwarmVault or node-link graph JSON
- may use `graph cluster [--resolution <n>]` when the graph exists but community/report metrics need to be recomputed
- may run `swarmvault doctor` before opening the live workspace when the vault health is uncertain
- mentions that the live workbench shows doctor details, copyable suggested commands, explicit capture modes, and budgeted context/task actions when the user asks what the viewer can do
- mentions `swarmvault mcp`
- prefers existing report and graph artifacts when already present
