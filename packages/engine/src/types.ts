import { z } from "zod";

export const providerCapabilitySchema = z.enum([
  "responses",
  "chat",
  "structured",
  "tools",
  "vision",
  "embeddings",
  "streaming",
  "local",
  "image_generation"
]);

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerTypeSchema = z.enum([
  "heuristic",
  "openai",
  "ollama",
  "anthropic",
  "gemini",
  "openai-compatible",
  "openrouter",
  "groq",
  "together",
  "xai",
  "cerebras",
  "custom"
]);

export type ProviderType = z.infer<typeof providerTypeSchema>;
export const agentTypeSchema = z.enum(["codex", "claude", "cursor", "goose", "pi", "gemini", "opencode"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export type PageKind = "index" | "source" | "module" | "concept" | "entity" | "output" | "insight" | "graph_report" | "community_summary";
export type Freshness = "fresh" | "stale";
export type ClaimStatus = "extracted" | "inferred" | "conflicted" | "stale";
export type EvidenceClass = "extracted" | "inferred" | "ambiguous";
export type Polarity = "positive" | "negative" | "neutral";
export type OutputOrigin = "query" | "explore";
export type OutputFormat = "markdown" | "report" | "slides" | "chart" | "image";
export type OutputAssetRole = "primary" | "preview" | "manifest" | "poster";
export type GraphExportFormat = "html" | "svg" | "graphml" | "cypher";
export type PageStatus = "draft" | "candidate" | "active" | "archived";
export type PageManager = "system" | "human";
export type ApprovalEntryStatus = "pending" | "accepted" | "rejected";
export type ApprovalChangeType = "create" | "update" | "delete" | "promote";
export type SourceKind = "markdown" | "text" | "pdf" | "image" | "html" | "binary" | "code";
export type CodeLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "php"
  | "ruby"
  | "powershell";
export type CodeSymbolKind = "function" | "class" | "interface" | "type_alias" | "enum" | "variable" | "struct" | "trait";
export type OrchestrationRole = "research" | "audit" | "context" | "safety";

export const webSearchProviderTypeSchema = z.enum(["http-json", "custom"]);

export type WebSearchProviderType = z.infer<typeof webSearchProviderTypeSchema>;

export interface GenerationAttachment {
  mimeType: string;
  filePath: string;
}

export interface GenerationRequest {
  system?: string;
  prompt: string;
  attachments?: GenerationAttachment[];
  maxOutputTokens?: number;
}

export interface GenerationResponse {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ImageGenerationRequest {
  prompt: string;
  system?: string;
  width?: number;
  height?: number;
  attachments?: GenerationAttachment[];
}

export interface ImageGenerationResponse {
  mimeType: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  revisedPrompt?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  readonly model: string;
  readonly capabilities: Set<ProviderCapability>;
  generateText(request: GenerationRequest): Promise<GenerationResponse>;
  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T>;
  generateImage?(request: ImageGenerationRequest): Promise<ImageGenerationResponse>;
}

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  module?: string;
  capabilities?: ProviderCapability[];
  apiStyle?: "responses" | "chat";
}

export interface WebSearchProviderConfig {
  type: WebSearchProviderType;
  endpoint?: string;
  method?: "GET" | "POST";
  apiKeyEnv?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  headers?: Record<string, string>;
  queryParam?: string;
  limitParam?: string;
  resultsPath?: string;
  titleField?: string;
  urlField?: string;
  snippetField?: string;
  module?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchAdapter {
  readonly id: string;
  readonly type: WebSearchProviderType;
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
}

export interface VaultConfig {
  workspace: {
    rawDir: string;
    wikiDir: string;
    stateDir: string;
    agentDir: string;
    inboxDir: string;
  };
  providers: Record<string, ProviderConfig>;
  tasks: {
    compileProvider: string;
    queryProvider: string;
    lintProvider: string;
    visionProvider: string;
    imageProvider?: string;
  };
  viewer: {
    port: number;
  };
  projects?: Record<
    string,
    {
      roots: string[];
      schemaPath?: string;
    }
  >;
  agents: AgentType[];
  schedules?: Record<string, ScheduleJobConfig>;
  orchestration?: OrchestrationConfig;
  webSearch?: {
    providers: Record<string, WebSearchProviderConfig>;
    tasks: {
      deepLintProvider: string;
    };
  };
}

export interface ResolvedPaths {
  rootDir: string;
  schemaPath: string;
  rawDir: string;
  rawSourcesDir: string;
  rawAssetsDir: string;
  wikiDir: string;
  outputsAssetsDir: string;
  projectsDir: string;
  candidatesDir: string;
  candidateConceptsDir: string;
  candidateEntitiesDir: string;
  stateDir: string;
  schedulesDir: string;
  agentDir: string;
  inboxDir: string;
  manifestsDir: string;
  extractsDir: string;
  analysesDir: string;
  viewerDistDir: string;
  graphPath: string;
  searchDbPath: string;
  compileStatePath: string;
  codeIndexPath: string;
  benchmarkPath: string;
  jobsLogPath: string;
  sessionsDir: string;
  approvalsDir: string;
  watchDir: string;
  watchStatusPath: string;
  pendingSemanticRefreshPath: string;
  configPath: string;
}

export interface SourceAttachment {
  path: string;
  mimeType: string;
  originalPath?: string;
}

export interface IngestOptions {
  includeAssets?: boolean;
  maxAssetSize?: number;
  repoRoot?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  gitignore?: boolean;
}

export interface DirectoryIngestSkip {
  path: string;
  reason: string;
}

export interface DirectoryIngestResult {
  inputDir: string;
  repoRoot: string;
  scannedCount: number;
  imported: SourceManifest[];
  updated: SourceManifest[];
  skipped: DirectoryIngestSkip[];
}

export interface SourceManifest {
  sourceId: string;
  title: string;
  originType: "file" | "url";
  sourceKind: SourceKind;
  language?: CodeLanguage;
  originalPath?: string;
  repoRelativePath?: string;
  url?: string;
  storedPath: string;
  extractedTextPath?: string;
  mimeType: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  attachments?: SourceAttachment[];
}

export interface AnalyzedTerm {
  id: string;
  name: string;
  description: string;
}

export interface SourceClaim {
  id: string;
  text: string;
  confidence: number;
  status: ClaimStatus;
  polarity: Polarity;
  citation: string;
}

export interface CodeImport {
  specifier: string;
  importedSymbols: string[];
  defaultImport?: string;
  namespaceImport?: string;
  isTypeOnly?: boolean;
  isExternal: boolean;
  reExport: boolean;
  resolvedSourceId?: string;
  resolvedRepoPath?: string;
}

export interface CodeDiagnostic {
  code: number;
  category: "warning" | "error" | "message" | "suggestion";
  message: string;
  line: number;
  column: number;
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: CodeSymbolKind;
  signature: string;
  exported: boolean;
  calls: string[];
  extends: string[];
  implements: string[];
}

export interface CodeAnalysis {
  moduleId: string;
  language: CodeLanguage;
  moduleName?: string;
  namespace?: string;
  imports: CodeImport[];
  dependencies: string[];
  symbols: CodeSymbol[];
  exports: string[];
  diagnostics: CodeDiagnostic[];
}

export interface SourceRationale {
  id: string;
  text: string;
  citation: string;
  kind: "docstring" | "comment" | "marker";
  symbolName?: string;
}

export interface CodeIndexEntry {
  sourceId: string;
  moduleId: string;
  language: CodeLanguage;
  repoRelativePath?: string;
  originalPath?: string;
  moduleName?: string;
  namespace?: string;
  aliases: string[];
}

export interface CodeIndexArtifact {
  generatedAt: string;
  entries: CodeIndexEntry[];
}

export interface SourceAnalysis {
  analysisVersion: number;
  sourceId: string;
  sourceHash: string;
  schemaHash: string;
  title: string;
  summary: string;
  concepts: AnalyzedTerm[];
  entities: AnalyzedTerm[];
  claims: SourceClaim[];
  questions: string[];
  rationales: SourceRationale[];
  code?: CodeAnalysis;
  producedAt: string;
}

export interface GraphNode {
  id: string;
  type: "source" | "concept" | "entity" | "module" | "symbol" | "rationale";
  label: string;
  pageId?: string;
  freshness?: Freshness;
  confidence?: number;
  sourceIds: string[];
  projectIds: string[];
  language?: CodeLanguage;
  moduleId?: string;
  symbolKind?: CodeSymbolKind;
  communityId?: string;
  degree?: number;
  bridgeScore?: number;
  isGodNode?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  status: ClaimStatus;
  evidenceClass: EvidenceClass;
  confidence: number;
  provenance: string[];
}

export interface GraphPage {
  id: string;
  path: string;
  title: string;
  kind: PageKind;
  sourceIds: string[];
  projectIds: string[];
  nodeIds: string[];
  freshness: Freshness;
  status: PageStatus;
  confidence: number;
  backlinks: string[];
  schemaHash: string;
  sourceHashes: Record<string, string>;
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
  createdAt: string;
  updatedAt: string;
  compiledFrom: string[];
  managedBy: PageManager;
  origin?: OutputOrigin;
  question?: string;
  outputFormat?: OutputFormat;
  outputAssets?: OutputAsset[];
}

export interface GraphArtifact {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities?: Array<{
    id: string;
    label: string;
    nodeIds: string[];
  }>;
  sources: SourceManifest[];
  pages: GraphPage[];
}

export interface GraphQueryMatch {
  type: "node" | "page";
  id: string;
  label: string;
  score: number;
}

export interface GraphQueryResult {
  question: string;
  traversal: "bfs" | "dfs";
  seedNodeIds: string[];
  seedPageIds: string[];
  visitedNodeIds: string[];
  visitedEdgeIds: string[];
  pageIds: string[];
  communities: string[];
  summary: string;
  matches: GraphQueryMatch[];
}

export interface GraphPathResult {
  from: string;
  to: string;
  resolvedFromNodeId?: string;
  resolvedToNodeId?: string;
  found: boolean;
  nodeIds: string[];
  edgeIds: string[];
  pageIds: string[];
  summary: string;
}

export interface GraphExplainNeighbor {
  nodeId: string;
  label: string;
  type: GraphNode["type"];
  pageId?: string;
  relation: string;
  direction: "incoming" | "outgoing";
  confidence: number;
  evidenceClass: EvidenceClass;
}

export interface GraphExplainResult {
  target: string;
  node: GraphNode;
  page?: GraphPage;
  community?: {
    id: string;
    label: string;
  };
  neighbors: GraphExplainNeighbor[];
  summary: string;
}

export interface ApprovalEntry {
  pageId: string;
  title: string;
  kind: PageKind;
  changeType: ApprovalChangeType;
  status: ApprovalEntryStatus;
  sourceIds: string[];
  nextPath?: string;
  previousPath?: string;
}

export interface ApprovalManifest {
  approvalId: string;
  createdAt: string;
  entries: ApprovalEntry[];
}

export interface ApprovalSummary {
  approvalId: string;
  createdAt: string;
  entryCount: number;
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
}

export interface ApprovalEntryDetail extends ApprovalEntry {
  currentContent?: string;
  stagedContent?: string;
}

export interface ApprovalDetail extends ApprovalSummary {
  entries: ApprovalEntryDetail[];
}

export interface ReviewActionResult extends ApprovalSummary {
  updatedEntries: string[];
}

export interface CandidateRecord {
  pageId: string;
  title: string;
  kind: "concept" | "entity";
  path: string;
  activePath: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CompileOptions {
  approve?: boolean;
}

export interface InitOptions {
  obsidian?: boolean;
}

export interface CompileResult {
  graphPath: string;
  pageCount: number;
  changedPages: string[];
  sourceCount: number;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
  postPassApprovalId?: string;
  postPassApprovalDir?: string;
  promotedPageIds: string[];
  candidatePageCount: number;
}

export interface SearchResult {
  pageId: string;
  path: string;
  title: string;
  snippet: string;
  rank: number;
  kind?: PageKind;
  status?: PageStatus;
  projectIds: string[];
}

export interface QueryOptions {
  question: string;
  save?: boolean;
  format?: OutputFormat;
  review?: boolean;
}

export interface QueryResult {
  answer: string;
  savedPath?: string;
  stagedPath?: string;
  savedPageId?: string;
  citations: string[];
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
  outputFormat: OutputFormat;
  saved: boolean;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
  outputAssets: OutputAsset[];
}

export interface LintFinding {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  pagePath?: string;
  relatedSourceIds?: string[];
  relatedPageIds?: string[];
  suggestedQuery?: string;
  evidence?: WebSearchResult[];
}

export interface InboxImportSkip {
  path: string;
  reason: string;
}

export interface InboxImportResult {
  inputDir: string;
  scannedCount: number;
  attachmentCount: number;
  imported: SourceManifest[];
  skipped: InboxImportSkip[];
}

export interface WatchOptions {
  lint?: boolean;
  debounceMs?: number;
  repo?: boolean;
}

export interface PendingSemanticRefreshEntry {
  id: string;
  repoRoot: string;
  path: string;
  changeType: "added" | "modified" | "removed";
  detectedAt: string;
  sourceId?: string;
  sourceKind?: SourceKind;
}

export interface RepoSyncResult {
  repoRoots: string[];
  scannedCount: number;
  imported: SourceManifest[];
  updated: SourceManifest[];
  removed: SourceManifest[];
  skipped: DirectoryIngestSkip[];
}

export interface WatchRepoSyncResult extends RepoSyncResult {
  pendingSemanticRefresh: PendingSemanticRefreshEntry[];
  staleSourceIds: string[];
}

export interface WatchRunRecord {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputDir: string;
  reasons: string[];
  importedCount: number;
  scannedCount: number;
  attachmentCount: number;
  changedPages: string[];
  repoImportedCount?: number;
  repoUpdatedCount?: number;
  repoRemovedCount?: number;
  repoScannedCount?: number;
  pendingSemanticRefreshCount?: number;
  pendingSemanticRefreshPaths?: string[];
  lintFindingCount?: number;
  success: boolean;
  error?: string;
}

export interface WatchStatusResult {
  generatedAt: string;
  watchedRepoRoots: string[];
  lastRun?: WatchRunRecord;
  pendingSemanticRefresh: PendingSemanticRefreshEntry[];
}

export interface WatchController {
  close(): Promise<void>;
}

export interface InstallAgentOptions {
  claudeHook?: boolean;
}

export interface GitHookStatus {
  repoRoot: string | null;
  postCommit: "installed" | "not_installed" | "other_content";
  postCheckout: "installed" | "not_installed" | "other_content";
}

export interface CompileState {
  generatedAt: string;
  rootSchemaHash: string;
  projectSchemaHashes: Record<string, string>;
  effectiveSchemaHashes: {
    global: string;
    projects: Record<string, string>;
  };
  projectConfigHash: string;
  analyses: Record<string, string>;
  sourceHashes: Record<string, string>;
  sourceProjects: Record<string, string | null>;
  outputHashes: Record<string, string>;
  insightHashes: Record<string, string>;
  candidateHistory: Record<
    string,
    {
      sourceIds: string[];
      status: "candidate" | "active";
    }
  >;
}

export interface LintOptions {
  deep?: boolean;
  web?: boolean;
}

export interface ExploreOptions {
  question: string;
  steps?: number;
  format?: OutputFormat;
  review?: boolean;
}

export interface ExploreStepResult {
  step: number;
  question: string;
  answer: string;
  savedPath?: string;
  stagedPath?: string;
  savedPageId: string;
  citations: string[];
  followUpQuestions: string[];
  outputFormat: OutputFormat;
  outputAssets: OutputAsset[];
}

export interface ExploreResult {
  rootQuestion: string;
  hubPath?: string;
  stagedHubPath?: string;
  hubPageId: string;
  stepCount: number;
  steps: ExploreStepResult[];
  suggestedQuestions: string[];
  outputFormat: OutputFormat;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
  hubAssets: OutputAsset[];
}

export interface OutputAsset {
  id: string;
  role: OutputAssetRole;
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
  dataPath?: string;
}

export interface ChartDatum {
  label: string;
  value: number;
}

export interface ChartSpec {
  kind: "bar" | "line";
  title: string;
  subtitle?: string;
  xLabel?: string;
  yLabel?: string;
  seriesLabel?: string;
  data: ChartDatum[];
  notes?: string[];
}

export interface SceneElement {
  kind: "shape" | "label";
  shape?: "rect" | "circle" | "line";
  x: number;
  y: number;
  width?: number;
  height?: number;
  radius?: number;
  text?: string;
  fontSize?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export interface SceneSpec {
  title: string;
  alt: string;
  background?: string;
  width?: number;
  height?: number;
  elements: SceneElement[];
}

export interface GraphExportResult {
  format: GraphExportFormat;
  outputPath: string;
}

export interface AddOptions extends IngestOptions {
  author?: string;
  contributor?: string;
}

export interface AddResult {
  captureType: "arxiv" | "tweet" | "url";
  manifest: SourceManifest;
  normalizedUrl: string;
  title: string;
  fallback: boolean;
}

export interface BenchmarkQuestionResult {
  question: string;
  queryTokens: number;
  reduction: number;
  visitedNodeIds: string[];
  pageIds: string[];
}

export interface BenchmarkArtifact {
  generatedAt: string;
  corpusWords: number;
  corpusTokens: number;
  nodes: number;
  edges: number;
  avgQueryTokens: number;
  reductionRatio: number;
  sampleQuestions: string[];
  perQuestion: BenchmarkQuestionResult[];
}

export interface BenchmarkOptions {
  questions?: string[];
}

export interface ScheduledCompileTask {
  type: "compile";
  approve?: boolean;
}

export interface ScheduledLintTask {
  type: "lint";
  deep?: boolean;
  web?: boolean;
}

export interface ScheduledQueryTask {
  type: "query";
  question: string;
  format?: OutputFormat;
  save?: boolean;
}

export interface ScheduledExploreTask {
  type: "explore";
  question: string;
  steps?: number;
  format?: OutputFormat;
}

export type ScheduledTaskConfig = ScheduledCompileTask | ScheduledLintTask | ScheduledQueryTask | ScheduledExploreTask;

export interface ScheduleTriggerConfig {
  cron?: string;
  every?: string;
}

export interface ScheduleJobConfig {
  enabled?: boolean;
  when: ScheduleTriggerConfig;
  task: ScheduledTaskConfig;
}

export interface ProviderRoleExecutorConfig {
  type: "provider";
  provider: string;
}

export interface CommandRoleExecutorConfig {
  type: "command";
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type RoleExecutorConfig = ProviderRoleExecutorConfig | CommandRoleExecutorConfig;

export interface OrchestrationRoleConfig {
  executor: RoleExecutorConfig;
}

export interface OrchestrationConfig {
  maxParallelRoles?: number;
  compilePostPass?: boolean;
  roles?: Partial<Record<OrchestrationRole, OrchestrationRoleConfig>>;
}

export interface OrchestrationFinding {
  role: OrchestrationRole;
  severity: "error" | "warning" | "info";
  message: string;
  relatedPageIds?: string[];
  relatedSourceIds?: string[];
  suggestedQuery?: string;
}

export interface OrchestrationProposal {
  path: string;
  content: string;
  reason: string;
}

export interface OrchestrationRoleResult {
  role: OrchestrationRole;
  summary?: string;
  findings: OrchestrationFinding[];
  questions: string[];
  proposals: OrchestrationProposal[];
}

export interface ScheduleStateRecord {
  jobId: string;
  enabled: boolean;
  taskType: ScheduledTaskConfig["type"];
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: "success" | "failed";
  lastSessionId?: string;
  lastApprovalId?: string;
  error?: string;
}

export interface ScheduledRunResult {
  jobId: string;
  taskType: ScheduledTaskConfig["type"];
  startedAt: string;
  finishedAt: string;
  success: boolean;
  approvalId?: string;
  error?: string;
}

export interface ScheduleController {
  close(): Promise<void>;
}
