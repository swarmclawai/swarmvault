import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { loadVaultConfig } from "./config.js";
import { listManifests } from "./ingest.js";
import { getProviderForTask } from "./providers/registry.js";
import { loadVaultSchema } from "./schema.js";
import type { GraphArtifact, LintFinding } from "./types.js";
import { normalizeWhitespace, readJsonFile, truncate, uniqueBy } from "./utils.js";
import { getWebSearchAdapterForTask } from "./web-search/registry.js";

const deepLintResponseSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(["error", "warning", "info"]).default("info"),
        code: z.enum(["coverage_gap", "contradiction_candidate", "missing_citation", "candidate_page", "follow_up_question"]),
        message: z.string().min(1),
        relatedSourceIds: z.array(z.string()).default([]),
        relatedPageIds: z.array(z.string()).default([]),
        suggestedQuery: z.string().optional()
      })
    )
    .max(20)
});

type DeepLintContextPage = {
  id: string;
  title: string;
  path: string;
  kind: "source" | "module" | "concept" | "entity";
  sourceIds: string[];
  excerpt: string;
};

function graphContextSummary(graph: GraphArtifact) {
  const communities = (graph.communities ?? []).map((community) => ({
    ...community,
    size: community.nodeIds.length
  }));
  const godNodes = graph.nodes
    .filter((node) => node.isGodNode)
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0))
    .slice(0, 5)
    .map((node) => ({
      id: node.id,
      label: node.label,
      degree: node.degree ?? 0,
      bridgeScore: node.bridgeScore ?? 0,
      communityId: node.communityId
    }));

  return {
    communities,
    godNodes
  };
}

async function loadContextPages(rootDir: string, graph: GraphArtifact): Promise<DeepLintContextPage[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const contextPages = graph.pages.filter(
    (page): page is typeof page & { kind: "source" | "module" | "concept" | "entity" } =>
      page.kind === "source" || page.kind === "module" || page.kind === "concept" || page.kind === "entity"
  );

  return Promise.all(
    contextPages.slice(0, 18).map(async (page) => {
      const absolutePath = path.join(paths.wikiDir, page.path);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
      const parsed = matter(raw);
      return {
        id: page.id,
        title: page.title,
        path: page.path,
        kind: page.kind,
        sourceIds: page.sourceIds,
        excerpt: truncate(normalizeWhitespace(parsed.content), 1400)
      };
    })
  );
}

function heuristicDeepFindings(
  contextPages: DeepLintContextPage[],
  structuralFindings: LintFinding[],
  graph: GraphArtifact
): LintFinding[] {
  const findings: LintFinding[] = [];
  const graphSummary = graphContextSummary(graph);

  for (const page of contextPages) {
    if (page.excerpt.includes("No claims extracted.")) {
      findings.push({
        severity: "warning",
        code: "coverage_gap",
        message: `Page ${page.title} has no extracted claims yet.`,
        pagePath: page.path,
        relatedSourceIds: page.sourceIds,
        relatedPageIds: [page.id],
        suggestedQuery: `What evidence or claims should ${page.title} contain?`
      });
    }
  }

  for (const page of contextPages.filter((item) => item.kind === "module").slice(0, 4)) {
    if (page.excerpt.includes("No top-level symbols detected.") || page.excerpt.includes("No imports detected.")) {
      findings.push({
        severity: "info",
        code: "coverage_gap",
        message: `Module page ${page.title} looks structurally thin and may need broader code ingestion coverage.`,
        pagePath: page.path,
        relatedSourceIds: page.sourceIds,
        relatedPageIds: [page.id],
        suggestedQuery: `What code context is missing around ${page.title}?`
      });
    }
  }

  for (const finding of structuralFindings.filter((item) => item.code === "uncited_claims").slice(0, 5)) {
    findings.push({
      severity: "warning",
      code: "missing_citation",
      message: finding.message,
      pagePath: finding.pagePath,
      suggestedQuery: finding.pagePath ? `Which sources support the claims in ${path.basename(finding.pagePath, ".md")}?` : undefined
    });
  }

  for (const page of contextPages.filter((item) => item.kind === "source").slice(0, 3)) {
    findings.push({
      severity: "info",
      code: "follow_up_question",
      message: `Investigate what broader implications ${page.title} has for the rest of the vault.`,
      pagePath: page.path,
      relatedSourceIds: page.sourceIds,
      relatedPageIds: [page.id],
      suggestedQuery: `What broader implications does ${page.title} have?`
    });
  }

  for (const community of graphSummary.communities.filter((item) => item.size <= 2).slice(0, 3)) {
    findings.push({
      severity: "info",
      code: "coverage_gap",
      message: `Community ${community.label} is weakly covered with only ${community.size} node(s).`,
      suggestedQuery: `What sources would strengthen coverage for ${community.label}?`
    });
  }

  for (const node of graphSummary.godNodes.filter((item) => item.bridgeScore > 1).slice(0, 3)) {
    findings.push({
      severity: "info",
      code: "follow_up_question",
      message: `${node.label} connects multiple parts of the vault and deserves a closer audit.`,
      suggestedQuery: `Why does ${node.label} connect multiple topics in this vault?`
    });
  }

  return uniqueBy(findings, (item) => `${item.code}:${item.message}`);
}

