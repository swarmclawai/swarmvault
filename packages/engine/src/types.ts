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
  "image_generation",
  "audio"
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
  "local-whisper",
  "custom"
]);

export type ProviderType = z.infer<typeof providerTypeSchema>;
export const agentTypeSchema = z.enum([
  "codex",
  "claude",
  "cursor",
  "goose",
  "pi",
  "gemini",
  "opencode",
  "aider",
  "copilot",
  "trae",
  "claw",
  "droid",
  "kiro",
  "hermes",
  "antigravity",
  "vscode",
  "amp",
  "augment",
  "adal",
  "bob",
  "cline",
  "codebuddy",
  "command-code",
  "continue",
  "cortex",
  "crush",
  "deepagents",
  "firebender",
  "iflow",
  "junie",
  "kilo-code",
  "kimi",
  "kode",
  "mcpjam",
  "mistral-vibe",
  "mux",
  "neovate",
  "openclaw",
  "openhands",
  "pochi",
  "qoder",
  "qwen-code",
  "replit",
  "roo-code",
  "trae-cn",
  "warp",
  "windsurf",
  "zencoder"
]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export type PageKind =
  | "index"
  | "source"
  | "module"
  | "concept"
  | "entity"
  | "output"
  | "insight"
  | "memory_task"
  | "graph_report"
  | "community_summary";
export type Freshness = "fresh" | "stale";
/**
 * Consolidation tier for insight pages (LLM Wiki v2 memory model).
 *  - `working`: raw recent observations from ad-hoc query/explore output.
 *  - `episodic`: session-scoped digest rolled up from multiple working pages.
 *  - `semantic`: cross-session durable facts repeated across episodic pages.
 *  - `procedural`: how-to workflows inferred from repeated sequences.
 * Non-insight pages (sources, modules, concepts, entities, outputs) leave
 * `tier` undefined. Pages without a `tier` field default to `working` when
 * loaded so 0.9.0 vaults require no migration.
 */
export type MemoryTier = "working" | "episodic" | "semantic" | "procedural";
export type ClaimStatus = "extracted" | "inferred" | "conflicted" | "stale";
export type EvidenceClass = "extracted" | "inferred" | "ambiguous";
export type Polarity = "positive" | "negative" | "neutral";
export type OutputOrigin = "query" | "explore" | "source_brief" | "source_review" | "source_guide" | "source_session";
export type OutputFormat = "markdown" | "report" | "slides" | "chart" | "image";
export type ContextPackFormat = "markdown" | "json" | "llms";
export type ContextPackItemKind = "page" | "node" | "edge" | "hyperedge";
export type AgentMemoryTaskStatus = "active" | "blocked" | "completed" | "archived";
export type AgentMemoryResumeFormat = "markdown" | "json" | "llms";
export type OutputAssetRole = "primary" | "preview" | "manifest" | "poster";
export type GraphExportFormat = "html" | "html-standalone" | "report" | "svg" | "graphml" | "cypher" | "json" | "obsidian" | "canvas";
export type PageStatus = "draft" | "candidate" | "active" | "blocked" | "completed" | "archived";
export type PageManager = "system" | "human";
export type ApprovalEntryStatus = "pending" | "accepted" | "rejected";
export type ApprovalChangeType = "create" | "update" | "delete" | "promote";
export type ApprovalBundleType = "compile" | "generated-output" | "source-review" | "guided-source" | "guided-session";
export type ApprovalEntryLabel = "source-brief" | "source-review" | "source-guide" | "guided-update";
export type GuidedSourceSessionStatus = "awaiting_input" | "ready_to_stage" | "staged" | "accepted" | "rejected";
export type VaultProfilePreset = "reader" | "timeline" | "diligence" | "thesis";
export type VaultDashboardPack = "default" | "reader" | "diligence";
export type GuidedSessionMode = "insights_only" | "canonical_review";
export type SourceKind =
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "html"
  | "docx"
  | "epub"
  | "csv"
  | "xlsx"
  | "pptx"
  | "odt"
  | "odp"
  | "ods"
  | "jupyter"
  | "data"
  | "bibtex"
  | "rtf"
  | "org"
  | "asciidoc"
  | "transcript"
  | "chat_export"
  | "email"
  | "calendar"
  | "audio"
  | "youtube"
  | "binary"
  | "code";
export type SourceCaptureType = "arxiv" | "doi" | "tweet" | "article" | "url";
export type SourceClass = "first_party" | "third_party" | "resource" | "generated";
export type ManagedSourceKind = "directory" | "file" | "github_repo" | "crawl_url";
export type ManagedSourceStatus = "ready" | "missing" | "error";
export type CodeLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "bash"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "scala"
  | "dart"
  | "lua"
  | "zig"
  | "csharp"
  | "c"
  | "cpp"
  | "php"
  | "ruby"
  | "powershell"
  | "swift"
  | "elixir"
  | "ocaml"
  | "objc"
  | "rescript"
  | "solidity"
  | "html"
  | "css"
  | "vue";
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

export interface AudioTranscriptionRequest {
  mimeType: string;
  bytes: Buffer;
  fileName?: string;
  language?: string;
  /**
   * Optional one-sentence domain hint derived from the vault's top god nodes.
   * Providers that accept a prompt (e.g. Whisper) can pass it through to bias
   * transcription toward in-corpus terminology. Providers without prompt
   * support ignore it safely.
   */
  corpusHint?: string;
}

export interface AudioTranscriptionResponse {
  text: string;
  duration?: number;
  language?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly type: ProviderType;
  readonly model: string;
  readonly capabilities: Set<ProviderCapability>;
  generateText(request: GenerationRequest): Promise<GenerationResponse>;
  generateStructured<T>(request: GenerationRequest, schema: z.ZodType<T>): Promise<T>;
  embedTexts?(texts: string[]): Promise<number[][]>;
  generateImage?(request: ImageGenerationRequest): Promise<ImageGenerationResponse>;
  transcribeAudio?(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse>;
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
  /** local-whisper: override the binary discovery search. */
  binaryPath?: string;
  /** local-whisper: explicit path to the ggml model file. */
  modelPath?: string;
  /** local-whisper: extra CLI flags forwarded to whisper.cpp. */
  extraArgs?: string[];
  /** local-whisper: thread count passed as `-t`. */
  threads?: number;
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

export interface VaultProfileConfig {
  presets: VaultProfilePreset[];
  dashboardPack: VaultDashboardPack;
  guidedSessionMode: GuidedSessionMode;
  dataviewBlocks: boolean;
  guidedIngestDefault: boolean;
  deepLintDefault: boolean;
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
    embeddingProvider?: string;
    audioProvider?: string;
  };
  viewer: {
    port: number;
  };
  profile: VaultProfileConfig;
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
  benchmark?: {
    enabled?: boolean;
    questions?: string[];
    maxQuestions?: number;
  };
  repoAnalysis?: {
    classifyGlobs?: Partial<Record<SourceClass, string[]>>;
    extractClasses?: SourceClass[];
  };
  graphSinks?: {
    neo4j?: Neo4jGraphSinkConfig;
  };
  graph?: {
    communityResolution?: number;
    /**
     * Minimum IDF weight a similarity feature must carry to contribute to an
     * inferred `semantically_similar_to` edge. Features below the floor are
     * dropped entirely. Defaults to 0.5.
     */
    similarityIdfFloor?: number;
    /**
     * Hard cap on the number of inferred similarity edges emitted. Defaults
     * to `min(5 * nodeCount, 20000)` so very large repos do not produce
     * O(n²) similarity fan-out.
     */
    similarityEdgeCap?: number;
    /**
     * Upper bound on god-node entries surfaced in the graph report and
     * tooling. Defaults to 20 for small repos and 10 for large ones.
     */
    godNodeLimit?: number;
    /**
     * Report rollup threshold: communities with fewer members than this are
     * folded into the fragmented-community rollup instead of listed
     * individually. Defaults to `max(3, ceil(totalCommunities / 50))`.
     */
    foldCommunitiesBelow?: number;
  };
  retrieval?: {
    backend?: "sqlite";
    shardSize?: number;
    hybrid?: boolean;
    rerank?: boolean;
    embeddingProvider?: string;
    maxIndexedRows?: number;
  };
  webSearch?: {
    providers: Record<string, WebSearchProviderConfig>;
    tasks: {
      deepLintProvider: string;
      queryProvider?: string;
      exploreProvider?: string;
    };
  };
  search?: {
    /** @deprecated Use retrieval.hybrid instead. */
    hybrid?: boolean;
    /** @deprecated Use retrieval.rerank instead. */
    rerank?: boolean;
  };
  autoCommit?: boolean;
  candidate?: {
    autoPromote?: CandidatePromotionConfig;
  };
  redaction?: RedactionSettings;
  freshness?: FreshnessConfig;
  consolidation?: ConsolidationConfig;
  watch?: WatchConfig;
}

/**
 * Explicit user control over which repository roots `swarmvault watch --repo` tracks.
 * Absent config preserves the existing auto-discovery behavior over managed sources and manifests.
 */
export interface WatchConfig {
  repoRoots?: string[];
  excludeRepoRoots?: string[];
}

/**
 * Heuristic configuration for the LLM Wiki v2 consolidation tier rollup.
 *
 * Defaults are baked in so 0.9.0 configs keep working without migration:
 *   - enabled: true
 *   - workingToEpisodic: { minPages: 3, sessionWindowHours: 24, minSharedNodeRatio: 0.3 }
 *   - episodicToSemantic: { minOccurrences: 3 }
 *   - semanticToProcedural: { minWorkflowSteps: 3 }
 */
export interface ConsolidationConfig {
  enabled?: boolean;
  workingToEpisodic?: {
    minPages?: number;
    sessionWindowHours?: number;
    minSharedNodeRatio?: number;
  };
  episodicToSemantic?: {
    minOccurrences?: number;
  };
  semanticToProcedural?: {
    minWorkflowSteps?: number;
  };
}

export interface ConsolidationPromotion {
  pageId: string;
  fromTier: MemoryTier;
  toTier: MemoryTier;
}

export interface ConsolidationResult {
  promoted: ConsolidationPromotion[];
  newPages: GraphPage[];
  decisions: string[];
}

export interface FreshnessConfig {
  /** Default half-life in days when the page's source class is unknown. Defaults to 365. */
  defaultHalfLifeDays?: number;
  /** Below this score a page is considered stale. Defaults to 0.3. */
  staleThreshold?: number;
  /** Per-source-class half-life overrides in days. */
  halfLifeDaysBySourceClass?: Partial<Record<SourceClass, number>>;
}

export interface RedactionPatternConfig {
  id: string;
  pattern: string;
  flags?: string;
  placeholder?: string;
  description?: string;
}

export interface RedactionSettings {
  enabled?: boolean;
  placeholder?: string;
  useDefaults?: boolean;
  patterns?: RedactionPatternConfig[];
}

export interface RedactionMatchSummary {
  patternId: string;
  count: number;
}

export interface RedactionSummary {
  sourceId: string;
  title: string;
  matches: RedactionMatchSummary[];
}

export interface CandidatePromotionConfig {
  enabled: boolean;
  minSources: number;
  minConfidence: number;
  minAgreement: number;
  minDegree: number;
  minAgeHours: number;
  maxPerRun: number;
  dryRun: boolean;
}

export type PromotionGateKind = "sources" | "confidence" | "agreement" | "degree" | "age";

export interface PromotionGateResult {
  gate: PromotionGateKind;
  value: number;
  threshold: number;
  passed: boolean;
}

export interface PromotionDecision {
  pageId: string;
  title: string;
  kind: "concept" | "entity";
  promote: boolean;
  score: number;
  gates: PromotionGateResult[];
  reasons: string[];
}

export interface PromotionSession {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  promotedPageIds: string[];
  skippedPageIds: string[];
  decisions: PromotionDecision[];
  sessionPath?: string;
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
  retrievalDir: string;
  retrievalManifestPath: string;
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
  embeddingsPath: string;
  benchmarkPath: string;
  jobsLogPath: string;
  sessionsDir: string;
  sourceSessionsDir: string;
  approvalsDir: string;
  watchDir: string;
  watchStatusPath: string;
  pendingSemanticRefreshPath: string;
  managedSourcesPath: string;
  managedSourcesDir: string;
  configPath: string;
}

export interface SourceAttachment {
  path: string;
  mimeType: string;
  originalPath?: string;
}

export type ExtractionKind =
  | "plain_text"
  | "html_readability"
  | "pdf_text"
  | "docx_text"
  | "epub_text"
  | "csv_text"
  | "xlsx_text"
  | "pptx_text"
  | "odt_text"
  | "odp_text"
  | "ods_text"
  | "jupyter_text"
  | "structured_data"
  | "bibtex_text"
  | "rtf_text"
  | "org_text"
  | "asciidoc_text"
  | "transcript_text"
  | "chat_export_text"
  | "email_text"
  | "calendar_text"
  | "image_vision"
  | "audio_transcription"
  | "youtube_transcript";

export interface ExtractionTerm {
  name: string;
  description: string;
}

export interface ExtractionClaim {
  text: string;
  confidence: number;
  polarity: Polarity;
}

export interface ImageVisionExtraction {
  title?: string;
  summary: string;
  text: string;
  concepts: ExtractionTerm[];
  entities: ExtractionTerm[];
  claims: ExtractionClaim[];
  questions: string[];
}

export interface SourceExtractionArtifact {
  extractor: ExtractionKind;
  sourceKind: SourceKind;
  mimeType: string;
  producedAt: string;
  providerId?: string;
  providerModel?: string;
  warnings?: string[];
  pageCount?: number;
  metadata?: Record<string, string>;
  vision?: ImageVisionExtraction;
}

export interface IngestOptions {
  includeAssets?: boolean;
  maxAssetSize?: number;
  repoRoot?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  gitignore?: boolean;
  extractClasses?: SourceClass[];
  resume?: string;
  /**
   * Override the config-level redaction flag for this run. Defaults to the
   * effective value in `VaultConfig.redaction.enabled` (which itself defaults
   * to `true` when the config block is absent). Pass `false` to skip
   * redaction entirely for this run.
   */
  redact?: boolean;
}

export interface DirectoryIngestSkip {
  path: string;
  reason: string;
}

export interface DirectoryIngestFailure {
  path: string;
  error: string;
  stage: "prepare" | "persist";
}

export interface DirectoryIngestResult {
  inputDir: string;
  repoRoot: string;
  scannedCount: number;
  imported: SourceManifest[];
  updated: SourceManifest[];
  skipped: DirectoryIngestSkip[];
  failed?: DirectoryIngestFailure[];
  runId?: string;
  statePath?: string;
  /**
   * Per-source redaction counts surfaced to CLI/MCP callers. Empty when
   * redaction was disabled or no matches were found on the ingested inputs.
   */
  redactions?: RedactionSummary[];
}

export interface InputIngestResult {
  input: string;
  scannedCount: number;
  created: SourceManifest[];
  updated: SourceManifest[];
  unchanged: SourceManifest[];
  removed: SourceManifest[];
  skipped: DirectoryIngestSkip[];
  /**
   * Per-source redaction counts surfaced to CLI/MCP callers. Empty when
   * redaction was disabled or no matches were found on the ingested inputs.
   */
  redactions?: RedactionSummary[];
}

export interface SourceManifest {
  sourceId: string;
  title: string;
  originType: "file" | "url";
  sourceKind: SourceKind;
  sourceType?: SourceCaptureType;
  sourceClass?: SourceClass;
  language?: CodeLanguage;
  originalPath?: string;
  repoRelativePath?: string;
  url?: string;
  storedPath: string;
  extractedTextPath?: string;
  extractedMetadataPath?: string;
  extractionHash?: string;
  mimeType: string;
  contentHash: string;
  semanticHash: string;
  sourceGroupId?: string;
  sourceGroupTitle?: string;
  sourcePartKey?: string;
  partIndex?: number;
  partCount?: number;
  partTitle?: string;
  details?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  attachments?: SourceAttachment[];
}

export interface ManagedSourceSyncCounts {
  scannedCount: number;
  importedCount: number;
  updatedCount: number;
  removedCount: number;
  skippedCount: number;
}

export interface ManagedSourceRecord {
  id: string;
  kind: ManagedSourceKind;
  title: string;
  path?: string;
  repoRoot?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
  status: ManagedSourceStatus;
  sourceIds: string[];
  briefPath?: string;
  lastSyncAt?: string;
  lastSyncStatus?: "success" | "error";
  lastSyncCounts?: ManagedSourceSyncCounts;
  lastError?: string;
  changed?: boolean;
}

export interface ManagedSourcesArtifact {
  version: 1;
  sources: ManagedSourceRecord[];
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
  /**
   * Structural kind for code rationales (`docstring`, `comment`, `marker`) or
   * the lowercased fixed-prefix marker for non-code rationales (`note`,
   * `why`, `hack`, `important`, `rationale`, `todo`, `fixme`, `warning`,
   * `warn`). Non-code kinds are parser-selected from markdown blockquotes /
   * list items and plain-text paragraphs, never swept from whole files.
   */
  kind: "docstring" | "comment" | "marker" | "note" | "why" | "hack" | "important" | "rationale" | "todo" | "fixme" | "warning" | "warn";
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
  semanticHash: string;
  extractionHash?: string;
  schemaHash: string;
  title: string;
  summary: string;
  concepts: AnalyzedTerm[];
  entities: AnalyzedTerm[];
  claims: SourceClaim[];
  questions: string[];
  tags: string[];
  rationales: SourceRationale[];
  code?: CodeAnalysis;
  producedAt: string;
}

export interface GraphNode {
  id: string;
  type: "source" | "concept" | "entity" | "module" | "symbol" | "rationale" | "memory_task" | "decision";
  label: string;
  /** Lowercased NFKD-normalized label (diacritic-insensitive) for lexical matching. */
  normLabel?: string;
  pageId?: string;
  freshness?: Freshness;
  confidence?: number;
  sourceIds: string[];
  projectIds: string[];
  sourceClass?: SourceClass;
  language?: CodeLanguage;
  moduleId?: string;
  symbolKind?: CodeSymbolKind;
  communityId?: string;
  degree?: number;
  bridgeScore?: number;
  isGodNode?: boolean;
  /**
   * Human-readable explanation of why this node was flagged as a god-node
   * (high-degree hub). Populated for god nodes only. Deterministic.
   */
  surpriseReason?: string;
  tags?: string[];
}

/**
 * Graph edges use an open-string `relation` so new semantics can land
 * without churning every consumer. Commonly produced relations include:
 *   - `mentions`, `contains_code`, `defines`, `exports`, `imports`,
 *     `contradicts`, `supports`, `builds_on`.
 *   - `superseded_by`: the source node/page has been replaced by the
 *     target. The older page is expected to carry `freshness: "stale"`
 *     and `supersededBy` pointing at the target page id. Compile,
 *     ingest, and human review can all produce this relation; lint
 *     surfaces broken supersession links.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  status: ClaimStatus;
  evidenceClass: EvidenceClass;
  confidence: number;
  provenance: string[];
  similarityReasons?: Array<
    "shared_concept" | "shared_entity" | "shared_tag" | "shared_symbol" | "shared_rationale_theme" | "shared_source_type"
  >;
  similarityBasis?: "feature_overlap" | "embeddings";
}

export interface GraphHyperedge {
  id: string;
  label: string;
  relation: "participate_in" | "implement" | "form";
  nodeIds: string[];
  evidenceClass: EvidenceClass;
  confidence: number;
  sourcePageIds: string[];
  why: string;
}

export interface GraphPage {
  id: string;
  path: string;
  title: string;
  kind: PageKind;
  sourceType?: SourceCaptureType;
  sourceClass?: SourceClass;
  sourceIds: string[];
  projectIds: string[];
  nodeIds: string[];
  freshness: Freshness;
  /**
   * Numeric freshness score in [0, 1] that decays over time based on the
   * source-class half-life. `1` means fully fresh (just confirmed), `0`
   * means fully decayed. Pages that predate decay tracking are treated as
   * `1` so old vaults are not penalized. See `freshness.ts` for the decay
   * function and thresholds.
   */
  decayScore?: number;
  /**
   * ISO timestamp of the last time compile or ingest confirmed this page
   * against a live source/claim. Missing on pages that existed before
   * decay tracking landed.
   */
  lastConfirmedAt?: string;
  /**
   * If set, this page has been superseded by another page. The value is
   * the replacement page id. A matching `superseded_by` relation edge
   * connects the old page's node to the replacement in the graph.
   */
  supersededBy?: string;
  status: PageStatus;
  confidence: number;
  backlinks: string[];
  schemaHash: string;
  sourceHashes: Record<string, string>;
  sourceSemanticHashes: Record<string, string>;
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
  /**
   * Memory-tier assignment for insight pages. Undefined on non-insight
   * pages. When an insight page on disk is missing this field, callers
   * default it to `"working"` in memory; no on-disk migration happens.
   */
  tier?: MemoryTier;
  /**
   * Lower-tier page ids that were rolled up into this page during a
   * consolidation pass. Populated only on pages produced by
   * `runConsolidation` (episodic/semantic/procedural). Empty/undefined on
   * working-tier or non-insight pages.
   */
  consolidatedFromPageIds?: string[];
  /**
   * Heuristic confidence (0..1) that the consolidation rollup is
   * meaningful. Missing when the page was not produced by consolidation.
   */
  consolidationConfidence?: number;
}

export interface GraphArtifact {
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  hyperedges: GraphHyperedge[];
  communities?: Array<{
    id: string;
    label: string;
    nodeIds: string[];
  }>;
  sources: SourceManifest[];
  pages: GraphPage[];
}

export interface GraphStatsResult {
  generatedAt: string;
  counts: {
    sources: number;
    pages: number;
    nodes: number;
    edges: number;
    hyperedges: number;
    communities: number;
  };
  nodeTypes: Partial<Record<GraphNode["type"], number>>;
  evidenceClasses: Partial<Record<EvidenceClass, number>>;
  sourceClasses: Record<SourceClass, { sources: number; pages: number; nodes: number }>;
  edgeRelations: Record<string, number>;
  hyperedgeRelations: Record<string, number>;
}

export interface GraphCommunityResult {
  generatedAt: string;
  id: string;
  label: string;
  nodeCount: number;
  pageCount: number;
  edgeCount: number;
  nodes: Array<{
    id: string;
    type: GraphNode["type"];
    label: string;
    pageId?: string;
    sourceClass?: SourceClass;
    degree?: number;
    bridgeScore?: number;
    confidence?: number;
  }>;
  pages: Array<{
    id: string;
    path: string;
    title: string;
    kind: PageKind;
    sourceClass?: SourceClass;
    freshness: Freshness;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceLabel?: string;
    targetLabel?: string;
    relation: string;
    evidenceClass: EvidenceClass;
    confidence: number;
  }>;
}

export interface GraphQueryMatch {
  type: "node" | "page" | "hyperedge";
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
  hyperedgeIds: string[];
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
  hyperedges: GraphHyperedge[];
  summary: string;
}

export interface GraphDiffResult {
  addedNodes: Array<{ id: string; label: string; type: GraphNode["type"] }>;
  removedNodes: Array<{ id: string; label: string; type: GraphNode["type"] }>;
  addedEdges: Array<{ id: string; source: string; target: string; relation: string; evidenceClass: EvidenceClass }>;
  removedEdges: Array<{ id: string; source: string; target: string; relation: string; evidenceClass: EvidenceClass }>;
  addedPages: Array<{ id: string; path: string; title: string; kind: PageKind }>;
  removedPages: Array<{ id: string; path: string; title: string; kind: PageKind }>;
  summary: string;
}

export interface ContextPackItem {
  id: string;
  kind: ContextPackItemKind;
  title: string;
  reason: string;
  score: number;
  estimatedTokens: number;
  excerpt?: string;
  path?: string;
  pageId?: string;
  nodeId?: string;
  edgeId?: string;
  hyperedgeId?: string;
  sourceIds: string[];
  pageIds: string[];
  nodeIds: string[];
  edgeIds: string[];
  freshness?: Freshness;
  evidenceClass?: EvidenceClass;
  confidence?: number;
}

export interface ContextPackOmittedItem {
  id: string;
  kind: ContextPackItemKind;
  title: string;
  reason: string;
  estimatedTokens: number;
}

export interface ContextPack {
  id: string;
  title: string;
  goal: string;
  target?: string;
  createdAt: string;
  format: ContextPackFormat;
  budgetTokens: number;
  estimatedTokens: number;
  artifactPath: string;
  markdownPath: string;
  citations: string[];
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
  graphQuery: GraphQueryResult;
  items: ContextPackItem[];
  omittedItems: ContextPackOmittedItem[];
}

export interface ContextPackSummary {
  id: string;
  title: string;
  goal: string;
  target?: string;
  createdAt: string;
  budgetTokens: number;
  estimatedTokens: number;
  artifactPath: string;
  markdownPath: string;
  itemCount: number;
  omittedCount: number;
}

export interface BuildContextPackOptions {
  goal: string;
  target?: string;
  budgetTokens?: number;
  format?: ContextPackFormat;
  memoryTaskId?: string;
}

export interface BuildContextPackResult {
  pack: ContextPack;
  artifactPath: string;
  markdownPath: string;
  rendered: string;
}

export interface AgentMemoryNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface AgentMemoryDecision {
  id: string;
  text: string;
  createdAt: string;
}

export interface AgentMemoryTask {
  id: string;
  title: string;
  goal: string;
  status: AgentMemoryTaskStatus;
  target?: string;
  agent?: string;
  createdAt: string;
  updatedAt: string;
  contextPackIds: string[];
  sessionIds: string[];
  sourceIds: string[];
  pageIds: string[];
  nodeIds: string[];
  changedPaths: string[];
  gitRefs: string[];
  notes: AgentMemoryNote[];
  decisions: AgentMemoryDecision[];
  outcome?: string;
  followUps: string[];
  artifactPath: string;
  markdownPath: string;
}

export interface AgentMemoryTaskSummary {
  id: string;
  title: string;
  goal: string;
  status: AgentMemoryTaskStatus;
  target?: string;
  agent?: string;
  createdAt: string;
  updatedAt: string;
  contextPackIds: string[];
  changedPaths: string[];
  decisionCount: number;
  followUpCount: number;
  artifactPath: string;
  markdownPath: string;
}

export interface StartMemoryTaskOptions {
  goal: string;
  target?: string;
  budgetTokens?: number;
  agent?: string;
  contextPackId?: string;
}

export interface UpdateMemoryTaskOptions {
  note?: string;
  decision?: string;
  changedPath?: string;
  contextPackId?: string;
  sessionId?: string;
  sourceId?: string;
  pageId?: string;
  nodeId?: string;
  gitRef?: string;
  status?: AgentMemoryTaskStatus;
}

export interface FinishMemoryTaskOptions {
  outcome: string;
  followUp?: string;
}

export interface AgentMemoryTaskResult {
  task: AgentMemoryTask;
  artifactPath: string;
  markdownPath: string;
}

export interface ResumeMemoryTaskOptions {
  format?: AgentMemoryResumeFormat;
}

export interface ResumeMemoryTaskResult {
  task: AgentMemoryTask;
  rendered: string;
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
  label?: ApprovalEntryLabel;
}

export interface ApprovalManifest {
  approvalId: string;
  createdAt: string;
  bundleType?: ApprovalBundleType;
  title?: string;
  sourceSessionId?: string;
  entries: ApprovalEntry[];
}

export interface ApprovalSummary {
  approvalId: string;
  createdAt: string;
  bundleType?: ApprovalBundleType;
  title?: string;
  sourceSessionId?: string;
  entryCount: number;
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
}

export type ApprovalDiffLine = {
  type: "add" | "remove" | "context";
  value: string;
};

export type ApprovalDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: ApprovalDiffLine[];
};

