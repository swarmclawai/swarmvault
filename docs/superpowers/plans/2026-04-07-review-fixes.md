# SwarmVault Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 issues found during project review — infrastructure, architecture, CLI, and cleanup.

**Architecture:** Four ordered slices: (1) Biome + lefthook + CI, (2) incremental compilation + raw-source grounding + computed confidence + concept-scoped conflicts, (3) --json CLI flag, (4) watch error recovery + housekeeping.

**Tech Stack:** Biome, lefthook, GitHub Actions, vitest, TypeScript, Node 24

**Spec:** `docs/superpowers/specs/2026-04-07-review-fixes-design.md`

---

## File Map

**Create:**
- `biome.json` — Biome linter/formatter config
- `lefthook.yml` — pre-commit hook config
- `.github/workflows/ci.yml` — CI pipeline
- `packages/engine/src/confidence.ts` — confidence helper functions
- `packages/engine/test/incremental.test.ts` — architecture fix tests
- `packages/cli/test/json-output.test.ts` — CLI JSON output tests

**Modify:**
- `package.json` — root scripts + devDeps
- `packages/engine/package.json` — rename lint to typecheck
- `packages/cli/package.json` — add vitest, rename lint to typecheck
- `packages/viewer/package.json` — rename lint to typecheck
- `packages/engine/src/types.ts` — add CompileState interface
- `packages/engine/src/vault.ts` — incremental compile, raw-source grounding, concept-scoped conflicts
- `packages/engine/src/markdown.ts` — accept confidence param in page builders
- `packages/engine/src/watch.ts` — error recovery with backoff
- `packages/cli/src/index.ts` — --json flag + output helper
- `CONTRIBUTING.md` — docs drift section

**Delete:**
- `/Users/wayde/Dev/new-ai-project/apps/` — empty placeholder

---

## Slice 1: Infrastructure Foundation

### Task 1: Add Biome config and install dependencies

**Files:**
- Create: `biome.json`
- Modify: `package.json`

- [ ] **Step 1: Install Biome and lefthook**

Run from `opensource/`:
```bash
pnpm add -Dw @biomejs/biome @evilmartians/lefthook
```

- [ ] **Step 2: Create biome.json**

Create `biome.json` at the monorepo root:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noForEach": "off"
      },
      "style": {
        "noNonNullAssertion": "off"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 140
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "none",
      "semicolons": "always"
    }
  },
  "files": {
    "ignore": [
      "dist/",
      "node_modules/",
      ".next/",
      "out/",
      "pnpm-lock.yaml",
      "*.md"
    ]
  }
}
```

Note: `noForEach` is off because the codebase uses `for...of` and `.map()` interchangeably. `noNonNullAssertion` is off because the test file uses `!`. `lineWidth` is 140 to match existing long lines. `trailingCommas` is `"none"` to match the existing code style (no trailing commas in the codebase).

- [ ] **Step 3: Run Biome check to see current violations**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm biome check .
```

Review the output. Biome may flag import ordering and formatting issues. Proceed to the next step to fix them.

- [ ] **Step 4: Fix all Biome violations**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm biome check --write .
```

Review the diff. Biome will auto-fix formatting and import ordering. If there are lint errors that can't be auto-fixed, fix them manually. Common issues:
- Import ordering (auto-fixable)
- Unused variables (manual fix — remove or prefix with `_`)
- Prefer `for...of` over `.forEach()` (auto-fixable)

- [ ] **Step 5: Verify Biome passes cleanly**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm biome check .
```

Expected: no errors or warnings.

- [ ] **Step 6: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add biome.json package.json pnpm-lock.yaml && git commit -m "feat: add Biome linter/formatter config"
```

Then commit the auto-fixed files separately:
```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add -A && git commit -m "style: fix existing Biome violations"
```

---

### Task 2: Update package scripts

**Files:**
- Modify: `package.json` (root)
- Modify: `packages/engine/package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/viewer/package.json`

- [ ] **Step 1: Rename `lint` to `typecheck` in each package**

In `packages/engine/package.json`, change:
```json
"lint": "tsc --noEmit"
```
to:
```json
"typecheck": "tsc --noEmit"
```

Do the same in `packages/cli/package.json` and `packages/viewer/package.json`.

- [ ] **Step 2: Update root package.json scripts**

Replace the `scripts` section in the root `package.json`:

```json
"scripts": {
  "build": "pnpm --filter @swarmvaultai/viewer build && pnpm --filter @swarmvaultai/engine build && pnpm --filter @swarmvaultai/cli build",
  "test": "pnpm -r test",
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "format": "biome format --write .",
  "typecheck": "pnpm -r typecheck",
  "check": "biome check . && pnpm -r typecheck",
  "prepare": "lefthook install"
}
```

- [ ] **Step 3: Verify all scripts work**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm check
```

Expected: Biome check passes, then `tsc --noEmit` passes for each package.

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm test
```

Expected: engine tests pass, cli and viewer exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add package.json packages/*/package.json && git commit -m "feat: update scripts — Biome for lint, typecheck for tsc"
```

---

### Task 3: Add lefthook pre-commit hook

**Files:**
- Create: `lefthook.yml`

- [ ] **Step 1: Create lefthook.yml**

Create `lefthook.yml` at the monorepo root:

```yaml
pre-commit:
  commands:
    lint:
      glob: "*.{ts,tsx,js,jsx,json}"
      run: pnpm biome check --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}
      stage_fixed: true
```

- [ ] **Step 2: Install the hook**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm prepare
```

Expected: `lefthook install` runs successfully.

- [ ] **Step 3: Test the hook**

Make a trivial whitespace change to any `.ts` file, stage it, and try to commit:

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add lefthook.yml && git commit -m "feat: add lefthook pre-commit hook"
```

