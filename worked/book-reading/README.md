# Book Reading Example

Build a companion wiki as you read a book chapter by chapter, like a personal fan wiki.

This example uses *The Cartographer's Lens*, an original sample novel about a young cartographer uncovering a decades-old error in provincial survey data.

## What this demonstrates

- Incremental ingest: adding chapters one at a time as you read
- Automatic extraction of characters, settings, themes, and relationships
- The compounding effect: each new chapter enriches existing pages rather than creating isolated notes
- Querying the growing wiki to answer questions that span multiple chapters

## Workflow

### 1. Initialize a vault

```bash
mkdir book-wiki && cd book-wiki
swarmvault init --obsidian
```

### 2. Ingest the first chapter

Copy `raw/chapter-1.md` into your vault's `raw/` directory, then ingest:

```bash
cp worked/book-reading/raw/chapter-1.md raw/
swarmvault ingest raw/chapter-1.md
swarmvault compile
```

After the first chapter you should see wiki pages for:

- **Characters**: Maren Voss, Dr. Tomas Lune, Ren Haldane, Sable, Aldric Voss
- **Settings**: Kindra Harbor, the observatory, the archive
- **Themes**: the Thornback discrepancy, old measurements vs. new surveys, father-daughter legacy

### 3. Add more chapters

As you continue reading, add each chapter the same way:

```bash
cp worked/book-reading/raw/chapter-2.md raw/
swarmvault ingest raw/chapter-2.md
swarmvault compile
```

With Chapter 2 ingested, existing character pages gain new detail — Lune's theory about proper motion, Ren's knowledge of Aldric Voss's reputation. The archive and Priya Kesh emerge as key elements. The theme shifts from a personal discrepancy to a systematic catalog error.

```bash
cp worked/book-reading/raw/chapter-3.md raw/
swarmvault ingest raw/chapter-3.md
swarmvault compile
```

Chapter 3 introduces the antagonist Edric Soren, the discrepancy register, and raises the stakes from scientific disagreement to institutional cover-up. Character relationships deepen.

### 4. Query

Ask questions that span the material ingested so far:

```bash
swarmvault query "What is the Thornback discrepancy and what caused it?"
swarmvault query "Who is Priya Kesh and why does her work matter?"
swarmvault query "List every character and their relationship to the cartographic dispute"
```

### 5. Lint

Check the wiki for structural issues:

```bash
swarmvault lint
```

## The compounding effect

The value grows with each chapter. Early pages are sparse. By Chapter 3, the Maren character page carries details from multiple scenes, theme pages draw connections across chapters, and queries can synthesize material you might not have linked yourself. The wiki becomes a reading companion that remembers everything.

## Included sources

| File | Content |
|------|---------|
| `raw/chapter-1.md` | Chapter 1: The Arrival — Maren reaches Kindra Observatory |
| `raw/chapter-2.md` | Chapter 2: The Archive — discovering the catalog error |
| `raw/chapter-3.md` | Chapter 3: The Rival Survey — the stakes escalate |