export type ApprovalFrontmatterChange = {
  key: string;
  before?: unknown;
  after?: unknown;
  protected: boolean;
};

export type ApprovalStructuredDiff = {
  hunks: ApprovalDiffHunk[];
  addedLines: number;
  removedLines: number;
  frontmatterChanges: ApprovalFrontmatterChange[];
};

export interface ApprovalEntryDetail extends ApprovalEntry {
  currentContent?: string;
  stagedContent?: string;
  changeSummary?: string;
  diff?: string;
  structuredDiff?: ApprovalStructuredDiff;
  warnings?: string[];
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
  score?: number;
  scoreBreakdown?: Record<string, number>;
}

export interface BlastRadiusResult {
  target: string;
  resolvedModuleId?: string;
  affectedModules: Array<{ moduleId: string; label: string; depth: number }>;
  totalAffected: number;
  maxDepth: number;
  summary: string;
}

export interface CompileOptions {
  approve?: boolean;
  codeOnly?: boolean;
  maxTokens?: number;
}

export interface InitOptions {
  obsidian?: boolean;
  profile?: string;
  lite?: boolean;
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
  autoPromotion?: {
    evaluated: number;
    promoted: number;
    dryRun: boolean;
    sessionPath?: string;
  };
  tokenStats?: {
    estimatedTokens: number;
    maxTokens: number;
    pagesKept: number;
    pagesDropped: number;
  };
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
  sourceType?: SourceCaptureType;
  sourceClass?: SourceClass;
}

