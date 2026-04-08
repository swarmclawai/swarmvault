# Quickstart Example

Use this when the user needs the shortest path from install to a working vault.

## Commands

```bash
npm install -g @swarmvaultai/cli
swarmvault init --obsidian
swarmvault ingest ./notes.md
swarmvault compile
swarmvault query "What are the key concepts?"
swarmvault graph serve
```

## What To Check

- `swarmvault.schema.md` exists and reflects the vault contract
- `wiki/graph/report.md` exists after compile
- `wiki/outputs/` contains the saved query answer
- `state/graph.json` and `state/search.sqlite` exist

## Guidance

- If the answer quality is weak, check whether the vault is still on the `heuristic` provider.
- If the user is unsure what changed, point them at `wiki/` and `state/` before suggesting another compile.