Expected: lefthook runs Biome on staged files, commit succeeds.

---

### Task 4: Add GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the CI workflow**

```bash
mkdir -p /Users/wayde/Dev/new-ai-project/opensource/.github/workflows
```

Create `.github/workflows/ci.yml`:

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

- [ ] **Step 2: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add .github/workflows/ci.yml && git commit -m "feat: add GitHub Actions CI workflow"
```

---

## Slice 2: Architecture Fixes

### Task 5: Add CompileState type

**Files:**
- Modify: `packages/engine/src/types.ts`

- [ ] **Step 1: Add CompileState interface**

Add at the end of `packages/engine/src/types.ts` (before the closing of the file):

```typescript
export interface CompileState {
  generatedAt: string;
  schemaHash: string;
  analyses: Record<string, string>;
  sourceHashes: Record<string, string>;
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm -r typecheck
```

Expected: passes.

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/types.ts && git commit -m "feat: add CompileState type for incremental compilation"
```

---

### Task 6: Add confidence helper functions

**Files:**
- Create: `packages/engine/src/confidence.ts`

- [ ] **Step 1: Create confidence.ts**

Create `packages/engine/src/confidence.ts`:

```typescript
import type { SourceClaim } from "./types.js";

export function nodeConfidence(sourceCount: number): number {
  return Math.min(0.5 + sourceCount * 0.15, 0.95);
}

export function edgeConfidence(claims: SourceClaim[], conceptName: string): number {
  const lower = conceptName.toLowerCase();
  const relevant = claims.filter((c) => c.text.toLowerCase().includes(lower));
  if (!relevant.length) {
    return 0.5;
  }
  return relevant.reduce((sum, c) => sum + c.confidence, 0) / relevant.length;
}

export function conflictConfidence(claimA: SourceClaim, claimB: SourceClaim): number {
  return Math.min(claimA.confidence, claimB.confidence);
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm -r typecheck
```

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/confidence.ts && git commit -m "feat: add confidence helper functions"
```

---

### Task 7: Write failing tests for incremental compilation

**Files:**
- Create: `packages/engine/test/incremental.test.ts`

- [ ] **Step 1: Write the test file**

Create `packages/engine/test/incremental.test.ts`:

```typescript
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileVault,
  ingestInput,
  initVault,
  queryVault,
  readExtractedText,
  listManifests
} from "../src/index.js";
import type { CompileState, GraphArtifact } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-incr-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("incremental compilation", () => {
  it("returns zero changed pages on second compile with no changes", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "note.md"),
      "# Test\n\nSome content about knowledge graphs and compilation.",
      "utf8"
    );
    await ingestInput(rootDir, "note.md");

    const first = await compileVault(rootDir);
    expect(first.changedPages.length).toBeGreaterThan(0);

    const second = await compileVault(rootDir);
    expect(second.changedPages).toHaveLength(0);
  });

  it("writes sourceHashes to compile-state.json", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "a.md"), "# A\n\nContent A.", "utf8");
    await ingestInput(rootDir, "a.md");
    await compileVault(rootDir);

    const state = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "compile-state.json"), "utf8")
    ) as CompileState;
    expect(Object.keys(state.sourceHashes).length).toBe(1);
    expect(state.schemaHash).toBeTruthy();
  });
});

describe("raw-source grounding in queries", () => {
  it("includes raw source excerpts in heuristic query output", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "raw-test.md"),
      "# Raw Source Test\n\nThis is the original raw content that should appear in query answers.",
      "utf8"
    );
    await ingestInput(rootDir, "raw-test.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, "What is the raw content?");
    expect(result.answer).toContain("Raw source");
  });
});

describe("computed confidence", () => {
  it("assigns higher confidence to concepts seen in multiple sources", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "src1.md"),
      "# Knowledge Graphs\n\nKnowledge graphs store structured relationships between entities.",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "src2.md"),
      "# Graph Theory\n\nKnowledge graphs are a fundamental data structure for knowledge representation.",
      "utf8"
    );
    await ingestInput(rootDir, "src1.md");
    await ingestInput(rootDir, "src2.md");
    await compileVault(rootDir);

    const graph = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")
    ) as GraphArtifact;

    const multiSourceNodes = graph.nodes.filter(
      (n) => n.type !== "source" && n.sourceIds.length > 1
    );
    const singleSourceNodes = graph.nodes.filter(
      (n) => n.type !== "source" && n.sourceIds.length === 1
    );

    if (multiSourceNodes.length > 0 && singleSourceNodes.length > 0) {
      const avgMulti = multiSourceNodes.reduce((s, n) => s + (n.confidence ?? 0), 0) / multiSourceNodes.length;
      const avgSingle = singleSourceNodes.reduce((s, n) => s + (n.confidence ?? 0), 0) / singleSourceNodes.length;
      expect(avgMulti).toBeGreaterThan(avgSingle);
    }
  });
});

