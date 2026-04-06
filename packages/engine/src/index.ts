export { defaultVaultConfig, defaultVaultSchema, initWorkspace, loadVaultConfig, resolvePaths } from "./config.js";
export { ingestInput, importInbox, listManifests, readExtractedText } from "./ingest.js";
export {
  compileVault,
  initVault,
  lintVault,
  queryVault,
  bootstrapDemo,
  getWorkspaceInfo,
  listPages,
  readPage,
  searchVault
} from "./vault.js";
export { installAgent, installConfiguredAgents } from "./agents.js";
export { loadVaultSchema } from "./schema.js";
export { startGraphServer } from "./viewer.js";
export { createMcpServer, startMcpServer } from "./mcp.js";
export { watchVault } from "./watch.js";
export { createProvider, getProviderForTask, assertProviderCapability } from "./providers/registry.js";
export type * from "./types.js";
