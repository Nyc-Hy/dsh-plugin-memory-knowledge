/** One Host workspace projected without its local filesystem path. */
export interface MemoryUiWorkspace {
  id: string
  title: string
}

/** User-visible record domain selected in the memory browser. */
export type MemoryUiRecordDomain = 'memory' | 'knowledge'

/** Review candidate projected for the local memory browser. */
export interface MemoryUiCandidate {
  id: string
  revision: number
  target: 'memory' | 'knowledge-card'
  applicability: 'global' | 'project'
  kind: 'fact' | 'decision' | 'lesson' | 'method' | 'preference' | 'constraint'
    | 'overview' | 'architecture' | 'module' | 'flow' | 'stack'
  title: string
  content: string
  contentTruncated: boolean
  tags: string[]
  status: 'pending' | 'accepted' | 'rejected' | 'promoted'
  suggestedBy: 'model' | 'human' | 'conversation' | 'inventory' | 'wiki'
  evidence: string[]
  workspaceId?: string
  workspaceTitle?: string
  updatedAt: string
}

/** Recallable memory or project knowledge projected for browsing. */
export interface MemoryUiRecord {
  id: string
  recordType: 'personal-memory' | 'project-memory' | 'knowledge-card'
  title: string
  content: string
  contentTruncated: boolean
  tags: string[]
  evidenceClass: 'deterministic' | 'human-verified' | 'ai-suggested'
  status: string
  revision?: number
  kind?: 'fact' | 'decision' | 'lesson' | 'method' | 'preference' | 'constraint'
  conditions?: string[]
  editable?: boolean
  evidence: string[]
  workspaceId?: string
  workspaceTitle?: string
  updatedAt: string
}

/** One source inventory summary projected without its local root or file list. */
export interface MemoryUiSourceStatus {
  id: string
  state: 'ready' | 'degraded'
  revision?: string
  branch?: string
  dirty: boolean
  scanMode: 'full' | 'incremental'
  reusedFileCount: number
  readFileCount: number
  fileCount: number
  totalBytes: number
  issueCount: number
  understandingState: 'missing' | 'current' | 'stale'
  sourceRecordCount?: number
  sourceEvidenceCount?: number
  sourceAreaCount?: number
  sourceRelationCount?: number
  sourceInternalRelationCount?: number
  sourceExternalRelationCount?: number
  sourceUnresolvedRelationCount?: number
  sourceOmittedRelationCount?: number
  sourceSymbolDefinitionCount?: number
  sourceSymbolReferenceCount?: number
  sourceOmittedSymbolFileCount?: number
  sourceOmittedSymbolReferenceCount?: number
  sourceSymbolConfigMode?: 'default' | 'tsconfig'
  sourceSymbolConfigFileCount?: number
  sourceSymbolProjectReferenceCount?: number
  sourceSymbolPathAliasCount?: number
  sourceSymbolConfigDiagnosticCount?: number
  sourceOmittedSymbolConfigFileCount?: number
  understandingHash?: string
}

/** One portable reason that a Knowledge Card is stale or degraded. */
export interface MemoryUiFreshnessReason {
  kind: 'canonical-stale' | 'source-unavailable' | 'file-missing' | 'file-changed' | 'source-revision-changed'
  path?: string
}

/** Effective freshness projected for one Knowledge Card. */
export interface MemoryUiCardFreshness {
  id: string
  title: string
  canonicalStatus: 'verified' | 'needs-review' | 'stale' | 'deprecated'
  state: 'fresh' | 'stale' | 'degraded' | 'inactive'
  reasons: MemoryUiFreshnessReason[]
  omittedReasonCount: number
}

/** Bounded project source and Knowledge Card freshness summary. */
export interface MemoryUiProjectStatus {
  sources: MemoryUiSourceStatus[]
  omittedSourceCount: number
  cards: MemoryUiCardFreshness[]
  omittedCardCount: number
  staleCardCount: number
  degradedCardCount: number
}

/** Exact file-state totals for one browser-visible LLM Wiki run. */
export interface MemoryUiWikiCoverageSummary {
  itemCount: number
  totalBytes: number
  pending: number
  analyzing: number
  analyzed: number
  deferred: number
  excluded: number
  blocked: number
  stale: number
}

/** Durable shard-task totals for one browser-visible LLM Wiki run. */
export interface MemoryUiWikiTaskSummary {
  taskCount: number
  planned: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
}