export interface RetrievalConfig {
  backend: "sqlite";
  shardSize: number;
  hybrid: boolean;
  rerank: boolean;
  embeddingProvider?: string;
  maxIndexedRows?: number;
}

export interface RetrievalManifest {
  version: 1;
  backend: "sqlite";
  generatedAt: string;
  graphGeneratedAt?: string;
  graphHash?: string;
  shardCount: number;
  shards: Array<{
    id: string;
    path: string;
    pageCount: number;
  }>;
}

export interface RetrievalStatus {
  configured: RetrievalConfig;
  manifestPath: string;
  indexPath: string;
  manifestExists: boolean;
  indexExists: boolean;
  graphExists: boolean;
  stale: boolean;
  pageCount: number;
  shardCount: number;
  warnings: string[];
}

export interface RetrievalDoctorResult {
  status: RetrievalStatus;
  ok: boolean;
  repaired: boolean;
  actions: string[];
}

export type VaultDoctorStatus = "ok" | "warning" | "error";

export interface VaultDoctorAction {
  command: string;
  description: string;
  destructive?: boolean;
}

export type VaultDoctorRecommendationPriority = "high" | "medium" | "low";
export type VaultDoctorSafeAction = "doctor:repair";

export interface VaultDoctorRecommendation {
  id: string;
  label: string;
  summary: string;
  priority: VaultDoctorRecommendationPriority;
  status: VaultDoctorStatus;
  sourceCheckId: string;
  command?: string;
  description?: string;
  safeAction?: VaultDoctorSafeAction;
}

