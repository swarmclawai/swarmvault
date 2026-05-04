# Repo Workflow Example

Use this when the user wants to compile a codebase into durable module pages, graph artifacts, and reviewable outputs.

## Commands

```bash
swarmvault init --obsidian
swarmvault source add https://github.com/karpathy/micrograd
swarmvault source add https://github.com/owner/repo --branch main --checkout-dir .swarmvault-checkouts/repo
swarmvault compile --approve
swarmvault diff
swarmvault review list
swarmvault review show <approval-id> --diff
swarmvault review accept <approval-id>
swarmvault query "What is the auth flow?"
swarmvault context build "Hand off the auth flow work" --target ./src --budget 8000
swarmvault task start "Hand off the auth flow work" --target ./src --agent codex
swarmvault doctor
swarmvault graph share --post
swarmvault graph share --svg ./share-card.svg
swarmvault graph share --bundle ./share-kit
swarmvault graph tree --output ./tree.html
swarmvault graph serve
```

## What To Check

- `wiki/code/` contains module pages
- `wiki/outputs/source-briefs/` contains a repo onboarding brief
- `state/code-index.json` exists for repo-aware symbol/import resolution
- `swarmvault diff` reflects the graph-level additions and removals when the vault is inside git
- `state/approvals/` contains staged review bundles when `--approve` is used
- `wiki/graph/report.md` highlights the important modules, bridge nodes, and contradictions
- `wiki/graph/tree.html` or the chosen tree export path helps users browse sources, modules, and symbols as a file tree
- `wiki/context/` and `state/context-packs/` contain bounded handoff packs when `context build` is used
- `wiki/memory/` and `state/memory/tasks/` contain durable task records when `task start` is used
- `swarmvault doctor` summarizes graph, retrieval, review, watch, migration, source, and task health before handoff; the live workbench shows the same details and suggested commands
- `wiki/graph/share-card.md` gives a short summary for status updates, `wiki/graph/share-card.svg` gives a visual card, and `wiki/graph/share-kit/` gives a portable folder for posting, linking, or screenshotting

## Guidance

- Prefer reading `wiki/graph/report.md` and the relevant `wiki/code/*.md` pages before broad grep.
- Use `swarmvault context build` before handing a scoped repo task to another agent or reviewer.
- Use `swarmvault task resume <id>` when a future agent needs the task summary, decisions, evidence, and follow-ups.
- If organization is wrong, update `swarmvault.schema.md` first instead of hand-editing generated pages.
- Use `swarmvault watch --lint --repo` plus `swarmvault hook install` when the repo should stay current automatically.
