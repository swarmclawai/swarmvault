/// <reference path="./shims.d.ts" />

export { installAgent, installConfiguredAgents } from "./agents.js";
export { autoCommitWikiChanges } from "./auto-commit.js";
export { DEFAULT_PROMOTION_CONFIG, evaluateCandidateForPromotion } from "./candidate-promotion.js";
export { defaultVaultConfig, defaultVaultSchema, initWorkspace, loadVaultConfig, resolvePaths } from "./config.js";
export { DEFAULT_CONSOLIDATION_CONFIG, resolveConsolidationConfig, runConsolidation } from "./consolidate.js";
export {
  applyDecayToPages,
  computeDecayScore,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_HALF_LIFE_DAYS_BY_SOURCE_CLASS,
  DEFAULT_STALE_THRESHOLD,
  markSuperseded,
  persistDecayFrontmatter,
  resetDecay,
  resolveDecayConfig,
  runDecayPass
} from "./freshness.js";
export type { SynthesizedHubEdge, SynthesizedHubNode, SynthesizedHyperedgeHubs } from "./graph-export.js";
export {
  exportGraphFormat,
  exportGraphReportHtml,
  exportObsidianCanvas,
  exportObsidianVault,
  synthesizeHyperedgeHubs
} from "./graph-export.js";
export { pushGraphNeo4j } from "./graph-push.js";
export { blastRadius, graphDiff } from "./graph-tools.js";
export { getGitHookStatus, installGitHooks, uninstallGitHooks } from "./hooks.js";
export {
  addInput,
  importInbox,
  ingestDirectory,
  ingestInput,
  ingestInputDetailed,
  listManifests,
  listTrackedRepoRoots,
  readExtractedText,
  syncTrackedRepos,
  syncTrackedReposForWatch
} from "./ingest.js";
export type { ResolvedLargeRepoDefaults } from "./large-repo-defaults.js";
export { LARGE_REPO_NODE_THRESHOLD, resolveLargeRepoDefaults } from "./large-repo-defaults.js";
export { createMcpServer, startMcpServer } from "./mcp.js";
export type { MigrationPlan, MigrationResult, MigrationStep, VaultVersionRecord } from "./migrate.js";
export { ALL_MIGRATIONS, detectVaultVersion, planMigration, runMigration } from "./migrate.js";
export { assertProviderCapability, createProvider, getProviderForTask } from "./providers/registry.js";
export { buildConfiguredRedactor, buildRedactor, DEFAULT_REDACTION_PATTERNS, resolveRedactionPatterns } from "./redaction.js";
export { listSchedules, runSchedule, serveSchedules } from "./schedule.js";
export { loadVaultSchema, loadVaultSchemas } from "./schema.js";
export {
  addManagedSource,
  deleteManagedSource,
  guideManagedSource,
  guideSourceScope,
  listManagedSourceRecords,
  reloadManagedSources,
  resumeSourceSession,
  reviewManagedSource,
  reviewSourceScope
} from "./sources.js";
export { estimatePageTokens, estimateTokens, trimToTokenBudget } from "./token-estimation.js";
export type * from "./types.js";
export {
  acceptApproval,
  archiveCandidate,
  benchmarkVault,
  blastRadiusVault,
  bootstrapDemo,
  compileVault,
  consolidateVault,
  createSupersessionEdge,
  explainGraphVault,
  exploreVault,
  getWorkspaceInfo,
  initVault,
  lintVault,
  listApprovals,
  listCandidates,
  listGodNodes,
  listGraphHyperedges,
  listPages,
  pathGraphVault,
  previewCandidatePromotions,
  promoteCandidate,
  queryGraphVault,
  queryVault,
  readApproval,
  readGraphReport,
  readPage,
  rejectApproval,
  runAutoPromotion,
  searchVault,
  stageGeneratedOutputPages
} from "./vault.js";
export { exportGraphHtml, startGraphServer } from "./viewer.js";
export {
  addWatchedRoot,
  getWatchStatus,
  listWatchedRoots,
  removeWatchedRoot,
  resolveWatchedRepoRoots,
  runWatchCycle,
  watchVault
} from "./watch.js";
export { createWebSearchAdapter, getWebSearchAdapterForTask } from "./web-search/registry.js";
