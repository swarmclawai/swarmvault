/// <reference path="./shims.d.ts" />

export { installAgent, installConfiguredAgents } from "./agents.js";
export { defaultVaultConfig, defaultVaultSchema, initWorkspace, loadVaultConfig, resolvePaths } from "./config.js";
export { exportGraphFormat, exportObsidianCanvas, exportObsidianVault } from "./graph-export.js";
export { pushGraphNeo4j } from "./graph-push.js";
export { graphDiff } from "./graph-tools.js";
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
export { createMcpServer, startMcpServer } from "./mcp.js";
export { assertProviderCapability, createProvider, getProviderForTask } from "./providers/registry.js";
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
export type * from "./types.js";
export {
  acceptApproval,
  archiveCandidate,
  benchmarkVault,
  bootstrapDemo,
  compileVault,
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
  promoteCandidate,
  queryGraphVault,
  queryVault,
  readApproval,
  readGraphReport,
  readPage,
  rejectApproval,
  searchVault,
  stageGeneratedOutputPages
} from "./vault.js";
export { exportGraphHtml, startGraphServer } from "./viewer.js";
export { getWatchStatus, runWatchCycle, watchVault } from "./watch.js";
export { createWebSearchAdapter, getWebSearchAdapterForTask } from "./web-search/registry.js";
