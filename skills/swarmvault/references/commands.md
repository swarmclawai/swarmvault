# Command Reference

## Setup

```bash
swarmvault demo --no-serve
swarmvault init
swarmvault init --obsidian --profile personal-research
swarmvault init --obsidian --profile reader,timeline
swarmvault scan ./apps/api --no-serve
swarmvault --version
```

## Ingest and Capture

```bash
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add ./exports/customer-call.srt --guide
swarmvault source session <source-id-or-session-id>
swarmvault source list
swarmvault source reload --all
swarmvault source review <source-id>
swarmvault source guide <source-id>
swarmvault source delete <source-id>
swarmvault ingest <path-or-url>
swarmvault ingest ./customer-call.mp3
swarmvault ingest https://www.youtube.com/watch?v=dQw4w9WgXcQ
swarmvault ingest --video https://example.com/product-demo.mp4
swarmvault ingest <path-or-url> --commit
swarmvault ingest <path-or-url> --guide
swarmvault ingest <directory> --repo-root .
swarmvault add <url-or-doi-or-arxiv-id>
swarmvault inbox import <path>
```

## Compile, Query, Review

```bash
swarmvault compile
swarmvault compile --max-tokens 120000
swarmvault compile --approve
swarmvault diff
swarmvault query "<question>"
swarmvault query "<question>" --commit
swarmvault context build "<goal>" --target ./src --budget 8000
swarmvault context build "<goal>" --target concept:auth --format llms
swarmvault context list
swarmvault context show <context-pack-id>
swarmvault task start "<goal>" --target ./src --agent codex
swarmvault task update <task-id> --decision "Keep the change local-first"
swarmvault task update <task-id> --changed-path packages/engine/src/memory.ts
swarmvault task finish <task-id> --outcome "Task completed" --follow-up "Run release smoke"
swarmvault task resume <task-id> --format llms
swarmvault retrieval status
swarmvault retrieval doctor --repair
swarmvault doctor
swarmvault doctor --repair
swarmvault explore "<question>" --steps 3
swarmvault lint
swarmvault lint --conflicts
swarmvault review list
swarmvault review show <approval-id> --diff
swarmvault review accept <approval-id>
swarmvault candidate list
```

## Graph and Sharing

```bash
swarmvault graph serve
swarmvault graph serve --full
swarmvault graph share --post
swarmvault graph share --svg ./share-card.svg
swarmvault graph share --bundle ./share-kit
swarmvault graph blast ./src/index.ts
swarmvault graph status ./src
swarmvault graph cluster
swarmvault graph update ./src
swarmvault graph update ./src --force
swarmvault graph refresh
swarmvault graph query "auth calls" --context calls --evidence extracted --language typescript
swarmvault graph tree --output ./tree.html
swarmvault graph merge ./graph.json ./other-graph.json --out ./merged-graph.json
swarmvault graph export --html ./graph.html
swarmvault graph export --report ./graph-report.html
swarmvault graph export --html ./graph.html --full
swarmvault graph export --html-standalone ./graph-standalone.html
swarmvault graph export --json ./graph.json --canvas ./graph.canvas
swarmvault graph export --obsidian ./graph-vault
swarmvault graph push neo4j --dry-run
swarmvault mcp
```

## Automation

```bash
swarmvault watch --lint --repo
swarmvault watch --repo --code-only --once
swarmvault graph status .
swarmvault graph update .
swarmvault graph update . --force
swarmvault watch status
swarmvault hook install
swarmvault schedule list
swarmvault schedule run <job-id>
```

## Agent Installs

```bash
swarmvault install --agent codex --hook
swarmvault install --agent claude --hook
swarmvault install --agent gemini --hook
swarmvault install --agent opencode --hook
swarmvault install --agent aider
swarmvault install --agent copilot --hook
swarmvault install --agent trae
swarmvault install --agent claw
swarmvault install --agent droid
```