export async function runDeepLint(
  rootDir: string,
  structuralFindings: LintFinding[],
  options: { web?: boolean } = {}
): Promise<LintFinding[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    return [];
  }

  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "lintProvider");
  const manifests = await listManifests(rootDir);
  const contextPages = await loadContextPages(rootDir, graph);

  let findings: LintFinding[];
  if (provider.type === "heuristic") {
    findings = heuristicDeepFindings(contextPages, structuralFindings, graph);
  } else {
    const graphSummary = graphContextSummary(graph);
    const response = await provider.generateStructured(
      {
        system:
          "You are an auditor for a local-first LLM knowledge vault. Return advisory findings only. Do not propose direct file edits.",
        prompt: [
          "Review this SwarmVault state and return high-signal advisory findings.",
          "",
          "Schema:",
          schema.content,
          "",
          "Vault summary:",
          `- sources: ${manifests.length}`,
          `- pages: ${graph.pages.length}`,
          `- structural_findings: ${structuralFindings.length}`,
          `- communities: ${graphSummary.communities.length}`,
          `- god_nodes: ${graphSummary.godNodes.length}`,
          "",
          "Structural findings:",
          structuralFindings.map((item) => `- [${item.severity}] ${item.code}: ${item.message}`).join("\n") || "- none",
          "",
          "Graph metrics:",
          graphSummary.communities.length
            ? graphSummary.communities.map((community) => `- ${community.label}: ${community.size} node(s)`).join("\n")
            : "- no derived communities",
          graphSummary.godNodes.length
            ? [
                "",
                "God nodes:",
                ...graphSummary.godNodes.map((node) => `- ${node.label} (degree=${node.degree}, bridge=${node.bridgeScore})`)
              ].join("\n")
            : "",
          "",
          "Page context:",
          contextPages
            .map((page) =>
              [
                `## ${page.title}`,
                `page_id: ${page.id}`,
                `path: ${page.path}`,
                `kind: ${page.kind}`,
                `source_ids: ${page.sourceIds.join(",") || "none"}`,
                page.excerpt
              ].join("\n")
            )
            .join("\n\n---\n\n")
        ].join("\n")
      },
      deepLintResponseSchema
    );

    findings = response.findings.map((item) => ({
      severity: item.severity,
      code: item.code,
      message: item.message,
      relatedSourceIds: item.relatedSourceIds,
      relatedPageIds: item.relatedPageIds,
      suggestedQuery: item.suggestedQuery
    }));
  }

  if (!options.web) {
    return findings;
  }

  const webSearch = await getWebSearchAdapterForTask(rootDir, "deepLintProvider");
  const queryCache = new Map<string, Awaited<ReturnType<typeof webSearch.search>>>();

  for (const finding of findings) {
    const query = finding.suggestedQuery ?? finding.message;
    if (!queryCache.has(query)) {
      queryCache.set(query, await webSearch.search(query, 3));
    }
    finding.evidence = queryCache.get(query);
  }

  return findings;
}
