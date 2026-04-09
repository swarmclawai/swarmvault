# Command Reference

## Setup

```bash
swarmvault init
swarmvault init --obsidian
swarmvault --version
```

## Ingest and Capture

```bash
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add ./exports/customer-call.srt --review
swarmvault source list
swarmvault source reload --all
swarmvault source review <source-id>
swarmvault source delete <source-id>
swarmvault ingest <path-or-url>
swarmvault ingest <path-or-url> --review
swarmvault ingest <directory> --repo-root .
swarmvault add <url-or-doi-or-arxiv-id>
swarmvault inbox import <path>
```

## Compile, Query, Review

```bash
swarmvault compile
swarmvault compile --approve
swarmvault query "<question>"
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
swarmvault graph export --html ./graph.html
swarmvault graph export --html ./graph.html --full
swarmvault graph push neo4j --dry-run
swarmvault mcp
```

## Automation

```bash
swarmvault watch --lint --repo
swarmvault watch status
swarmvault hook install
swarmvault schedule list
swarmvault schedule run <job-id>
```

## Agent Installs

```bash
swarmvault install --agent codex
swarmvault install --agent claude --hook
swarmvault install --agent gemini --hook
swarmvault install --agent opencode --hook
swarmvault install --agent aider
swarmvault install --agent copilot --hook
```
