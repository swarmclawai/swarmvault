# SwarmVault Review Fixes — Design Spec

## Problem

A project review against `spec.md` identified 10 issues across architecture, developer infrastructure, and housekeeping. This spec designs fixes for all of them, organized into four shippable slices.

## Slices

| # | Name | Scope | Risk |
|---|------|-------|------|
| 1 | Infrastructure foundation | Biome, lefthook, GitHub Actions CI | Low |
| 2 | Architecture fixes | Incremental compilation, raw-source grounding, computed confidence, concept-scoped conflicts | Medium |
| 3 | CLI --json flag | Structured JSON output on all commands + tests | Low |
| 4 | Cleanup | Watch error recovery, remove apps/site/, docs drift note | Low |

---

## Slice 1: Infrastructure Foundation

### Biome

**Files to create/modify:**
- `opensource/biome.json` — new config file
- `opensource/package.json` — add devDependency + scripts

**Config:**
- Formatter: 2-space indentation (matching existing code), double quotes, trailing commas
- Linter: recommended preset, TypeScript + JSX enabled
- Organize imports: enabled

**Scripts to add:**
```
"lint": "biome check .",
"lint:fix": "biome check --write .",
"format": "biome format --write .",
"check": "biome check . && pnpm -r run typecheck"
```

Each package gets a `typecheck` script: `tsc --noEmit`.

**Existing violations:** Fix any lint/format issues Biome flags on the current codebase as part of this slice. Commit separately from config changes so the diff is reviewable.

### Lefthook (pre-commit)

**Files to create/modify:**
- `opensource/lefthook.yml` — new config file
- `opensource/package.json` — add `@evilmartians/lefthook` devDependency + `"prepare": "lefthook install"` script

**Hook config:**
```yaml
pre-commit:
  commands:
    lint:
      glob: "*.{ts,tsx,js,jsx,json}"
      run: pnpm biome check --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
      stage_fixed: true
```

### GitHub Actions CI

**Files to create:**
- `opensource/.github/workflows/ci.yml`

**Workflow:**
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm test
```

Single job, no matrix (Node 24 only).

---

## Slice 2: Architecture Fixes

All four changes land together as one cohesive modification to the compile/query pipeline.

### 2A: Incremental Compilation

**Problem:** `compileVault()` processes all sources every time. Analysis is cached, but text extraction, page generation, graph building, and search indexing run unconditionally.

**Files to modify:**
- `packages/engine/src/vault.ts` — `compileVault()` function

**Design:**

```
compileVault(rootDir):
  1. Load compile-state.json (existing file at paths.compileStatePath)
  2. Load all manifests (cheap — just JSON reads)
  3. Load schema + compute schema hash
  4. Partition manifests into dirty/clean:
     - Dirty if: no cached analysis, or manifest.contentHash changed, or schema hash changed
     - Clean otherwise
  5. For clean sources: load cached analysis from state/analyses/{sourceId}.json
  6. For dirty sources: call analyzeSource() (reads extract, calls LLM or heuristic)
  7. Combine all analyses (clean + dirty)
  8. If dirty set is empty AND schema hasn't changed: return early with previous compile result
  9. Generate pages, graph, search index as before (using all analyses)
  10. Write updated compile-state.json
```

The key savings:
- **No extracted text reads** for clean sources (currently reads all extracts even if cached)
- **No LLM calls** for clean sources (already true via cache, but now we skip the cache-check overhead too)
- **Full early-return** when nothing changed at all
- `writeFileIfChanged()` already prevents unnecessary disk writes for unchanged pages

**Compile state format** (already exists, minor additions):
```typescript
interface CompileState {
  generatedAt: string;
  schemaHash: string;
  analyses: Record<string, string>; // sourceId -> analysisSignature
  // New: track manifest content hashes for change detection
  sourceHashes: Record<string, string>; // sourceId -> contentHash
}
```

### 2B: Raw-Source Grounding in Queries

**Problem:** `queryVault()` only searches wiki pages. Answers are based on LLM-generated summaries, not original documents.

**Files to modify:**
- `packages/engine/src/vault.ts` — `queryVault()` function

**Design:**

After FTS returns relevant wiki pages:

```
1. Extract source_ids from matched pages' frontmatter
2. Deduplicate source IDs
3. For each source ID, load extracted text via readExtractedText()
4. Truncate raw excerpts (max 800 chars each, up to 5 sources)
5. Build prompt with two sections:
   - "Wiki context:" (existing wiki excerpts — for structure and navigation)
   - "Raw source material:" (extracted text — for grounding)
6. Update system prompt:
   "Answer using the provided context. Prefer raw source material over
    wiki summaries when they differ. Cite source IDs."
```

**Heuristic provider fallback:** When using the heuristic provider (no LLM), include raw source excerpts in the text output alongside wiki page references.

### 2C: Computed Confidence

**Problem:** Hardcoded confidence values throughout `vault.ts` and `markdown.ts`.

**Files to modify:**
- `packages/engine/src/vault.ts` — `buildGraph()` function
- `packages/engine/src/markdown.ts` — all `build*Page()` functions

**Formulas:**

```typescript
// Node confidence: scale by source count
function nodeConfidence(sourceCount: number): number {
  return Math.min(0.5 + sourceCount * 0.15, 0.95);
}

// Edge confidence: mean claim confidence for that concept in that source
function edgeConfidence(claims: SourceClaim[], conceptName: string): number {
  const relevant = claims.filter(c =>
    c.text.toLowerCase().includes(conceptName.toLowerCase())
  );
  if (!relevant.length) return 0.5;
  return relevant.reduce((sum, c) => sum + c.confidence, 0) / relevant.length;
}

