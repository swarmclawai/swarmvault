import matter from "gray-matter";
import { describe, expect, it } from "vitest";
import { buildAggregatePage, type ManagedGraphPageMetadata } from "../src/markdown.js";
import type { SourceAnalysis } from "../src/types.js";

/**
 * Tests for Cycle B.6 tag inheritance: derived concept / entity pages
 * should inherit the union of tags emitted on their contributing source
 * pages, keep their own kind tag, and produce deterministic output.
 */

function makeAnalysis(overrides: Partial<SourceAnalysis> & { sourceId: string; tags: string[] }): SourceAnalysis {
  const now = "2026-04-16T00:00:00.000Z";
  return {
    analysisVersion: 1,
    sourceHash: overrides.sourceId,
    semanticHash: overrides.sourceId,
    extractionHash: overrides.sourceId,
    schemaHash: overrides.sourceId,
    title: `Source ${overrides.sourceId}`,
    summary: `Summary for ${overrides.sourceId}`,
    concepts: [],
    entities: [],
    claims: [],
    questions: [],
    rationales: [],
    producedAt: now,
    ...overrides
  };
}

function metadata(overrides: Partial<ManagedGraphPageMetadata> = {}): ManagedGraphPageMetadata {
  const now = "2026-04-16T00:00:00.000Z";
  return {
    status: "active",
    createdAt: now,
    updatedAt: now,
    compiledFrom: [],
    managedBy: "system",
    confidence: 1,
    ...overrides
  };
}

function tagsOf(content: string): string[] {
  const raw = matter(content).data.tags;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string");
}

describe("tag inheritance — derived concept/entity pages", () => {
  it("inherits the union of tags from contributing source analyses", () => {
    const analyses = [
      makeAnalysis({ sourceId: "alpha", tags: ["graphs", "research"] }),
      makeAnalysis({ sourceId: "beta", tags: ["agents", "graphs"] })
    ];
    const { content } = buildAggregatePage(
      "concept",
      "concept:knowledge-graphs",
      "Knowledge Graphs",
      ["Shared concept about graphs."],
      analyses,
      { alpha: "alpha", beta: "beta" },
      { alpha: "alpha", beta: "beta" },
      "schema-hash",
      metadata(),
      "concepts/knowledge-graphs.md"
    );

    const tags = tagsOf(content);
    expect(tags).toContain("agents");
    expect(tags).toContain("graphs");
    expect(tags).toContain("research");
  });

  it("keeps the derived page's own kind tag pinned at the front", () => {
    const analyses = [makeAnalysis({ sourceId: "alpha", tags: ["research"] }), makeAnalysis({ sourceId: "beta", tags: ["agents"] })];
    const { content } = buildAggregatePage(
      "entity",
      "entity:swarmvault",
      "SwarmVault",
      ["An entity about SwarmVault."],
      analyses,
      { alpha: "alpha", beta: "beta" },
      { alpha: "alpha", beta: "beta" },
      "schema-hash",
      metadata(),
      "entities/swarmvault.md"
    );

    const tags = tagsOf(content);
    expect(tags[0]).toBe("entity");
    expect(tags).toContain("research");
    expect(tags).toContain("agents");
  });

  it("dedupes tags that repeat across sources and decorations", () => {
    const analyses = [
      makeAnalysis({ sourceId: "alpha", tags: ["graphs", "research"] }),
      makeAnalysis({ sourceId: "beta", tags: ["graphs", "graphs", "agents"] })
    ];
    const { content } = buildAggregatePage(
      "concept",
      "concept:graphs-topic",
      "Graphs Topic",
      ["Concept about graphs."],
      analyses,
      { alpha: "alpha", beta: "beta" },
      { alpha: "alpha", beta: "beta" },
      "schema-hash",
      metadata(),
      "concepts/graphs-topic.md",
      [],
      { extraTags: ["graphs", "research"] }
    );

    const tags = tagsOf(content);
    const occurrences = tags.filter((tag) => tag === "graphs").length;
    expect(occurrences).toBe(1);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("sorts inherited tags deterministically after the leader tag(s)", () => {
    const analyses = [
      makeAnalysis({ sourceId: "alpha", tags: ["zeta", "alpha"] }),
      makeAnalysis({ sourceId: "beta", tags: ["mike", "bravo"] })
    ];
    const { content } = buildAggregatePage(
      "concept",
      "concept:ordered",
      "Ordered",
      ["Stable ordering."],
      analyses,
      { alpha: "alpha", beta: "beta" },
      { alpha: "alpha", beta: "beta" },
      "schema-hash",
      metadata(),
      "concepts/ordered.md"
    );

    const tags = tagsOf(content);
    // Leader first, everything else alphabetical.
    expect(tags[0]).toBe("concept");
    const rest = tags.slice(1);
    const sorted = [...rest].sort((left, right) => left.localeCompare(right));
    expect(rest).toEqual(sorted);
  });

  it("pins both kind and candidate leaders when the page is still a candidate", () => {
    const analyses = [makeAnalysis({ sourceId: "alpha", tags: ["zeta"] })];
    const { content } = buildAggregatePage(
      "concept",
      "concept:draft-concept",
      "Draft Concept",
      ["Still a candidate."],
      analyses,
      { alpha: "alpha" },
      { alpha: "alpha" },
      "schema-hash",
      metadata({ status: "candidate" }),
      "candidates/concepts/draft-concept.md"
    );

    const tags = tagsOf(content);
    expect(tags.slice(0, 2)).toEqual(["concept", "candidate"]);
    expect(tags).toContain("zeta");
  });

  it("only emits the kind tag when no source has any tags", () => {
    const analyses = [makeAnalysis({ sourceId: "alpha", tags: [] }), makeAnalysis({ sourceId: "beta", tags: [] })];
    const { content } = buildAggregatePage(
      "concept",
      "concept:bare-concept",
      "Bare Concept",
      ["No source tags to inherit."],
      analyses,
      { alpha: "alpha", beta: "beta" },
      { alpha: "alpha", beta: "beta" },
      "schema-hash",
      metadata(),
      "concepts/bare-concept.md"
    );

    expect(tagsOf(content)).toEqual(["concept"]);
  });

  it("uses the canonical page id and dedupes repeated source analyses", () => {
    const alpha = makeAnalysis({ sourceId: "alpha", tags: ["research"] });
    const result = buildAggregatePage(
      "concept",
      "concept:u-canonical",
      "毫毛分身术",
      ["A Chinese concept."],
      [alpha, alpha],
      { alpha: "alpha" },
      { alpha: "alpha" },
      "schema-hash",
      metadata(),
      "concepts/u-canonical.md"
    );

    const parsed = matter(result.content);
    expect(result.page.id).toBe("concept:u-canonical");
    expect(result.page.sourceIds).toEqual(["alpha"]);
    expect(result.page.backlinks).toEqual(["source:alpha"]);
    expect(parsed.data.page_id).toBe("concept:u-canonical");
    expect(parsed.data.source_ids).toEqual(["alpha"]);
    expect(parsed.data.backlinks).toEqual(["source:alpha"]);
    expect(result.content.match(/\[\[sources\/alpha\|/g)).toHaveLength(1);
  });
});