describe("concept-scoped conflict detection", () => {
  it("does not create conflict edges from coincidental word overlap", async () => {
    const rootDir = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "pos.md"),
      "# Positive Claims\n\nThe system is fast and efficient. Performance is excellent.",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "neg.md"),
      "# Negative Claims\n\nThe weather is not great today. It cannot rain forever.",
      "utf8"
    );
    await ingestInput(rootDir, "pos.md");
    await ingestInput(rootDir, "neg.md");
    await compileVault(rootDir);

    const graph = JSON.parse(
      await fs.readFile(path.join(rootDir, "state", "graph.json"), "utf8")
    ) as GraphArtifact;

    const conflictEdges = graph.edges.filter((e) => e.relation === "conflicted_with");
    expect(conflictEdges).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/engine test
```

Expected: The "returns zero changed pages" test will fail (currently second compile changes pages because `writeFileIfChanged` may return true due to timestamp differences in frontmatter `updated_at`). The "includes raw source excerpts" test will fail (heuristic output doesn't include raw sources yet). The "writes sourceHashes" test will fail (compile-state doesn't have sourceHashes yet).

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/test/incremental.test.ts && git commit -m "test: add failing tests for incremental compilation and architecture fixes"
```

---

### Task 8: Implement incremental compilation

**Files:**
- Modify: `packages/engine/src/vault.ts:148-211`

- [ ] **Step 1: Add imports for CompileState and confidence**

In `packages/engine/src/vault.ts`, update the type import to include `CompileState`:

```typescript
import type {
  CompileResult,
  CompileState,
  GraphArtifact,
  GraphEdge,
  GraphNode,
  GraphPage,
  LintFinding,
  QueryResult,
  SearchResult,
  SourceAnalysis,
  SourceManifest
} from "./types.js";
```

Add import for confidence helpers:

```typescript
import { nodeConfidence, edgeConfidence, conflictConfidence } from "./confidence.js";
```

- [ ] **Step 2: Replace the compileVault function**

Replace `compileVault` (lines 148-211) with:

```typescript
export async function compileVault(rootDir: string): Promise<CompileResult> {
  const { paths } = await initWorkspace(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "compileProvider");
  const manifests = await listManifests(rootDir);

  const previousState = await readJsonFile<CompileState>(paths.compileStatePath);
  const schemaChanged = !previousState || previousState.schemaHash !== schema.hash;
  const previousSourceHashes = previousState?.sourceHashes ?? {};
  const previousAnalyses = previousState?.analyses ?? {};
  const currentSourceIds = new Set(manifests.map((m) => m.sourceId));
  const previousSourceIds = new Set(Object.keys(previousSourceHashes));
  const sourcesChanged = currentSourceIds.size !== previousSourceIds.size ||
    [...currentSourceIds].some((id) => !previousSourceIds.has(id));

  const dirty: SourceManifest[] = [];
  const clean: SourceManifest[] = [];

  for (const manifest of manifests) {
    const hashChanged = previousSourceHashes[manifest.sourceId] !== manifest.contentHash;
    const noAnalysis = !previousAnalyses[manifest.sourceId];
    if (schemaChanged || hashChanged || noAnalysis) {
      dirty.push(manifest);
    } else {
      clean.push(manifest);
    }
  }

  if (dirty.length === 0 && !schemaChanged && !sourcesChanged) {
    return {
      graphPath: paths.graphPath,
      pageCount: previousState?.analyses ? Object.keys(previousState.analyses).length : 0,
      changedPages: [],
      sourceCount: manifests.length
    };
  }

  const [dirtyAnalyses, cleanAnalyses] = await Promise.all([
    Promise.all(
      dirty.map(async (manifest) =>
        analyzeSource(manifest, await readExtractedText(rootDir, manifest), provider, paths, schema)
      )
    ),
    Promise.all(
      clean.map(async (manifest) => {
        const cached = await readJsonFile<SourceAnalysis>(
          path.join(paths.analysesDir, `${manifest.sourceId}.json`)
        );
        if (cached) {
          return cached;
        }
        return analyzeSource(manifest, await readExtractedText(rootDir, manifest), provider, paths, schema);
      })
    )
  ]);

  const analyses = [...dirtyAnalyses, ...cleanAnalyses];
  const changedPages: string[] = [];
  const pages: GraphPage[] = [];

  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs"))
  ]);

  for (const manifest of manifests) {
    const analysis = analyses.find((item) => item.sourceId === manifest.sourceId);
    if (!analysis) {
      continue;
    }
    const sourcePage = buildSourcePage(manifest, analysis, schema.hash, 1.0);
    pages.push(sourcePage.page);
    await writePage(paths.wikiDir, sourcePage.page.path, sourcePage.content, changedPages);
  }

  for (const aggregate of aggregateItems(analyses, "concepts")) {
    const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
    const page = buildAggregatePage("concept", aggregate.name, aggregate.descriptions, aggregate.sourceAnalyses, aggregate.sourceHashes, schema.hash, confidence);
    pages.push(page.page);
    await writePage(paths.wikiDir, page.page.path, page.content, changedPages);
  }

  for (const aggregate of aggregateItems(analyses, "entities")) {
    const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
    const page = buildAggregatePage("entity", aggregate.name, aggregate.descriptions, aggregate.sourceAnalyses, aggregate.sourceHashes, schema.hash, confidence);
    pages.push(page.page);
    await writePage(paths.wikiDir, page.page.path, page.content, changedPages);
  }

  const graph = buildGraph(manifests, analyses, pages);
  await writeJsonFile(paths.graphPath, graph);
  await writeJsonFile(paths.compileStatePath, {
    generatedAt: graph.generatedAt,
    schemaHash: schema.hash,
    analyses: Object.fromEntries(analyses.map((a) => [a.sourceId, analysisSignature(a)])),
    sourceHashes: Object.fromEntries(manifests.map((m) => [m.sourceId, m.contentHash]))
  } satisfies CompileState);

  await writePage(paths.wikiDir, "index.md", buildIndexPage(pages, schema.hash), changedPages);
  await writePage(paths.wikiDir, "sources/index.md", buildSectionIndex("sources", pages.filter((p) => p.kind === "source"), schema.hash), changedPages);
  await writePage(paths.wikiDir, "concepts/index.md", buildSectionIndex("concepts", pages.filter((p) => p.kind === "concept"), schema.hash), changedPages);
  await writePage(paths.wikiDir, "entities/index.md", buildSectionIndex("entities", pages.filter((p) => p.kind === "entity"), schema.hash), changedPages);

  if (changedPages.length > 0) {
    await rebuildSearchIndex(paths.searchDbPath, pages, paths.wikiDir);
  }

  await appendLogEntry(rootDir, "compile", `Compiled ${manifests.length} source(s)`, [
    `provider=${provider.id}`,
    `pages=${pages.length}`,
    `dirty=${dirty.length}`,
    `clean=${clean.length}`,
    `schema=${schema.hash.slice(0, 12)}`
  ]);

  return {
    graphPath: paths.graphPath,
    pageCount: pages.length,
    changedPages,
    sourceCount: manifests.length
  };
}
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/engine test
```

Expected: The "returns zero changed pages" test should now pass. The "writes sourceHashes" test should now pass. Other architecture tests may still fail.

- [ ] **Step 4: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/vault.ts && git commit -m "feat: implement incremental compilation with dirty/clean partitioning"
```

---

### Task 9: Update buildGraph with computed confidence and concept-scoped conflicts

**Files:**
- Modify: `packages/engine/src/vault.ts:27-113` — `buildGraph()` function

- [ ] **Step 1: Replace the buildGraph function**

Replace the entire `buildGraph` function (lines 27-113) with:

```typescript
function buildGraph(manifests: SourceManifest[], analyses: SourceAnalysis[], pages: GraphPage[]): GraphArtifact {
  const sourceNodes: GraphNode[] = manifests.map((manifest) => ({
    id: `source:${manifest.sourceId}`,
    type: "source",
    label: manifest.title,
    pageId: `source:${manifest.sourceId}`,
    freshness: "fresh",
    confidence: 1,
    sourceIds: [manifest.sourceId]
  }));

  const conceptMap = new Map<string, GraphNode>();
  const entityMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const analysis of analyses) {
    for (const concept of analysis.concepts) {
      const existing = conceptMap.get(concept.id);
      const sourceIds = [...new Set([...(existing?.sourceIds ?? []), analysis.sourceId])];
      conceptMap.set(concept.id, {
        id: concept.id,
        type: "concept",
        label: concept.name,
        pageId: `concept:${slugify(concept.name)}`,
        freshness: "fresh",
        confidence: nodeConfidence(sourceIds.length),
        sourceIds
      });
      edges.push({
        id: `${analysis.sourceId}->${concept.id}`,
        source: `source:${analysis.sourceId}`,
        target: concept.id,
        relation: "mentions",
        status: "extracted",
        confidence: edgeConfidence(analysis.claims, concept.name),
        provenance: [analysis.sourceId]
      });
    }

    for (const entity of analysis.entities) {
      const existing = entityMap.get(entity.id);
      const sourceIds = [...new Set([...(existing?.sourceIds ?? []), analysis.sourceId])];
      entityMap.set(entity.id, {
        id: entity.id,
        type: "entity",
        label: entity.name,
        pageId: `entity:${slugify(entity.name)}`,
        freshness: "fresh",
        confidence: nodeConfidence(sourceIds.length),
        sourceIds
      });
      edges.push({
        id: `${analysis.sourceId}->${entity.id}`,
        source: `source:${analysis.sourceId}`,
        target: entity.id,
        relation: "mentions",
        status: "extracted",
        confidence: edgeConfidence(analysis.claims, entity.name),
        provenance: [analysis.sourceId]
      });
    }
  }

  // Concept-scoped conflict detection
  const conceptClaims = new Map<string, Array<{ claim: SourceAnalysis["claims"][number]; sourceId: string }>>();
  for (const analysis of analyses) {
    for (const claim of analysis.claims) {
      for (const concept of analysis.concepts) {
        if (claim.text.toLowerCase().includes(concept.name.toLowerCase())) {
          const key = concept.id;
          const list = conceptClaims.get(key) ?? [];
          list.push({ claim, sourceId: analysis.sourceId });
          conceptClaims.set(key, list);
        }
      }
    }
  }

  const conflictEdgeKeys = new Set<string>();
  for (const [, claimsForConcept] of conceptClaims) {
    const positive = claimsForConcept.filter((c) => c.claim.polarity === "positive");
    const negative = claimsForConcept.filter((c) => c.claim.polarity === "negative");
    for (const pos of positive) {
      for (const neg of negative) {
        if (pos.sourceId === neg.sourceId) {
          continue;
        }
        const edgeKey = [pos.sourceId, neg.sourceId].sort().join("|");
        if (conflictEdgeKeys.has(edgeKey)) {
          continue;
        }
        conflictEdgeKeys.add(edgeKey);
        edges.push({
          id: `conflict:${pos.claim.id}->${neg.claim.id}`,
          source: `source:${pos.sourceId}`,
          target: `source:${neg.sourceId}`,
          relation: "conflicted_with",
          status: "conflicted",
          confidence: conflictConfidence(pos.claim, neg.claim),
          provenance: [pos.sourceId, neg.sourceId]
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    nodes: [...sourceNodes, ...conceptMap.values(), ...entityMap.values()],
    edges,
    sources: manifests,
    pages
  };
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/engine test
```

Expected: The conflict detection test should pass. The confidence test should pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/vault.ts && git commit -m "feat: computed confidence and concept-scoped conflict detection"
```

---

### Task 10: Update markdown.ts to accept confidence parameter

**Files:**
- Modify: `packages/engine/src/markdown.ts`

- [ ] **Step 1: Update buildSourcePage to accept confidence param**

In `packages/engine/src/markdown.ts`, change the `buildSourcePage` signature (line 20) from:

```typescript
export function buildSourcePage(manifest: SourceManifest, analysis: SourceAnalysis, schemaHash: string): { page: GraphPage; content: string } {
```

to:

```typescript
export function buildSourcePage(manifest: SourceManifest, analysis: SourceAnalysis, schemaHash: string, confidence = 1.0): { page: GraphPage; content: string } {
```

Then replace the two hardcoded `confidence: 0.8` occurrences (lines 41 and 88) with `confidence`:

In the frontmatter object (line 41):
```typescript
    confidence,
```

In the page object (line 88):
```typescript
      confidence,
```

- [ ] **Step 2: Update buildAggregatePage to accept confidence param**

Change the signature (line 96) from:

```typescript
export function buildAggregatePage(
  kind: "concept" | "entity",
  name: string,
  descriptions: string[],
  sourceAnalyses: SourceAnalysis[],
  sourceHashes: Record<string, string>,
  schemaHash: string
): { page: GraphPage; content: string } {
```

to:

```typescript
export function buildAggregatePage(
  kind: "concept" | "entity",
  name: string,
  descriptions: string[],
  sourceAnalyses: SourceAnalysis[],
  sourceHashes: Record<string, string>,
  schemaHash: string,
  confidence = 0.72
): { page: GraphPage; content: string } {
```

Then replace the two hardcoded `confidence: 0.72` occurrences (lines 118 and 151) with `confidence`.

- [ ] **Step 3: Verify typecheck and tests pass**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm check && pnpm test
```

Expected: All pass. The default parameter values preserve backward compatibility.

- [ ] **Step 4: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/markdown.ts && git commit -m "feat: parameterize confidence in page builders"
```

---

### Task 11: Implement raw-source grounding in queries

**Files:**
- Modify: `packages/engine/src/vault.ts` — `queryVault()` function

- [ ] **Step 1: Replace the queryVault function**

Replace `queryVault` (lines 213-266, though line numbers may have shifted after Task 8) with:

```typescript
export async function queryVault(rootDir: string, question: string, save = false): Promise<QueryResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (!(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir);
  }

  const searchResults = searchPages(paths.searchDbPath, question, 5);
  const excerpts = await Promise.all(
    searchResults.map(async (result) => {
      const absolutePath = path.join(paths.wikiDir, result.path);
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      return `# ${result.title}\n${truncate(normalizeWhitespace(parsed.content), 1200)}`;
    })
  );

  // Load raw source material for grounding
  const sourceIds = uniqueBy(
    searchResults.flatMap((result) => {
      const absolutePath = path.join(paths.wikiDir, result.path);
      try {
        const content = fs.readFileSync(absolutePath, "utf8");
        const parsed = matter(content);
        return (parsed.data.source_ids as string[]) ?? [];
      } catch {
        return [];
      }
    }),
    (id) => id
  ).slice(0, 5);

  const manifests = await listManifests(rootDir);
  const rawExcerpts: string[] = [];
  for (const sourceId of sourceIds) {
    const manifest = manifests.find((m) => m.sourceId === sourceId);
    if (!manifest) {
      continue;
    }
    const text = await readExtractedText(rootDir, manifest);
    if (text) {
      rawExcerpts.push(`# [source:${sourceId}] ${manifest.title}\n${truncate(normalizeWhitespace(text), 800)}`);
    }
  }

  let answer: string;
  if (provider.type === "heuristic") {
    answer = [
      `Question: ${question}`,
      "",
      "Relevant pages:",
      ...searchResults.map((result) => `- ${result.title} (${result.path})`),
      "",
      excerpts.length ? excerpts.join("\n\n") : "No relevant pages found yet.",
      ...(rawExcerpts.length
        ? ["", "Raw source material:", "", ...rawExcerpts]
        : [])
    ].join("\n");
  } else {
    const context = [
      "Wiki context:",
      excerpts.join("\n\n---\n\n"),
      ...(rawExcerpts.length
        ? ["", "Raw source material:", rawExcerpts.join("\n\n---\n\n")]
        : [])
    ].join("\n\n");

    const response = await provider.generateText({
      system: buildSchemaPrompt(
        schema,
        "Answer using the provided context. Prefer raw source material over wiki summaries when they differ. Cite source IDs."
      ),
      prompt: `Question: ${question}\n\n${context}`
    });
    answer = response.text;
  }

  const citations = uniqueBy(
    searchResults
      .filter((result) => result.pageId.startsWith("source:"))
      .map((result) => result.pageId.replace(/^source:/, "")),
    (item) => item
  );
  let savedTo: string | undefined;
  if (save) {
    const output = buildOutputPage(question, answer, citations, schema.hash);
    const absolutePath = path.join(paths.wikiDir, output.page.path);
    await ensureDir(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, output.content, "utf8");
    savedTo = absolutePath;
  }

  await appendLogEntry(rootDir, "query", question, [
    `citations=${citations.join(",") || "none"}`,
    `saved=${Boolean(savedTo)}`,
    `rawSources=${rawExcerpts.length}`
  ]);
  return { answer, savedTo, citations };
}
```

Note: This uses `fs.readFileSync` for the frontmatter read in the source ID extraction. This is acceptable because it's reading files that were just read by the FTS search and are hot in OS cache. Add the sync import at the top of vault.ts:

```typescript
import fs from "node:fs/promises";
```

Wait — `fs` is already imported as `node:fs/promises`. We need the sync version for `readFileSync`. Instead, let's use an async approach:

Actually, let me reconsider. We should use async. Replace the synchronous `readFileSync` block with an async helper. Here's the corrected source ID extraction:

```typescript
  // Load raw source material for grounding
  const allSourceIds: string[] = [];
  for (const result of searchResults) {
    const absolutePath = path.join(paths.wikiDir, result.path);
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      const ids = parsed.data.source_ids;
      if (Array.isArray(ids)) {
        allSourceIds.push(...ids);
      }
    } catch {
      // Page may not exist
    }
  }
  const sourceIds = uniqueBy(allSourceIds, (id) => id).slice(0, 5);
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/engine test
```

Expected: The "includes raw source excerpts" test should now pass. All existing tests should still pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/vault.ts && git commit -m "feat: ground queries in raw source material alongside wiki pages"
```