/** Exact progress for large-file analysis ranges without file paths or model content. */
export interface MemoryUiWikiMaterialRangeSummary {
  rangeCount: number
  totalBytes: number
  analyzedBytes: number
  planned: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
}

/** Bounded cross-range file synthesis summary without Claim text or project paths. */
export interface MemoryUiWikiFileSynthesisSummary {
  rulesVersion: number
  status: 'unplanned' | 'running' | 'complete' | 'incomplete' | 'unassessed'
  fileCount: number
  inputClaimCount: number
  taskCount: number
  levelCount: number
  completeFileCount: number
  incompleteFileCount: number | null
  noReductionFileCount: number
  levelLimitFileCount: number
  limits: { maxClaimsPerTask: number; maxStatementCharactersPerTask: number; maxLevels: number } | null
}

/** Bounded global consistency recall summary without Claim text or project paths. */
export interface MemoryUiWikiConsistencySummary {
  rulesVersion: number
  planned: boolean
  candidatePairCount: number
  candidatePairsComplete: boolean
  omittedCandidatePairCount: number | null
}

/** Bounded Claim-to-Page planning summary without Claim text or project paths. */
export interface MemoryUiWikiPageGenerationSummary {
  rulesVersion: number
  planned: boolean
  claimCount: number
  taskCount: number
}

/** Bounded progress for the fixed project-understanding question set. */
export interface MemoryUiWikiBusinessQuestionSummary {
  state: 'pending' | 'complete' | 'unsupported'
  requiredQuestionCount: number
  analysisTaskCount: number
  completedTaskCount: number
  evidenceFindingCount: number
  unknownFindingCount: number
  notApplicableFindingCount: number
}

/** Browser-safe state of one required project-knowledge activation check. */
export interface MemoryUiWikiCompletionCheck {
  id: 'catalog' | 'coverage' | 'analysis' | 'file-synthesis' | 'verification' | 'consistency' | 'pages'
    | 'material-exposure' | 'business-questions' | 'cross-module-flows'
  state: 'pass' | 'fail' | 'unsupported'
  issueCount: number
}

/** Conservative readiness report for automatic project-knowledge activation. */
export interface MemoryUiWikiCompletionReport {
  eligibleForActivation: boolean
  checks: MemoryUiWikiCompletionCheck[]
}

/** Bounded LLM Wiki run header without project roots, file paths, claims, or model sessions. */
export interface MemoryUiWikiRunSummary {
  id: string
  status: 'planned' | 'analyzing' | 'verifying' | 'synthesizing' | 'needs-review' | 'complete' | 'blocked' | 'failed' | 'cancelled'
  catalogHash: string
  catalogComplete: boolean
  catalogOmittedItemCount: number | null
  coverage: MemoryUiWikiCoverageSummary
  materialRanges: MemoryUiWikiMaterialRangeSummary
  tasks: MemoryUiWikiTaskSummary
  fileSynthesis: MemoryUiWikiFileSynthesisSummary
  consistency: MemoryUiWikiConsistencySummary
  pageGeneration: MemoryUiWikiPageGenerationSummary
  businessQuestions: MemoryUiWikiBusinessQuestionSummary
  completion: MemoryUiWikiCompletionReport
  rootPageCount: number
  blockingReasons: string[]
  omittedBlockingReasonCount: number
  createdAt: string
  updatedAt: string
  completedAt?: string
}

/** Browser-safe project knowledge pointer and immutable version identities. */
export interface MemoryUiKnowledgeVersionSummary {
  status: 'draft' | 'active'
  mode: 'automatic' | 'fixed'
  selectionRevision: number
  analysisGeneration: number
  currentRunId: string
  sourceRunId: string
  generatedVersionId?: string
  effectiveVersionId?: string
  humanRevisionCount: number
}

/** Initial browser snapshot for one personal or project scope. */
export interface MemoryUiOverview {
  workspaces: MemoryUiWorkspace[]
  selectedWorkspaceId?: string
  candidates: MemoryUiCandidate[]
  records: MemoryUiRecord[]
  restrictedCandidateCount: number
  projectStatus?: MemoryUiProjectStatus
  knowledgeVersion?: MemoryUiKnowledgeVersionSummary
  wikiRuns?: MemoryUiWikiRunSummary[]
  wikiRunHistoryTruncated?: boolean
}