// Conflict edge confidence: min of opposing claim confidences
function conflictConfidence(claimA: SourceClaim, claimB: SourceClaim): number {
  return Math.min(claimA.confidence, claimB.confidence);
}
```

**Page confidence:**

| Page kind | Formula |
|-----------|---------|
| Source | `1.0` (primary material) |
| Concept/entity | `nodeConfidence(sourceIds.length)` |
| Output | Mean confidence of cited source pages (default `0.7` if no citations) |
| Index | `1.0` |

### 2D: Concept-Scoped Conflict Detection

**Problem:** Current conflict detection uses raw word overlap between negative and positive claims, producing false positives.

**Files to modify:**
- `packages/engine/src/vault.ts` — conflict detection loop in `buildGraph()`

**Design:**

Replace the word-overlap loop (lines 87-103) with:

```
1. Build a concept-claim index:
   For each analysis, for each claim, find which concepts
   the claim references (claim.text contains concept.name,
   case-insensitive)

2. Group claims by concept across all analyses

3. For each concept group:
   a. Find claim pairs where:
      - Different sourceId
      - Opposing polarity (one positive, one negative)
   b. Create a conflict edge between the two sources
      with confidence = min(claimA.confidence, claimB.confidence)
      and provenance = [sourceIdA, sourceIdB]

4. Deduplicate edges by (source, target, relation) tuple
```

This scopes conflicts to shared concepts, eliminating false positives from coincidental word matches.

### Tests for Slice 2

**New file:** `packages/engine/test/incremental.test.ts`

Tests:
- Compile twice with no changes — second compile is a no-op (no pages changed)
- Compile, modify one source's content hash — only that source re-analyzed
- Compile, change schema — all sources re-analyzed
- Query returns raw source excerpts alongside wiki excerpts
- Confidence values scale with source count
- Conflict detection only fires for opposing claims on shared concepts

---

## Slice 3: CLI --json Flag

**Files to modify:**
- `packages/cli/src/index.ts` — all command actions

**Design:**

Add global option:
```typescript
program.option("--json", "Emit structured JSON output", false);
```

Each command checks `program.opts().json`:

| Command | JSON output |
|---------|-------------|
| `init` | `{ "status": "initialized", "rootDir": "..." }` |
| `ingest` | Full `SourceManifest` object |
| `inbox import` | Full `InboxImportResult` object |
| `compile` | Full `CompileResult` object |
| `query` | Full `QueryResult` object |
| `lint` | `LintFinding[]` array |
| `graph serve` | `{ "port": 4123, "url": "http://localhost:4123" }` |
| `watch` | `{ "status": "watching", "inboxDir": "..." }` |
| `mcp` | `{ "status": "running", "transport": "stdio" }` |
| `install` | `{ "agent": "claude", "target": "CLAUDE.md" }` |

JSON output goes to stdout. Human-readable messages go to stderr when `--json` is set (so they don't corrupt the JSON).

**Helper:**
```typescript
function output(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else {
    // existing human-readable output
  }
}
```

### Tests for Slice 3

**New file:** `packages/cli/test/json-output.test.ts`

Tests (using vitest and `node:child_process` `execFile`):
- `swarmvault init --json` — valid JSON with `status` field
- `swarmvault ingest <file> --json` — valid JSON with `sourceId` field
- `swarmvault compile --json` — valid JSON with `pageCount` field
- `swarmvault lint --json` — valid JSON array

---

## Slice 4: Cleanup

### Watch Mode Error Recovery

**Files to modify:**
- `packages/engine/src/watch.ts`

**Design:**
- Add a `consecutiveFailures` counter to the watch loop
- On error: increment counter, log warning
- After 3 consecutive failures: increase debounce interval with exponential backoff (2x per failure, capped at 30 seconds)
- On success: reset counter and debounce to original value
- After 10 consecutive failures: log error suggesting manual intervention, continue watching at max backoff

### Remove apps/site/

**Action:** Delete `apps/site/` directory and `apps/` parent if empty. This is in the parent repo (`new-ai-project/`), not in `opensource/`.

### Docs Drift Note

**Files to modify:**
- `opensource/CONTRIBUTING.md`

**Addition:** Add a "Documentation Site" section explaining:
- The docs site lives in a separate repository (`swarmclawai/swarmvault-site`)
- CLI command changes need corresponding manual doc updates
- The navigation structure is in `web/src/lib/docs-nav.ts`
- MDX content lives in `web/src/content/docs/`

---

## Verification Plan

### Slice 1
- `pnpm check` passes (Biome lint + type-check)
- `pnpm test` passes
- `git commit` triggers lefthook pre-commit check
- Push to branch — GitHub Actions CI runs green

### Slice 2
- Existing tests still pass
- New `incremental.test.ts` tests pass
- Manual test: `swarmvault init && swarmvault ingest <file> && swarmvault compile && swarmvault compile` — second compile reports 0 changed pages
- Manual test: `swarmvault query "..."` — answer references raw source material
- Graph viewer shows non-uniform confidence values on nodes/edges

### Slice 3
- `swarmvault compile --json | jq .` — parses as valid JSON
- `swarmvault lint --json | jq .` — parses as valid JSON array
- New `json-output.test.ts` tests pass

### Slice 4
- Watch mode: create a malformed file in inbox, observe backoff behavior in logs
- `apps/site/` directory no longer exists
- CONTRIBUTING.md has docs site section