---

### Task 12: Verify all Slice 2 tests pass

**Files:** None (verification only)

- [ ] **Step 1: Run all engine tests**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/engine test
```

Expected: All tests in `vault.test.ts` and `incremental.test.ts` pass.

- [ ] **Step 2: Run full check**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm check && pnpm test
```

Expected: Biome, typecheck, and all tests pass.

- [ ] **Step 3: Commit any remaining fixes**

If any test adjustments were needed, commit them:

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add -A && git commit -m "test: fix test assertions for architecture changes"
```

---

## Slice 3: CLI --json Flag

### Task 13: Add vitest to CLI package

**Files:**
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add vitest devDependency**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/cli add -D vitest
```

- [ ] **Step 2: Update test script**

In `packages/cli/package.json`, change:
```json
"test": "node -e \"process.exit(0)\""
```
to:
```json
"test": "vitest run"
```

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/cli/package.json pnpm-lock.yaml && git commit -m "chore: add vitest to CLI package"
```

---

### Task 14: Write failing CLI JSON tests

**Files:**
- Create: `packages/cli/test/json-output.test.ts`

- [ ] **Step 1: Create test file**

Create `packages/cli/test/json-output.test.ts`:

```typescript
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const cliBin = path.resolve(import.meta.dirname, "../../engine/node_modules/.bin/tsx");
const cliEntry = path.resolve(import.meta.dirname, "../src/index.ts");