export interface VaultDoctorCheck {
  id: string;
  label: string;
  status: VaultDoctorStatus;
  summary: string;
  detail?: string;
  actions?: VaultDoctorAction[];
}

export interface VaultDoctorCounts {
  sources: number;
  managedSources: number;
  pages: number;
  nodes: number;
  edges: number;
  approvalsPending: number;
  candidates: number;
  tasks: number;
  pendingSemanticRefresh: number;
}

export interface VaultDoctorReport {
  ok: boolean;
  status: VaultDoctorStatus;
  generatedAt: string;
  rootDir: string;
  version: string;
  counts: VaultDoctorCounts;
  checks: VaultDoctorCheck[];
  recommendations: VaultDoctorRecommendation[];
  repaired: string[];
}

export interface QueryOptions {
  question: string;
  save?: boolean;
  format?: OutputFormat;
  review?: boolean;
  gapFill?: boolean;
  memoryTaskId?: string;
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
  codeOnly?: boolean;
  overrideRoots?: string[];
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
  hook?: boolean;
}

export interface InstallAgentResult {
  agent: AgentType;
  target: string;
  targets: string[];
  warnings?: string[];
}

export interface ManagedSourceAddOptions {
  compile?: boolean;
  brief?: boolean;
  review?: boolean;
  guide?: boolean;
  guideAnswers?: GuidedSourceSessionAnswers;
  maxPages?: number;
  maxDepth?: number;
}

