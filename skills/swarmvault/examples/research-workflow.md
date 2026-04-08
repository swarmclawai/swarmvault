# Research Workflow Example

Use this when the user is collecting papers, articles, PDFs, screenshots, or other mixed research sources into one vault.

## Commands

```bash
swarmvault init
swarmvault add https://arxiv.org/abs/2401.12345
swarmvault add 10.1145/1234567.1234568
swarmvault ingest ./paper.pdf
swarmvault inbox import ./capture-bundle
swarmvault compile
swarmvault query "What are the main claims and conflicts?"
swarmvault explore "What should I read next?" --steps 3
```

## What To Check

- `raw/sources/` contains normalized markdown captures for `add`
- `state/extracts/` contains PDF/image extraction sidecars when relevant
- `wiki/graph/report.md` surfaces contradictions, surprise links, and benchmark data
- `wiki/outputs/` contains saved query and explore outputs

## Guidance

- Use `swarmvault add` for research URLs and `swarmvault ingest` for direct local files.
- If image extraction is weak, verify that a real `visionProvider` is configured.
- Use `lint --conflicts` when the user specifically wants contradiction review.
