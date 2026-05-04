/// <reference path="./shims.d.ts" />

export { installAgent, installConfiguredAgents } from "./agents.js";
export { autoCommitWikiChanges } from "./auto-commit.js";
export { DEFAULT_PROMOTION_CONFIG, evaluateCandidateForPromotion } from "./candidate-promotion.js";
export {
  defaultVaultConfig,
  defaultVaultSchema,
  initWorkspace,
  loadVaultConfig,
  resolveArtifactRootDir,
  resolvePaths,
  SWARMVAULT_OUT_ENV
} from "./config.js";
export { DEFAULT_CONSOLIDATION_CONFIG, resolveConsolidationConfig, runConsolidation } from "./consolidate.js";
export {
  buildContextPack,
  deleteContextPack,
  listContextPacks,
  readContextPack,
  renderContextPackLlms,
  renderContextPackMarkdown
} from "./context-packs.js";
export { doctorVault } from "./doctor.js";
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
export { mergeGraphFiles } from "./graph-merge.js";
export { pushGraphNeo4j } from "./graph-push.js";
export {
  buildGraphShareArtifact,
  renderGraphShareBundleFiles,
  renderGraphShareMarkdown,
  renderGraphSharePreviewHtml,
  renderGraphShareSvg
} from "./graph-share.js";
export { getGraphStatus } from "./graph-status.js";
export { blastRadius, graphDiff } from "./graph-tools.js";
export { buildGraphTree, exportGraphTree, renderGraphTreeHtml } from "./graph-tree.js";
export { getGitHookStatus, installGitHooks, uninstallGitHooks } from "./hooks.js";
export {
  addInput,
  checkTrackedRepoChanges,
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
export {
  buildMemoryGraphElements,
  ensureMemoryLedger,
  finishMemoryTask,
  listMemoryTasks,
  loadMemoryTaskPages,
  memoryTaskHashes,
  readMemoryTask,
  renderMemoryTaskMarkdown,
  resumeMemoryTask,
  startMemoryTask,
  updateMemoryTask
} from "./memory.js";
export type { MigrationPlan, MigrationResult, MigrationStep, VaultVersionRecord } from "./migrate.js";
export { ALL_MIGRATIONS, detectVaultVersion, planMigration, runMigration } from "./migrate.js";
export type { LocalWhisperAdapterOptions, WhisperRunner, WhisperRunResult } from "./providers/local-whisper.js";
export { LocalWhisperProviderAdapter } from "./providers/local-whisper.js";
export type {
  LocalWhisperBinaryDiscovery,
  LocalWhisperSetupStatus,
  ProviderRegistrationOptions,
  ProviderRegistrationResult
} from "./providers/local-whisper-setup.js";
export {
  discoverLocalWhisperBinary,
  downloadWhisperModel,
  expectedModelPath,
  LOCAL_WHISPER_MODEL_SIZES,
  modelDownloadUrl,
  registerLocalWhisperProvider,
  summarizeLocalWhisperSetup
} from "./providers/local-whisper-setup.js";
export type { DegradationOutcome, OpenAiCompatiblePresetId, ProviderPresetCapability } from "./providers/openai-compatible-capabilities.js";
export {
  lookupPresetCapabilities,
  OPENAI_COMPATIBLE_CAPABILITY_MATRIX,
  withCapabilityFallback
} from "./providers/openai-compatible-capabilities.js";
export { assertProviderCapability, createProvider, getProviderForTask } from "./providers/registry.js";
export { buildConfiguredRedactor, buildRedactor, DEFAULT_REDACTION_PATTERNS, resolveRedactionPatterns } from "./redaction.js";
export {
  doctorRetrieval,
  getRetrievalStatus,
  rebuildRetrievalIndex,
  resolveRetrievalConfig,
  writeRetrievalManifest
} from "./retrieval.js";
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
  getGraphCommunityVault,
  getWorkspaceInfo,
  graphStatsVault,
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
  refreshGraphClusters,
  rejectApproval,
  runAutoPromotion,
  searchVault,
  stageGeneratedOutputPages
} from "./vault.js";
export { exportGraphHtml, startGraphServer } from "./viewer.js";
export {
  addWatchedRoot,
  evaluateGraphShrinkGuard,
  getWatchStatus,
  listWatchedRoots,
  removeWatchedRoot,
  resolveWatchedRepoRoots,
  runWatchCycle,
  watchVault
} from "./watch.js";
export { createWebSearchAdapter, getWebSearchAdapterForTask } from "./web-search/registry.js";
