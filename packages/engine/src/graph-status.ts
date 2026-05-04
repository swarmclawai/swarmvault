import path from "node:path";
import { loadVaultConfig } from "./config.js";
import { checkTrackedRepoChanges, listTrackedRepoRoots } from "./ingest.js";
import type { GraphStatusResult, PendingSemanticRefreshEntry } from "./types.js";
import { fileExists, readJsonFile } from "./utils.js";

function recommendedCommand(input: {
  graphExists: boolean;
  reportExists: boolean;
  codeChangeCount: number;
  semanticChangeCount: number;
  pendingSemanticRefreshCount: number;
}): string | null {
  if (!input.graphExists || !input.reportExists) {
    return "swarmvault compile";
  }
  if (input.semanticChangeCount > 0 || input.pendingSemanticRefreshCount > 0) {
    return "swarmvault compile";
  }
  if (input.codeChangeCount > 0) {
    return "swarmvault graph update";
  }
  return null;
}

export async function getGraphStatus(rootDir: string, options: { repoRoots?: string[] } = {}): Promise<GraphStatusResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const graphPath = paths.graphPath;
  const reportPath = path.join(paths.wikiDir, "graph", "report.md");
  const resolvedOverrideRoots = options.repoRoots?.map((repoRoot) => path.resolve(rootDir, repoRoot));
  const [graphExists, reportExists, trackedRepoRoots, changes, pendingSemanticRefresh] = await Promise.all([
    fileExists(graphPath),
    fileExists(reportPath),
    resolvedOverrideRoots
      ? Promise.resolve([...new Set(resolvedOverrideRoots)].sort((left, right) => left.localeCompare(right)))
      : listTrackedRepoRoots(rootDir),
    checkTrackedRepoChanges(rootDir, resolvedOverrideRoots),
    readJsonFile<PendingSemanticRefreshEntry[]>(paths.pendingSemanticRefreshPath).then((entries) => (Array.isArray(entries) ? entries : []))
  ]);
  const codeChangeCount = changes.filter((change) => change.refreshType === "code").length;
  const semanticChangeCount = changes.filter((change) => change.refreshType === "semantic").length;
  const command = recommendedCommand({
    graphExists,
    reportExists,
    codeChangeCount,
    semanticChangeCount,
    pendingSemanticRefreshCount: pendingSemanticRefresh.length
  });

  return {
    generatedAt: new Date().toISOString(),
    graphExists,
    graphPath,
    reportExists,
    reportPath,
    trackedRepoRoots,
    codeChangeCount,
    semanticChangeCount,
    pendingSemanticRefresh,
    stale: Boolean(command),
    recommendedCommand: command,
    changes
  };
}
