# Research Deep Dive Example

Use this when you want to build an evolving thesis wiki from multiple research sources, with contradiction detection across claims.

This example uses the topic "RAG vs. Compiled Knowledge Bases" to demonstrate how SwarmVault synthesizes conflicting perspectives into a navigable knowledge structure.

## What this demonstrates

- Incremental research ingestion with guided extraction
- Concept and entity page generation from academic/practitioner sources
- Thesis evolution as new sources add nuance or disagreement
- Contradiction detection across sources via deep linting

## Sources

The `raw/` directory contains four synthetic research note files that deliberately overlap and contradict each other:

| File | Perspective |
|---|---|
| `rag-survey-2024.md` | Survey of traditional RAG -- presents retrieval augmentation as the dominant paradigm |
| `compiled-knowledge-karpathy.md` | Karpathy's LLM Wiki thesis -- argues compiled knowledge outperforms retrieval |
| `hybrid-approaches-2025.md` | Middle-ground view combining both approaches |
| `production-rag-lessons.md` | Practitioner report on production RAG failures -- reinforces compiled-knowledge claims |

## Workflow

### 1. Initialize the vault

```sh
swarmvault init --profile personal-research
```

The `personal-research` profile tunes extraction toward thesis tracking, concept linking, and contradiction awareness.

### 2. Ingest sources one at a time

Ingesting incrementally lets you watch the wiki evolve with each new source.

```sh
swarmvault ingest raw/rag-survey-2024.md --guide
swarmvault ingest raw/compiled-knowledge-karpathy.md --guide
swarmvault ingest raw/hybrid-approaches-2025.md --guide
swarmvault ingest raw/production-rag-lessons.md --guide
```

The `--guide` flag walks you through extraction decisions and shows which concepts, entities, and claims are being created or updated.

### 3. Compile the wiki

```sh
swarmvault compile
```

This merges extracted claims, links shared concepts, and generates wiki pages. After compilation you should see:

- **Concept pages** for topics like "retrieval-augmented generation", "compiled knowledge bases", "context window utilization", and "hybrid retrieval"
- **Entity pages** for referenced people and systems (Karpathy, GPT-4, etc.)
- **Cross-references** linking claims back to their source files

### 4. Query for synthesis

```sh
swarmvault query "What are the main arguments for and against RAG?"
swarmvault query "Where do the sources disagree on retrieval quality?"
```

Queries draw from the compiled wiki, not raw files, so answers reflect the merged knowledge graph.

### 5. Lint for contradictions

```sh
swarmvault lint --deep
```

Deep linting compares claims across sources and flags contradictions. With these four sources you should see contradictions flagged around:

- Whether retrieval quality is "good enough" for production use (the survey says yes; the practitioner report says no)
- Whether larger context windows eliminate the need for retrieval (Karpathy says yes; the hybrid paper says not yet)
- Whether RAG handles multi-hop reasoning well (the survey is optimistic; the practitioner report documents failures)

## How the wiki compounds

Each ingested source adds to and refines the wiki:

1. **After the RAG survey**: the wiki presents RAG as the established approach with broad support.
2. **After the Karpathy notes**: a competing thesis appears. Concept pages now show two positions. The compiled-knowledge page links back to both sources.
3. **After the hybrid paper**: the binary framing softens. A new "hybrid retrieval" concept page appears, and existing pages gain cross-references to the middle-ground view.
4. **After the practitioner report**: the weight of evidence shifts. Claims about RAG production quality gain a contradicting source, and `lint --deep` flags the disagreement explicitly.

This incremental compounding is the core value of the research deep-dive workflow: each new source does not just add pages, it reshapes existing ones.