export interface ManagedSourceReloadOptions extends ManagedSourceAddOptions {
  id?: string;
  all?: boolean;
}

export interface ManagedSourceAddResult {
  source: ManagedSourceRecord;
  compile?: CompileResult;
  briefGenerated: boolean;
  review?: SourceReviewResult;
  guide?: SourceGuideResult;
}

export interface ManagedSourceReloadResult {
  sources: ManagedSourceRecord[];
  compile?: CompileResult;
  briefPaths: string[];
  reviews: SourceReviewResult[];
  guides: SourceGuideResult[];
}

export interface ManagedSourceDeleteResult {
  removed: ManagedSourceRecord;
}

export interface GuidedSourceSessionQuestion {
  id: string;
  prompt: string;
  answer?: string;
}

export type GuidedSourceSessionAnswers = Record<string, string> | string[];

export interface GuidedSourceSessionRecord {
  sessionId: string;
  scopeId: string;
  scopeTitle: string;
  sourceIds: string[];
  kind?: string;
  status: GuidedSourceSessionStatus;
  createdAt: string;
  updatedAt: string;
  questions: GuidedSourceSessionQuestion[];
  briefPath?: string;
  reviewPath?: string;
  guidePath?: string;
  sessionPath?: string;
  approvalId?: string;
  approvalDir?: string;
  targetedPagePaths: string[];
  stagedUpdatePaths: string[];
}