/** Select one record domain and one personal or project scope. */
export type MemoryUiOverviewRequest =
  | { domain: 'memory'; workspaceId?: string }
  | { domain: 'knowledge'; workspaceId: string }

/** Request one language-neutral Wiki catalog and durable coverage plan. */
export interface MemoryUiWikiPlanRequest {
  workspaceId: string
}

/** Browser-safe result of planning one Wiki run. */
export interface MemoryUiWikiPlanResult {
  run: MemoryUiWikiRunSummary
}

/** Request execution or resumption of one durable Wiki shard task. */
export interface MemoryUiWikiTaskRunRequest {
  workspaceId: string
  dataEgressConfirmed: boolean
}

/** Browser-safe result after executing at most one Wiki shard task. */
export interface MemoryUiWikiTaskRunResult {
  run: MemoryUiWikiRunSummary
}

/** 浏览器可见的任务预算，不含 Session、项目路径或材料正文。 */
export interface MemoryUiWikiBudget {
  taskId: string
  kind: 'analysis' | 'file-synthesis' | 'verification' | 'consistency' | 'page'
  status: 'planned' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  limitBytes: number
  reservedBytes: number
  reservationCount: number
  blockedReadBytes: number | null
  startedAt: string
  startedAtAttempt: number
  budgetHash: string
}

/** 显式查询一个已注册项目的一页预算。 */
export interface MemoryUiWikiBudgetsRequest {
  workspaceId: string
  runId: string
  onlyBlocked: boolean
  afterTaskId?: string
}

/** 每页最多 20 个已记账任务，不把缺失账本当作零消耗。 */
export interface MemoryUiWikiBudgetsResult {
  runId: string
  items: MemoryUiWikiBudget[]
  nextAfterTaskId?: string
}

/** 人工确认的新总额度及确认时所见账本版本。 */
export interface MemoryUiWikiBudgetIncreaseRequest {
  workspaceId: string
  runId: string
  taskId: string
  limitBytes: number
  expectedBudgetHash: string
}

/** 过期确认不能修改额度；操作者必须刷新后重新确认。 */
export interface MemoryUiWikiBudgetIncreaseResult {
  outcome: 'updated' | 'conflict'
}

/** Request one bounded generated Page tree from a registered project Run. */
export interface MemoryUiWikiTreeRequest {
  workspaceId: string
  runId: string
}

/** Browser-safe relative source location for one Page Claim. */
export interface MemoryUiWikiClaimSource {
  role: 'supports' | 'context' | 'contradicts'
  path: string
  startLine?: number
  endLine?: number
  startByte?: number
  endByte?: number
}

/** Bounded Claim projection retained inside one generated Page. */
export interface MemoryUiWikiPageClaim {
  id: string
  kind: 'assertion' | 'inference' | 'unknown'
  status: 'proposed' | 'verified' | 'uncertain' | 'conflicted' | 'rejected' | 'stale'
  statement: string
  statementTruncated: boolean
  sourceCount: number
  sources: MemoryUiWikiClaimSource[]
  omittedSourceCount: number
  humanReviewPending: boolean
}

/** Browser-safe operator revision shown on one Wiki page. */
export interface MemoryUiKnowledgeHumanRevision {
  id: string
  revision: number
  kind: 'replace-page-body' | 'append-page-note'
  title?: string
  content: string
  createdAt: string
}

/** One flattened Page node with an explicit parent and bounded direct Claims. */
export interface MemoryUiWikiPageNode {
  id: string
  parentId?: string
  depth: number
  title: string
  status: 'draft' | 'verified' | 'conflicted' | 'stale'
  childCount: number
  claimCount: number
  claims: MemoryUiWikiPageClaim[]
  omittedClaimCount: number
  bodyRevision?: MemoryUiKnowledgeHumanRevision
  notes: MemoryUiKnowledgeHumanRevision[]
  omittedNoteCount: number
}

/** Bounded generated Page tree; every omission remains explicit. */
export interface MemoryUiWikiTreeResult {
  runId: string
  pageCount: number
  rootPageIds: string[]
  pages: MemoryUiWikiPageNode[]
  omittedPageCount: number
  omittedClaimCount: number
  omittedSourceCount: number
}

interface MemoryUiKnowledgeRevisionSaveRequestBase {
  workspaceId: string
  requestId: string
  expectedSelectionRevision: number
  baseEffectiveVersionId: string
  pageId: string
  content: string
}

