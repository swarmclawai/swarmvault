# Personal Knowledge Base Example

Use this when you want a personal Memex — a vault that compiles diverse life material (journals, health logs, podcast notes, goals) into a connected, queryable knowledge base.

This example demonstrates:

- Ingesting heterogeneous personal documents that share no obvious structure
- Cross-referencing themes that emerge across source types (sleep, a work project, a recurring person)
- Using dashboards and graph views to surface patterns you would not notice reading sources individually

## What is in the vault

```text
raw/
├── journal-2026-03-15.md        journal entry (work, people, reading)
├── journal-2026-03-22.md        follow-up entry a week later
├── podcast-huberman-sleep.md    podcast notes on sleep science
├── health-log-march.md          sleep, exercise, and mood log
└── goals-q2-2026.md             quarterly goals
```

The sources are intentionally varied. SwarmVault's value shows when the compiler finds connections you did not plan: the journal mentions poor sleep, the podcast explains why, the health log confirms the pattern, and the goals depend on fixing it.

## Workflow

### 1. Initialize

```bash
swarmvault init --obsidian --profile personal-research
```

This creates the vault scaffolding with the personal-research profile, which enables timeline dashboards, guided sessions, and Dataview blocks suited to personal knowledge work.

### 2. Add sources

Copy the `raw/` files into your vault's `raw/` directory, then ingest:

```bash
swarmvault ingest ./raw
```

### 3. Compile

```bash
swarmvault compile
```

The compiler reads every ingested source and produces:

- **Source pages** in `wiki/sources/` — one summary per raw file
- **Entity pages** in `wiki/entities/` — pages for recurring people (Alex), projects (Meridian), topics (sleep, circadian rhythm)
- **Concept pages** in `wiki/concepts/` — higher-level themes like productivity, habit formation, deep work
- **Dashboards** in `wiki/dashboards/` — timeline, activity, and cross-reference views
- **A knowledge graph** in `state/graph.json` — nodes and edges linking every entity, concept, and source

### 4. Query

```bash
swarmvault query "How does my sleep relate to my productivity?"
swarmvault query "What are Alex's main concerns about Project Meridian?"
swarmvault query "What habits should I prioritize for Q2 goals?"
```

Queries search the compiled wiki and graph, not just raw text. Answers draw from multiple sources and cite where each claim originates.

### 5. Explore the graph

```bash
swarmvault graph serve
```

Open the local viewer to see how journal entries, podcast notes, health data, and goals connect through shared entities and themes.

Useful graph commands for this vault:

```bash
swarmvault graph path "sleep" "Project Meridian"
swarmvault graph explain "Alex"
```

## What to expect after compile

- **Entity pages** for `Alex`, `Project Meridian`, `Dr. Andrew Huberman`, and any other recurring proper nouns. Each page collects every mention across all sources with context.
- **Concept pages** for themes like `sleep`, `circadian rhythm`, `deep work`, and `habit formation` that appear in multiple sources.
- **A timeline dashboard** showing entries ordered chronologically, with mood and energy annotations pulled from the health log.
- **Cross-references** that link the podcast's sleep science claims to your own health data and journal reflections, so you can see whether the advice matches your lived experience.

## Obsidian workflow

With `--obsidian`, the vault includes `.obsidian/` workspace configuration. Open the vault directory in Obsidian to get:

- **Graph view** — visual map of connections between entities, concepts, and sources. Useful for spotting clusters (everything connected to "sleep") and orphans (sources that did not link to anything else).
- **Backlinks** — every entity page shows which sources mention it. Click through from `Alex` to every journal entry where Alex appears.
- **Dataview queries** — the personal-research profile generates Dataview blocks in dashboard pages. These render tables of sources by date, entities by mention count, and open questions extracted during compile.

Example Dataview query (auto-generated in dashboards):

```dataview
TABLE source_ids AS "Sources", freshness AS "Last Updated"
FROM "wiki/entities"
SORT freshness DESC
```

## Extending this example

- Add more journal entries over time and recompile. The entity and concept pages accumulate context. An entity page for Alex after ten journal entries is far more useful than after two.
- Add new source types: book highlights, email threads, meeting notes, recipe collections. The compiler handles any markdown input.
- Edit `swarmvault.schema.md` to tune what matters. If mood tracking is important, add a schema note telling the compiler to extract and tag mood observations.