export interface SourceReviewResult {
  sourceId: string;
  pageId: string;
  reviewPath: string;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
}

export interface SourceGuideResult {
  sourceId: string;
  pageId?: string;
  guidePath?: string;
  reviewPageId?: string;
  reviewPath?: string;
  sessionId: string;
  sessionPath: string;
  sessionStatePath: string;
  status: GuidedSourceSessionStatus;
  questions: GuidedSourceSessionQuestion[];
  awaitingInput?: boolean;
  targetedPagePaths: string[];
  stagedUpdatePaths: string[];
  briefPath?: string;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
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
  sourceSemanticHashes: Record<string, string>;
  sourceProjects: Record<string, string | null>;
  outputHashes: Record<string, string>;
  insightHashes: Record<string, string>;
  memoryHashes?: Record<string, string>;
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
  conflicts?: boolean;
  /**
   * When true, only decay-related lint rules run
   * (`decayed-pages`, `broken_supersession`, `inconsistent_decay`).
   */
  decay?: boolean;
  /**
   * When true, only consolidation-tier lint rules run
   * (`stale_working_tier`, `broken_consolidation_basis`,
   * `semantic_without_episodic_basis`).
   */
  tiers?: boolean;
}

export interface ExploreOptions {
  question: string;
  steps?: number;
  format?: OutputFormat;
  review?: boolean;
  gapFill?: boolean;
  memoryTaskId?: string;
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
  fileCount?: number;
}

