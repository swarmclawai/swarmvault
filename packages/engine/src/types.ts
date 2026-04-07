import { z } from "zod";

export const providerCapabilitySchema = z.enum(["responses", "chat", "structured", "tools", "vision", "embeddings", "streaming", "local"]);

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerTypeSchema = z.enum(["heuristic", "openai", "ollama", "anthropic", "gemini", "openai-compatible", "custom"]);

export type ProviderType = z.infer<typeof providerTypeSchema>;

export type PageKind = "index" | "source" | "module" | "concept" | "entity" | "output" | "insight";
export type Freshness = "fresh" | "stale";
export type ClaimStatus = "extracted" | "inferred" | "conflicted" | "stale";
export type Polarity = "positive" | "negative" | "neutral";
export type OutputOrigin = "query" | "explore";
export type OutputFormat = "markdown" | "report" | "slides";
export type PageStatus = "draft" | "candidate" | "active" | "archived";
export type PageManager = "system" | "human";
export type ApprovalEntryStatus = "pending" | "accepted" | "rejected";
export type ApprovalChangeType = "create" | "update" | "delete" | "promote";
export type SourceKind = "markdown" | "text" | "pdf" | "image" | "html" | "binary" | "code";
export type CodeLanguage = "javascript" | "jsx" | "typescript" | "tsx";
export type CodeSymbolKind = "function" | "class" | "interface" | "type_alias" | "enum" | "variable";

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

export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  readonly model: string;
  readonly capabilities: Set<ProviderCapability>;
  generateText(request: GenerationRequest): Promise<GenerationResponse>;
  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T>;
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
  agents: Array<"codex" | "claude" | "cursor">;
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
  projectsDir: string;
  candidatesDir: string;
  candidateConceptsDir: string;
  candidateEntitiesDir: string;
  stateDir: string;
  agentDir: string;
  inboxDir: string;
  manifestsDir: string;
  extractsDir: string;
  analysesDir: string;
  viewerDistDir: string;
  graphPath: string;
  searchDbPath: string;
  compileStatePath: string;
  jobsLogPath: string;
  sessionsDir: string;
  approvalsDir: string;
  configPath: string;
}

export interface SourceAttachment {
  path: string;
  mimeType: string;
  originalPath?: string;
}

export interface SourceManifest {
  sourceId: string;
  title: string;
  originType: "file" | "url";
  sourceKind: SourceKind;
  language?: CodeLanguage;
  originalPath?: string;
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
  imports: CodeImport[];
  dependencies: string[];
  symbols: CodeSymbol[];
  exports: string[];
  diagnostics: CodeDiagnostic[];
}

export interface SourceAnalysis {
  sourceId: string;
  sourceHash: string;
  schemaHash: string;
  title: string;
  summary: string;
  concepts: AnalyzedTerm[];
  entities: AnalyzedTerm[];
  claims: SourceClaim[];
  questions: string[];
  code?: CodeAnalysis;
  producedAt: string;
}

export interface GraphNode {
  id: string;
  type: "source" | "concept" | "entity" | "module" | "symbol";
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
}

export interface QueryResult {
  answer: string;
  savedPath?: string;
  savedPageId?: string;
  citations: string[];
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
  outputFormat: OutputFormat;
  saved: boolean;
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
  lintFindingCount?: number;
  success: boolean;
  error?: string;
}

export interface WatchController {
  close(): Promise<void>;
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
}

export interface ExploreStepResult {
  step: number;
  question: string;
  answer: string;
  savedPath: string;
  savedPageId: string;
  citations: string[];
  followUpQuestions: string[];
  outputFormat: OutputFormat;
}

export interface ExploreResult {
  rootQuestion: string;
  hubPath: string;
  hubPageId: string;
  stepCount: number;
  steps: ExploreStepResult[];
  suggestedQuestions: string[];
  outputFormat: OutputFormat;
}