/** Save one explicit operator interpretation of a generated Wiki page. */
export type MemoryUiKnowledgeRevisionSaveRequest = MemoryUiKnowledgeRevisionSaveRequestBase & (
  | { kind: 'replace-page-body'; title: string }
  | { kind: 'append-page-note'; title?: never }
)

/** Knowledge edits use selection and effective-version compare-and-swap checks. */
export type MemoryUiKnowledgeRevisionSaveResult =
  | { outcome: 'updated'; revision: MemoryUiKnowledgeHumanRevision; knowledgeVersion: MemoryUiKnowledgeVersionSummary }
  | { outcome: 'conflict' }

/** Bounded text search in one record domain and one personal or project scope. */
export type MemoryUiSearchRequest =
  | { domain: 'memory'; query: string; workspaceId?: string }
  | { domain: 'knowledge'; query: string; workspaceId: string }

/** Search response rendered by the memory browser. */
export interface MemoryUiSearchResult {
  records: MemoryUiRecord[]
}

/** Browser request for one project-scoped Source evidence pack. */
export interface MemoryUiEvidenceSearchRequest {
  query: string
  workspaceId: string
}

/** One Source revision represented by browser-visible evidence hits. */
export interface MemoryUiEvidenceRevision {
  sourceId: string
  revision: string
  inventoryHash: string
  sourceRecordHash: string
}

/** One portable Source evidence hit without project-root disclosure. */
export interface MemoryUiEvidenceHit {
  sourceId: string
  revision: string
  path: string
  contentHash: string
  area: string
  artifactKind: 'code' | 'test' | 'documentation' | 'configuration' | 'asset' | 'other'
  language?: string
  kind: 'code-symbol' | 'document-heading'
  detail: string
  exported?: boolean
  containerName?: string
  name: string
  startLine: number
  endLine: number
}

/** Structured, bounded Source evidence pack for project visualization. */
export interface MemoryUiEvidencePack {
  retriever: 'source-evidence-fts'
  version: 2
  query: string
  totalMatches: number
  omittedHitCount: number
  truncationReasons: Array<'result-limit' | 'character-budget'>
  sourceRevisions: MemoryUiEvidenceRevision[]
  hits: MemoryUiEvidenceHit[]
}

/** Browser filters for one bounded project relation graph. */
export interface MemoryUiRelationQueryRequest {
  workspaceId: string
  query?: string
  area?: string
  resolution?: 'internal' | 'external' | 'unresolved'
  kind?: 'import' | 'type-import' | 're-export' | 'type-re-export' | 'dynamic-import' | 'require' | 'import-equals'
}

/** One Source revision represented by browser-visible relation edges. */
export interface MemoryUiRelationRevision {
  sourceId: string
  revision: string
  inventoryHash: string
  sourceRecordHash: string
  relationProvider: string
  relationProviderKey: string
  relationOutputHash: string
  graphOmittedEdgeCount: number
}

/** One portable Source relation edge without project-root disclosure. */
export interface MemoryUiRelationEdge {
  edgeId: string
  sourceId: string
  revision: string
  fromPath: string
  fromContentHash: string
  toPath?: string
  specifier: string
  kind: 'import' | 'type-import' | 're-export' | 'type-re-export' | 'dynamic-import' | 'require' | 'import-equals'
  resolution: 'internal' | 'external' | 'unresolved'
  startLine: number
  endLine: number
}

/** Structured, bounded relation graph for project visualization. */
export interface MemoryUiRelationPack {
  retriever: 'source-relations-sql'
  version: 1
  query?: string
  area?: string
  resolution?: 'internal' | 'external' | 'unresolved'
  kind?: MemoryUiRelationEdge['kind']
  totalMatches: number
  omittedEdgeCount: number
  truncationReasons: Array<'result-limit'>
  sourceRevisions: MemoryUiRelationRevision[]
  edges: MemoryUiRelationEdge[]
}

/** Browser filters for bounded project symbol definition/reference edges. */
export interface MemoryUiSymbolQueryRequest {
  workspaceId: string
  query?: string
  definitionPath?: string
  referencePath?: string
  referenceKind?: 'import' | 'export' | 'type' | 'value'
}