export interface Neo4jGraphSinkConfig {
  uri: string;
  username: string;
  passwordEnv: string;
  database?: string;
  vaultId?: string;
  includeClasses?: SourceClass[];
  batchSize?: number;
}

export interface GraphPushNeo4jOptions {
  uri?: string;
  username?: string;
  passwordEnv?: string;
  database?: string;
  vaultId?: string;
  includeClasses?: SourceClass[];
  batchSize?: number;
  dryRun?: boolean;
}

export interface GraphPushCounts {
  sources: number;
  pages: number;
  nodes: number;
  relationships: number;
  hyperedges: number;
  groupMembers: number;
}

export interface GraphPushResult {
  sink: "neo4j";
  uri: string;
  database: string;
  vaultId: string;
  dryRun: boolean;
  graphHash: string;
  includedSourceClasses: SourceClass[];
  counts: GraphPushCounts;
  skipped: GraphPushCounts;
  warnings: string[];
}

export interface AddOptions extends IngestOptions {
  author?: string;
  contributor?: string;
}

export interface AddResult {
  captureType: SourceCaptureType;
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
  visitedEdgeIds: string[];
  pageIds: string[];
}

export interface BenchmarkSummary {
  questionCount: number;
  uniqueVisitedNodes: number;
  finalContextTokens: number;
  naiveCorpusTokens: number;
  avgReduction: number;
  reductionRatio: number;
}

/**
 * Per-source-class slice of a benchmark run. The graph-guided tokens are
 * computed against the same traversal seeds that produced the corpus-wide
 * numbers, then narrowed to nodes/edges/pages whose `sourceClass` matches
 * this class. The naive tokens come from manifests whose
 * {@link SourceManifest.sourceClass} matches this class. Empty classes are
 * represented as zeroed entries rather than being omitted so downstream
 * consumers never have to branch on `undefined`.
 */
export interface BenchmarkByClassEntry {
  sourceClass: SourceClass;
  sourceCount: number;
  pageCount: number;
  nodeCount: number;
  godNodeCount: number;
  corpusWords: number;
  corpusTokens: number;
  finalContextTokens: number;
  reductionRatio: number;
  perQuestion: BenchmarkQuestionResult[];
}

