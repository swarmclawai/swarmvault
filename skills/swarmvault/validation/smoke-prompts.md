# Smoke Prompts

These prompts are the human-readable validation set for the ClawHub skill and the installed-package release flow.

## First-run prompt

Prompt:

> Set up a SwarmVault workspace for this repo and explain what files I should inspect first.

Expected shape:

- initializes or confirms the vault
- points at `swarmvault.schema.md`
- mentions `wiki/` and `state/`
- prefers `wiki/graph/report.md` once compile exists

## Repo understanding prompt

Prompt:

> Compile this repo into SwarmVault and tell me how auth works.

Expected shape:

- uses `ingest <dir> --repo-root .` and `compile`
- reads generated module pages or graph report before broad search
- saves the answer unless the user asks for ephemeral output

## Research prompt

Prompt:

> Add this paper URL to the vault and summarize the main claims and conflicts.

Expected shape:

- uses `swarmvault add`
- compiles before answering if needed
- points at contradiction/report artifacts when conflicts exist

## Graph prompt

Prompt:

> Show me the fastest way to inspect the graph and then expose the vault to another tool.

Expected shape:

- uses `swarmvault graph serve` or `graph export --html`
- mentions `swarmvault mcp`
- prefers existing report and graph artifacts when already present
