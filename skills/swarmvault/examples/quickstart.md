# Quickstart Example

Use this when the user needs the shortest path from install to a working vault.

## Commands

```bash
npm install -g @swarmvaultai/cli
swarmvault demo --no-serve
swarmvault init --obsidian
swarmvault scan ./repo --no-serve
swarmvault source add https://github.com/karpathy/micrograd
swarmvault diff
swarmvault graph share --post
swarmvault graph share --svg ./share-card.svg
swarmvault graph share --bundle ./share-kit
swarmvault graph blast ./src/index.ts
swarmvault query "What are the key concepts?"
swarmvault context build "Explain the key concepts to the next agent" --target ./repo --budget 8000
swarmvault task start "Explain the key concepts to the next agent" --target ./repo --agent codex
swarmvault retrieval status
swarmvault doctor
swarmvault graph serve
swarmvault graph export --report ./graph-report.html
```

## What To Check

- `swarmvault.schema.md` exists and reflects the vault contract
- `demo --no-serve` leaves a temporary compiled vault behind even on a clean machine
- `scan --no-serve` leaves a compiled vault behind even when the viewer is not launched
- `state/sources.json` contains the managed source registry entry
- `wiki/graph/report.md` exists after compile
- `wiki/graph/share-card.md`, `wiki/graph/share-card.svg`, and `wiki/graph/share-kit/` exist after compile; `graph share --post` prints copyable text, `graph share --svg [path]` writes the visual card, and `graph share --bundle [dir]` writes the portable share kit
- `graph export --report` writes a shareable HTML report when the user wants a lighter artifact than the full workspace
- `wiki/outputs/source-briefs/` contains a source brief
- `wiki/outputs/` contains the saved query answer
- `wiki/context/` and `state/context-packs/` contain the saved context pack when `context build` is used
- `wiki/memory/` and `state/memory/tasks/` contain task ledger artifacts when `task start` is used
- `state/graph.json` and `state/retrieval/` exist
- `swarmvault doctor` reports `ok` or gives concrete next commands such as `swarmvault compile` or `swarmvault retrieval rebuild`; `graph serve` shows those checks and commands in the workbench

## Guidance

- If the answer quality is weak, check whether the vault is still on the `heuristic` provider.
- If the user is unsure what changed, point them at `wiki/` and `state/` before suggesting another compile.
- When the vault lives in git, `swarmvault diff` is the quickest graph-level summary of what the last compile changed.