export interface BenchmarkArtifact {
  generatedAt: string;
  graphHash: string;
  corpusWords: number;
  corpusTokens: number;
  nodes: number;
  edges: number;
  avgQueryTokens: number;
  reductionRatio: number;
  sampleQuestions: string[];
  perQuestion: BenchmarkQuestionResult[];
  summary: BenchmarkSummary;
  byClass: Record<SourceClass, BenchmarkByClassEntry>;
}

export interface EmbeddingCacheEntry {
  itemId: string;
  kind: "node" | "page" | "hyperedge";
  label: string;
  contentHash: string;
  values: number[];
}

export interface EmbeddingCacheArtifact {
  generatedAt: string;
  providerId: string;
  providerModel: string;
  graphHash: string;
  entries: EmbeddingCacheEntry[];
}

export interface BenchmarkOptions {
  questions?: string[];
  maxQuestions?: number;
}

export interface GraphReportArtifact {
  generatedAt: string;
  graphHash: string;
  overview: {
    nodes: number;
    edges: number;
    pages: number;
    communities: number;
  };
  firstPartyOverview: {
    nodes: number;
    edges: number;
    pages: number;
    communities: number;
  };
  sourceClassBreakdown: Record<SourceClass, { sources: number; pages: number; nodes: number }>;
  warnings: string[];
  benchmark?: {
    generatedAt: string;
    stale: boolean;
    summary: BenchmarkSummary;
    questionCount: number;
    /**
     * Compact per-source-class mirror of the benchmark summary. Populated
     * from {@link BenchmarkArtifact.byClass} whenever the benchmark artifact
     * is available at report build time. Kept optional so older benchmark
     * files without a `byClass` field still produce a valid report.
     */
    byClass?: Record<
      SourceClass,
      {
        sourceCount: number;
        pageCount: number;
        nodeCount: number;
        godNodeCount: number;
        finalContextTokens: number;
        naiveCorpusTokens: number;
        reductionRatio: number;
      }
    >;
  };
  godNodes: Array<{
    nodeId: string;
    label: string;
    pageId?: string;
    degree?: number;
    bridgeScore?: number;
    /**
     * Deterministic one-line explanation of why the node is surfaced as a
     * god-node — e.g. "degree 42 across 7 communities" or
     * "degree 38 (2.1σ above mean)". Omitted when no degree signal exists.
     */
    surpriseReason?: string;
  }>;
  bridgeNodes: Array<{
    nodeId: string;
    label: string;
    pageId?: string;
    degree?: number;
    bridgeScore?: number;
  }>;
  thinCommunities: Array<{
    id: string;
    label: string;
    nodeCount: number;
    pageId?: string;
    path?: string;
    title?: string;
  }>;
  fragmentedCommunityRollup?: {
    totalCommunities: number;
    rolledUpCount: number;
    rolledUpNodes: number;
    exampleLabels: string[];
  };
  surprisingConnections: Array<{
    id: string;
    sourceNodeId: string;
    sourceLabel: string;
    targetNodeId: string;
    targetLabel: string;
    relation: string;
    evidenceClass: EvidenceClass;
    confidence: number;
    pathNodeIds: string[];
    pathEdgeIds: string[];
    pathRelations: string[];
    pathEvidenceClasses: EvidenceClass[];
    pathSummary: string;
    why: string;
    explanation: string;
  }>;
  groupPatterns: GraphHyperedge[];
  suggestedQuestions: string[];
  communityPages: Array<{
    id: string;
    path: string;
    title: string;
  }>;
  recentResearchSources: Array<{
    pageId: string;
    path: string;
    title: string;
    sourceType: SourceCaptureType;
    updatedAt: string;
  }>;
  contradictions: Array<{
    sourceIdA: string;
    sourceIdB: string;
    claimA: string;
    claimB: string;
    confidenceDelta: number;
  }>;
  communityCohesion?: Array<{ id: string; label: string; nodeCount: number; cohesion: number }>;
  knowledgeGaps?: {
    isolatedNodes: Array<{ nodeId: string; label: string; type: GraphNode["type"] }>;
    thinCommunityCount: number;
    ambiguousEdgeRatio: number;
    warnings: string[];
  };
}

export interface GraphShareArtifact {
  generatedAt: string;
  vaultName: string;
  tagline: string;
  overview: {
    sources: number;
    nodes: number;
    edges: number;
    pages: number;
    communities: number;
  };
  firstPartyOverview: {
    nodes: number;
    edges: number;
    pages: number;
    communities: number;
  };
  highlights: {
    topHubs: Array<{ nodeId: string; label: string; degree?: number }>;
    bridgeNodes: Array<{ nodeId: string; label: string; bridgeScore?: number }>;
    surprisingConnections: Array<{ sourceLabel: string; targetLabel: string; relation: string; why: string }>;
    suggestedQuestions: string[];
  };
  knowledgeGaps: string[];
  shortPost: string;
  relatedNodeIds: string[];
  relatedPageIds: string[];
  relatedSourceIds: string[];
}

export interface GraphShareBundleFile {
  relativePath: string;
  content: string;
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

export interface ScheduledConsolidateTask {
  type: "consolidate";
  dryRun?: boolean;
}

export type ScheduledTaskConfig =
  | ScheduledCompileTask
  | ScheduledLintTask
  | ScheduledQueryTask
  | ScheduledExploreTask
  | ScheduledConsolidateTask;

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