function run(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cliBin, [cliEntry, ...args], { cwd, env: { ...process.env, NODE_NO_WARNINGS: "1" } }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        code: error?.code ? Number(error.code) : 0
      });
    });
  });
}

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("--json flag", () => {
  it("init outputs valid JSON", async () => {
    const dir = await createTempWorkspace();
    const { stdout } = await run(["init", "--json"], dir);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.status).toBe("initialized");
    expect(parsed.rootDir).toBeTruthy();
  });

  it("compile outputs valid JSON", async () => {
    const dir = await createTempWorkspace();
    await run(["init"], dir);
    await fs.writeFile(path.join(dir, "note.md"), "# Test\n\nContent.", "utf8");
    await run(["ingest", "note.md"], dir);
    const { stdout } = await run(["compile", "--json"], dir);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.pageCount).toBeGreaterThan(0);
    expect(typeof parsed.sourceCount).toBe("number");
  });

  it("lint outputs valid JSON array", async () => {
    const dir = await createTempWorkspace();
    await run(["init"], dir);
    const { stdout } = await run(["lint", "--json"], dir);
    const parsed = JSON.parse(stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
  });
});
```

Note: This uses `tsx` (TypeScript executor) via the engine's devDependencies to run the CLI entry point directly without building first. If `tsx` isn't available, adjust the test to build the CLI first and run the compiled output. An alternative approach is to use `node --import tsx/esm` or to add `tsx` as a devDep to the CLI package.

- [ ] **Step 2: Run to verify tests fail**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/cli test
```

