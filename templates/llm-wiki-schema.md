# LLM Wiki Schema

A standalone schema for building a personal knowledge wiki with any LLM agent.
Inspired by the [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern.

> When you outgrow this file, install [SwarmVault](https://github.com/swarmclawai/swarmvault)
> for graph navigation, local search, 30+ file formats, contradiction detection, and multi-agent support.

## How to use

Copy this file into your project as `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or wherever your LLM agent reads instructions. Then create the directory structure below and start ingesting sources.

## Three-Layer Architecture

This wiki uses three layers:

1. **Raw sources** (`raw/`) — your curated collection of source documents. Articles, papers, images, data files. These are immutable: you read from them but never modify them. This is your source of truth.

2. **The wiki** (`wiki/`) — a directory of markdown files you build and maintain. Summaries, entity pages, concept pages, comparisons, a synthesis. You own this layer entirely. Create pages, update them when new sources arrive, maintain cross-references, and keep everything consistent.

3. **The schema** (this file) — defines how the wiki is structured, what the conventions are, and what workflows to follow when ingesting sources, answering questions, or maintaining the wiki.

## Directory Structure

```
raw/                    # Immutable source documents
  assets/               # Downloaded images and attachments
wiki/
  index.md              # Content catalog: every page with link, summary, metadata
  log.md                # Append-only chronological record of operations
  sources/              # Per-source summary pages
  concepts/             # Concept definition pages
  entities/             # Named entity pages
  outputs/              # Query results, reports, comparisons filed back
  insights/             # Human-authored notes (your judgment layer)
```

## Operations

### Ingest

When adding a new source:
1. Read the source document in `raw/`.
2. Discuss key takeaways before writing anything.
3. Write a summary page in `wiki/sources/`.
4. Update `wiki/index.md` with the new page.
5. Update or create relevant entity and concept pages across the wiki.
6. Append an entry to `wiki/log.md`.

A single source might touch 10-15 wiki pages. Prefer ingesting one source at a time and staying involved in the process.

### Query

When answering questions:
1. Read `wiki/index.md` to find relevant pages.
2. Read those pages and synthesize an answer with citations.
3. If the answer is valuable, file it back as a new page in `wiki/outputs/`.

Good answers should not disappear into chat history. File them into the wiki so your explorations compound alongside ingested sources.

### Lint

Periodically health-check the wiki:
- Contradictions between pages.
- Stale claims that newer sources have superseded.
- Orphan pages with no inbound links.
- Important concepts mentioned but lacking their own page.
- Missing cross-references.
- Data gaps that could be filled with additional sources.

## Conventions

- Treat `raw/` as immutable. Never modify source documents.
- Treat `wiki/` as your maintained knowledge base. Create, update, and cross-reference freely.
- Use wiki-style links: `[[path/to/page|Display Title]]`.
- Add YAML frontmatter to every wiki page (at minimum: title, tags, source_ids).
- Each `wiki/log.md` entry should start with a consistent prefix for parseability:
  `## [YYYY-MM-DD] operation | Title`
- Cite source documents by filename when making claims.
- Preserve contradictions instead of smoothing them away. Flag them explicitly.
- Keep `wiki/index.md` up to date on every ingest.
- Prefer stable, descriptive page titles.

## Page Structure

### Source pages (`wiki/sources/`)
- Stay grounded in the original material.
- Note key claims, entities mentioned, and how this source relates to existing wiki content.
- Flag what is new, what reinforces existing knowledge, and what conflicts.

### Concept pages (`wiki/concepts/`)
- Aggregate source-backed claims.
- Cross-reference related concepts and entities.
- Track how understanding has evolved as sources accumulated.

### Entity pages (`wiki/entities/`)
- Named people, organizations, places, tools, etc.
- Cross-reference every source that mentions the entity.
- Note relationships between entities.

## Categories

- List domain-specific concept categories here.
- List important entity types here.

## Relationship Types

- Mentions
- Supports
- Contradicts
- Builds On
- Questions

## Grounding Rules

- Prefer raw sources over summaries.
- Cite source filenames whenever claims are stated.
- Do not treat the wiki as a source of truth when the raw material disagrees.
- Preserve uncertainty and open questions.
