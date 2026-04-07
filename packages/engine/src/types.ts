import { z } from "zod";

export const providerCapabilitySchema = z.enum(["responses", "chat", "structured", "tools", "vision", "embeddings", "streaming", "local"]);

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providerTypeSchema = z.enum(["heuristic", "openai", "ollama", "anthropic", "gemini", "openai-compatible", "custom"]);

export type ProviderType = z.infer<typeof providerTypeSchema>;

export type PageKind = "index" | "source" | "concept" | "entity" | "output" | "insight";
export type Freshness = "fresh" | "stale";
export type ClaimStatus = "extracted" | "inferred" | "conflicted" | "stale";
export type Polarity = "positive" | "negative" | "neutral";
export type OutputOrigin = "query" | "explore";
export type PageStatus = "draft" | "candidate" | "active" | "archived";
export type PageManager = "system" | "human";

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
  sourceKind: "markdown" | "text" | "pdf" | "image" | "html" | "binary";
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
  producedAt: string;
}

export interface GraphNode {
  id: string;
  type: "source" | "concept" | "entity";
  label: string;
  pageId?: string;
  freshness?: Freshness;
  confidence?: number;
  sourceIds: string[];
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
}

export interface GraphArtifact {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  sources: SourceManifest[];
  pages: GraphPage[];
}

export interface CompileResult {
  graphPath: string;
  pageCount: number;
  changedPages: string[];
  sourceCount: number;
}

export interface SearchResult {
  pageId: string;
  path: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface QueryResult {
  answer: string;
  savedTo?: string;
  savedPageId?: string;
  citations: string[];
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
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
  schemaHash: string;
  analyses: Record<string, string>;
  sourceHashes: Record<string, string>;
  outputHashes: Record<string, string>;
  insightHashes: Record<string, string>;
}

export interface LintOptions {
  deep?: boolean;
  web?: boolean;
}

export interface ExploreStepResult {
  step: number;
  question: string;
  answer: string;
  savedTo: string;
  savedPageId: string;
  citations: string[];
  followUpQuestions: string[];
}

export interface ExploreResult {
  rootQuestion: string;
  hubPath: string;
  hubPageId: string;
  stepCount: number;
  steps: ExploreStepResult[];
  suggestedQuestions: string[];
}