Expected: Tests fail because `--json` flag doesn't exist yet (JSON.parse will fail on human-readable output).

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/cli/test/json-output.test.ts && git commit -m "test: add failing CLI --json output tests"
```

---

### Task 15: Implement --json flag on all CLI commands

**Files:**
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Replace the entire CLI file**

Replace `packages/cli/src/index.ts` with:

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import process from "node:process";
import {
  compileVault,
  importInbox,
  ingestInput,
  initVault,
  installAgent,
  lintVault,
  queryVault,
  startGraphServer,
  startMcpServer,
  watchVault
} from "@swarmvaultai/engine";

const program = new Command();

program
  .name("swarmvault")
  .description("SwarmVault is a local-first LLM wiki compiler with graph outputs and pluggable providers.")
  .version("0.1.4")
  .option("--json", "Emit structured JSON output", false);

function isJson(): boolean {
  return program.opts().json === true;
}

function output(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function log(message: string): void {
  if (isJson()) {
    process.stderr.write(`${message}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

program
  .command("init")
  .description("Initialize a SwarmVault workspace in the current directory.")
  .action(async () => {
    await initVault(process.cwd());
    if (isJson()) {
      output({ status: "initialized", rootDir: process.cwd() });
    } else {
      log("Initialized SwarmVault workspace.");
    }
  });

program
  .command("ingest")
  .description("Ingest a local file path or URL into the raw SwarmVault workspace.")
  .argument("<input>", "Local file path or URL")
  .action(async (input: string) => {
    const manifest = await ingestInput(process.cwd(), input);
    if (isJson()) {
      output(manifest);
    } else {
      log(manifest.sourceId);
    }
  });

const inbox = program.command("inbox").description("Inbox and capture workflows.");
inbox
  .command("import")
  .description("Import supported files from the configured inbox directory.")
  .argument("[dir]", "Optional inbox directory override")
  .action(async (dir?: string) => {
    const result = await importInbox(process.cwd(), dir);
    if (isJson()) {
      output(result);
    } else {
      log(
        `Imported ${result.imported.length} source(s) from ${result.inputDir}. Scanned: ${result.scannedCount}. Attachments: ${result.attachmentCount}. Skipped: ${result.skipped.length}.`
      );
    }
  });