/** One Source revision represented by browser-visible symbol references. */
export interface MemoryUiSymbolRevision {
  sourceId: string
  revision: string
  inventoryHash: string
  sourceRecordHash: string
  symbolProvider: string
  symbolProviderKey: string
  symbolOutputHash: string
  graphOmittedFileCount: number
  graphOmittedReferenceCount: number
  configMode: 'default' | 'tsconfig'
  configPaths: string[]
  projectReferenceCount: number
  pathAliasCount: number
  configDiagnosticCount: number
  omittedConfigFileCount: number
}

/** One portable cross-file symbol reference without project-root disclosure. */
export interface MemoryUiSymbolEdge {
  referenceId: string
  sourceId: string
  revision: string
  definitionId: string
  symbolName: string
  declaration: string
  definitionPath: string
  definitionContentHash: string
  definitionStartLine: number
  definitionEndLine: number
  referencePath: string
  referenceContentHash: string
  referenceKind: 'import' | 'export' | 'type' | 'value'
  referenceStartLine: number
  referenceEndLine: number
}

/** Structured, bounded symbol graph for project visualization. */
export interface MemoryUiSymbolPack {
  retriever: 'source-symbols-sql'
  version: 2
  query?: string
  definitionPath?: string
  referencePath?: string
  referenceKind?: MemoryUiSymbolEdge['referenceKind']
  totalMatches: number
  omittedReferenceCount: number
  truncationReasons: Array<'result-limit'>
  sourceRevisions: MemoryUiSymbolRevision[]
  edges: MemoryUiSymbolEdge[]
}

/** Exact record lookup in one personal or project scope. */
export interface MemoryUiTraceRequest {
  id: string
  workspaceId?: string
}

/** Exact normal-sensitivity trace rendered by the browser. */
export interface MemoryUiTrace {
  id: string
  recordType: 'candidate' | 'personal-memory' | 'project-memory' | 'knowledge-card'
  title: string
  content: string
  contentTruncated: boolean
  status: string
  revision?: number
  kind?: 'fact' | 'decision' | 'lesson' | 'method' | 'preference' | 'constraint'
  conditions?: string[]
  tags?: string[]
  editable?: boolean
  history?: MemoryUiMemoryRevision[]
  evidence: string[]
  workspaceId?: string
  workspaceTitle?: string
  createdAt?: string
  updatedAt: string
}

/** Bounded revision header shown in one local memory detail. */
export interface MemoryUiMemoryRevision {
  revision: number
  kind: 'created' | 'edited' | 'deprecated' | 'deleted' | 'restored'
  status: 'active' | 'deprecated' | 'deleted'
  title: string
  updatedAt: string
}

/** Browser request for an explicitly saved personal or project memory. */
export interface MemoryUiMemoryCreateRequest {
  workspaceId?: string
  kind: 'fact' | 'decision' | 'lesson' | 'method' | 'preference' | 'constraint'
  title: string
  content: string
  conditions: string[]
  tags: string[]
}

/** Browser request for one guarded local-memory content revision. */
export interface MemoryUiMemoryUpdateRequest extends MemoryUiMemoryCreateRequest {
  id: string
  revision: number
}

/** Browser request for one guarded local-memory lifecycle transition. */
export interface MemoryUiMemoryStatusRequest {
  id: string
  revision: number
  workspaceId?: string
  status: 'active' | 'deprecated' | 'deleted'
}

/** Result of a direct local-memory save or lifecycle action. */
export type MemoryUiMemoryMutationResult =
  | { outcome: 'updated'; record: MemoryUiRecord }
  | { outcome: 'conflict' }

/** Candidate review request protected by its last observed revision. */
export interface MemoryUiReviewRequest {
  id: string
  revision: number
  decision: 'accept' | 'reject'
}

/** Candidate promotion request protected by its last observed revision. */
export interface MemoryUiPromoteRequest {
  id: string
  revision: number
  workspaceId?: string
}

/** Explicit request to generate deterministic Knowledge Card review candidates. */
export interface MemoryUiGenerateRequest {
  workspaceId: string
}

/** Bounded candidate-generation summary returned to the browser. */
export interface MemoryUiGenerateResult {
  candidateCount: number
  skippedCount: number
  sourceCount: number
  sourceRecordCount: number
}

/** Mutation result separating an applied update from a stale browser snapshot. */
export type MemoryUiMutationResult =
  | { outcome: 'updated'; candidate: MemoryUiCandidate; promotedRecordId?: string }
  | { outcome: 'conflict' }