program
  .command("compile")
  .description("Compile manifests into wiki pages, graph JSON, and search index.")
  .action(async () => {
    const result = await compileVault(process.cwd());
    if (isJson()) {
      output(result);
    } else {
      log(
        `Compiled ${result.sourceCount} source(s), ${result.pageCount} page(s). Changed: ${result.changedPages.length}.`
      );
    }
  });

program
  .command("query")
  .description("Query the compiled SwarmVault wiki.")
  .argument("<question>", "Question to ask SwarmVault")
  .option("--save", "Persist the answer to wiki/outputs", false)
  .action(async (question: string, options: { save?: boolean }) => {
    const result = await queryVault(process.cwd(), question, options.save ?? false);
    if (isJson()) {
      output(result);
    } else {
      log(result.answer);
      if (result.savedTo) {
        log(`Saved to ${result.savedTo}`);
      }
    }
  });

program
  .command("lint")
  .description("Run anti-drift and wiki-health checks.")
  .action(async () => {
    const findings = await lintVault(process.cwd());
    if (isJson()) {
      output(findings);
    } else {
      if (!findings.length) {
        log("No findings.");
        return;
      }
      for (const finding of findings) {
        log(
          `[${finding.severity}] ${finding.code}: ${finding.message}${finding.pagePath ? ` (${finding.pagePath})` : ""}`
        );
      }
    }
  });

const graph = program.command("graph").description("Graph-related commands.");
graph
  .command("serve")
  .description("Serve the local graph viewer.")
  .option("--port <port>", "Port override")
  .action(async (options: { port?: string }) => {
    const port = options.port ? Number.parseInt(options.port, 10) : undefined;
    const server = await startGraphServer(process.cwd(), port);
    if (isJson()) {
      output({ port: server.port, url: `http://localhost:${server.port}` });
    } else {
      log(`Graph viewer running at http://localhost:${server.port}`);
    }
    process.on("SIGINT", async () => {
      await server.close();
      process.exit(0);
    });
  });

program
  .command("watch")
  .description("Watch the inbox directory and run import/compile cycles on changes.")
  .option("--lint", "Run lint after each compile cycle", false)
  .option("--debounce <ms>", "Debounce window in milliseconds", "900")
  .action(async (options: { lint?: boolean; debounce?: string }) => {
    const debounceMs = Number.parseInt(options.debounce ?? "900", 10);
    const controller = await watchVault(process.cwd(), {
      lint: options.lint ?? false,
      debounceMs: Number.isFinite(debounceMs) ? debounceMs : 900
    });
    if (isJson()) {
      output({ status: "watching", inboxDir: "inbox" });
    } else {
      log("Watching inbox for changes. Press Ctrl+C to stop.");
    }
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

program
  .command("mcp")
  .description("Run SwarmVault as a local MCP server over stdio.")
  .action(async () => {
    if (isJson()) {
      process.stderr.write(JSON.stringify({ status: "running", transport: "stdio" }) + "\n");
    }
    const controller = await startMcpServer(process.cwd());
    process.on("SIGINT", async () => {
      await controller.close();
      process.exit(0);
    });
  });

program
  .command("install")
  .description("Install SwarmVault instructions for an agent in the current project.")
  .requiredOption("--agent <agent>", "codex, claude, or cursor")
  .action(async (options: { agent: "codex" | "claude" | "cursor" }) => {
    const target = await installAgent(process.cwd(), options.agent);
    if (isJson()) {
      output({ agent: options.agent, target });
    } else {
      log(`Installed rules into ${target}`);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (isJson()) {
    output({ error: message });
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
});
```

- [ ] **Step 2: Run CLI tests**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/cli test
```

Expected: Tests pass. If the test runner approach (tsx) doesn't work, adjust the test helper to build first:

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/cli build
```

Then update the test to use `node dist/index.js` instead of `tsx src/index.ts`.

- [ ] **Step 3: Run full test suite**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm check && pnpm test
```

Expected: Everything passes.

- [ ] **Step 4: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/cli/src/index.ts && git commit -m "feat: add --json flag for structured output on all CLI commands"
```

---

## Slice 4: Cleanup

### Task 16: Add watch mode error recovery

**Files:**
- Modify: `packages/engine/src/watch.ts`

- [ ] **Step 1: Replace the watch module**

Replace `packages/engine/src/watch.ts` with:

```typescript
import path from "node:path";
import chokidar from "chokidar";
import { initWorkspace } from "./config.js";
import { importInbox } from "./ingest.js";
import { appendWatchRun } from "./logs.js";
import type { WatchController, WatchOptions } from "./types.js";
import { compileVault, lintVault } from "./vault.js";

const MAX_BACKOFF_MS = 30_000;
const BACKOFF_THRESHOLD = 3;
const CRITICAL_THRESHOLD = 10;

export async function watchVault(rootDir: string, options: WatchOptions = {}): Promise<WatchController> {
  const { paths } = await initWorkspace(rootDir);
  const baseDebounceMs = options.debounceMs ?? 900;

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let pending = false;
  let closed = false;
  let consecutiveFailures = 0;
  let currentDebounceMs = baseDebounceMs;
  const reasons = new Set<string>();

  const watcher = chokidar.watch(paths.inboxDir, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: Math.max(250, Math.floor(baseDebounceMs / 2)),
      pollInterval: 100
    }
  });

  const schedule = (reason: string) => {
    if (closed) {
      return;
    }

    reasons.add(reason);
    pending = true;
    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      void runCycle();
    }, currentDebounceMs);
  };

  const runCycle = async () => {
    if (running || closed || !pending) {
      return;
    }

    pending = false;
    running = true;
    const startedAt = new Date();
    const runReasons = [...reasons];
    reasons.clear();

    let importedCount = 0;
    let scannedCount = 0;
    let attachmentCount = 0;
    let changedPages: string[] = [];
    let lintFindingCount: number | undefined;
    let success = true;
    let error: string | undefined;

    try {
      const imported = await importInbox(rootDir, paths.inboxDir);
      importedCount = imported.imported.length;
      scannedCount = imported.scannedCount;
      attachmentCount = imported.attachmentCount;

      const compile = await compileVault(rootDir);
      changedPages = compile.changedPages;

      if (options.lint) {
        const findings = await lintVault(rootDir);
        lintFindingCount = findings.length;
      }

      consecutiveFailures = 0;
      currentDebounceMs = baseDebounceMs;
    } catch (caught) {
      success = false;
      error = caught instanceof Error ? caught.message : String(caught);
      consecutiveFailures++;

      if (consecutiveFailures >= CRITICAL_THRESHOLD) {
        process.stderr.write(
          `[swarmvault watch] ${consecutiveFailures} consecutive failures. Check vault state. Continuing at max backoff.\n`
        );
      }

      if (consecutiveFailures >= BACKOFF_THRESHOLD) {
        const multiplier = Math.pow(2, consecutiveFailures - BACKOFF_THRESHOLD);
        currentDebounceMs = Math.min(baseDebounceMs * multiplier, MAX_BACKOFF_MS);
      }
    } finally {
      const finishedAt = new Date();
      await appendWatchRun(rootDir, {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        inputDir: paths.inboxDir,
        reasons: runReasons,
        importedCount,
        scannedCount,
        attachmentCount,
        changedPages,
        lintFindingCount,
        success,
        error
      });

      running = false;
      if (pending && !closed) {
        schedule("queued");
      }
    }
  };

  watcher
    .on("add", (filePath) => schedule(`add:${toWatchReason(paths.inboxDir, filePath)}`))
    .on("change", (filePath) => schedule(`change:${toWatchReason(paths.inboxDir, filePath)}`))
    .on("unlink", (filePath) => schedule(`unlink:${toWatchReason(paths.inboxDir, filePath)}`))
    .on("addDir", (dirPath) => schedule(`addDir:${toWatchReason(paths.inboxDir, dirPath)}`))
    .on("unlinkDir", (dirPath) => schedule(`unlinkDir:${toWatchReason(paths.inboxDir, dirPath)}`))
    .on("error", (caught) => schedule(`error:${caught instanceof Error ? caught.message : String(caught)}`));

  return {
    close: async () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
      await watcher.close();
    }
  };
}

function toWatchReason(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath) || ".";
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm --filter @swarmvaultai/engine test
```

Expected: Existing watch test still passes (the error recovery only changes behavior on failure).

- [ ] **Step 3: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add packages/engine/src/watch.ts && git commit -m "feat: add exponential backoff on consecutive watch failures"
```

---

### Task 17: Remove empty apps/site/ directory

**Files:**
- Delete: `/Users/wayde/Dev/new-ai-project/apps/`

- [ ] **Step 1: Remove the directory**

```bash
rm -rf /Users/wayde/Dev/new-ai-project/apps
```

- [ ] **Step 2: Verify**

```bash
ls /Users/wayde/Dev/new-ai-project/
```

Expected: `apps/` is gone. Only `.env.local`, `.gitignore`, `opensource/`, `spec.md`, `web/` remain.

---

### Task 18: Update CONTRIBUTING.md with docs drift note

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add Documentation Site section**

Append the following to `CONTRIBUTING.md` (before the final newline):

```markdown

## Documentation Site

The documentation website lives in a **separate repository**: `swarmclawai/swarmvault-site`.

When you change CLI commands, add new features, or modify behavior:

- Update the corresponding MDX file in `web/src/content/docs/`
- If you add a new command or page, also update the navigation in `web/src/lib/docs-nav.ts`
- The docs site uses Next.js 16 with static export — run `npm run build` in `web/` to verify

This sync is currently manual. Documentation PRs should be opened against the `swarmvault-site` repository.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && git add CONTRIBUTING.md && git commit -m "docs: add documentation site section to CONTRIBUTING.md"
```

---

## Final Verification

### Task 19: Full verification pass

- [ ] **Step 1: Run complete check**

```bash
cd /Users/wayde/Dev/new-ai-project/opensource && pnpm check && pnpm test
```

Expected: Biome lint passes, typecheck passes for all packages, all tests pass.

- [ ] **Step 2: Verify incremental compilation manually**

```bash
cd /tmp && mkdir sv-test && cd sv-test
node /Users/wayde/Dev/new-ai-project/opensource/packages/cli/dist/index.js init
echo "# Test\n\nKnowledge graph content." > note.md
node /Users/wayde/Dev/new-ai-project/opensource/packages/cli/dist/index.js ingest note.md
node /Users/wayde/Dev/new-ai-project/opensource/packages/cli/dist/index.js compile
node /Users/wayde/Dev/new-ai-project/opensource/packages/cli/dist/index.js compile
```

Expected: Second compile outputs "Changed: 0."

- [ ] **Step 3: Verify --json output**

```bash
node /Users/wayde/Dev/new-ai-project/opensource/packages/cli/dist/index.js compile --json | python3 -m json.tool
```

Expected: Pretty-printed JSON with `pageCount`, `sourceCount`, `changedPages`, `graphPath`.

- [ ] **Step 4: Clean up**

```bash
rm -rf /tmp/sv-test
```
