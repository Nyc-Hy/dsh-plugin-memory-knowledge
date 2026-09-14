import { z } from 'zod'
import type { InvocationDescriptor, RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MemoryUiEvidencePack,
  MemoryUiEvidenceSearchRequest,
  MemoryUiMutationResult,
  MemoryUiGenerateRequest,
  MemoryUiGenerateResult,
  MemoryUiMemoryCreateRequest,
  MemoryUiMemoryMutationResult,
  MemoryUiMemoryStatusRequest,
  MemoryUiMemoryUpdateRequest,
  MemoryUiKnowledgeRevisionSaveRequest,
  MemoryUiKnowledgeRevisionSaveResult,
  MemoryUiOverview,
  MemoryUiOverviewRequest,
  MemoryUiRelationPack,
  MemoryUiRelationQueryRequest,
  MemoryUiPromoteRequest,
  MemoryUiReviewRequest,
  MemoryUiSearchRequest,
  MemoryUiSearchResult,
  MemoryUiSymbolPack,
  MemoryUiSymbolQueryRequest,
  MemoryUiTrace,
  MemoryUiTraceRequest,
  MemoryUiWikiPlanRequest,
  MemoryUiWikiPlanResult,
  MemoryUiWikiTaskRunRequest,
  MemoryUiWikiTaskRunResult,
  MemoryUiWikiTreeRequest,
  MemoryUiWikiTreeResult,
  MemoryUiWikiBudgetsRequest, MemoryUiWikiBudgetsResult,
  MemoryUiWikiBudgetIncreaseRequest, MemoryUiWikiBudgetIncreaseResult,
} from './ui-contract.js'
import {
  KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN,
  KNOWLEDGE_GENERATED_VERSION_ID_PATTERN,
  KNOWLEDGE_HUMAN_REVISION_ID_PATTERN,
  KNOWLEDGE_HUMAN_REVISION_REQUEST_ID_PATTERN,
  MEMORY_ID_PATTERN,
  WIKI_RUN_ID_PATTERN,
  WIKI_PAGE_ID_PATTERN,
  WIKI_TASK_ID_PATTERN,
} from './ids.js'
import { MAX_SOURCE_EVIDENCE_QUERY_CHARS } from './evidence-pack.js'
import { MAX_SOURCE_RELATION_FILTER_CHARS } from './source-relation-query.js'
import { MAX_SOURCE_SYMBOL_FILTER_CHARS } from './source-symbol-query.js'
import { PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'

const PACKAGE_ID = 'dsh-plugin-memory-knowledge'
const SERVICE_KEY = 'memoryKnowledgeUi'
const idSchema = z.string().min(1).max(200)
const workspaceIdSchema = z.string().min(1).max(200)
const portablePathSchema = z.string().max(1_024).regex(new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u'))
const optionalWorkspace = { workspaceId: workspaceIdSchema.optional() }

const workspaceSchema = z.object({ id: workspaceIdSchema, title: z.string() }).strict()
const candidateSchema = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  target: z.enum(['memory', 'knowledge-card']),
  applicability: z.enum(['global', 'project']),
  kind: z.enum(['fact', 'decision', 'lesson', 'method', 'preference', 'constraint', 'overview', 'architecture', 'module', 'flow', 'stack']),
  title: z.string(),
  content: z.string(),
  contentTruncated: z.boolean(),
  tags: z.array(z.string()),
  status: z.enum(['pending', 'accepted', 'rejected', 'promoted']),
  suggestedBy: z.enum(['model', 'human', 'conversation', 'inventory', 'wiki']),
  evidence: z.array(z.string()),
  ...optionalWorkspace,
  workspaceTitle: z.string().optional(),
  updatedAt: z.string(),
}).strict()
const recordSchema = z.object({
  id: idSchema,
  recordType: z.enum(['personal-memory', 'project-memory', 'knowledge-card']),
  title: z.string(),
  content: z.string(),
  contentTruncated: z.boolean(),
  tags: z.array(z.string()),
  evidenceClass: z.enum(['deterministic', 'human-verified', 'ai-suggested']),
  status: z.string(),
  revision: z.number().int().positive().optional(),
  kind: z.enum(['fact', 'decision', 'lesson', 'method', 'preference', 'constraint']).optional(),
  conditions: z.array(z.string()).optional(),
  editable: z.boolean().optional(),
  evidence: z.array(z.string()),
  ...optionalWorkspace,
  workspaceTitle: z.string().optional(),
  updatedAt: z.string(),
}).strict()
const sourceStatusSchema = z.object({
  id: idSchema,
  state: z.enum(['ready', 'degraded']),
  revision: z.string().optional(),
  branch: z.string().optional(),
  dirty: z.boolean(),
  scanMode: z.enum(['full', 'incremental']),
  reusedFileCount: z.number().int().nonnegative(),
  readFileCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  understandingState: z.enum(['missing', 'current', 'stale']),
  sourceRecordCount: z.number().int().nonnegative().optional(),
  sourceEvidenceCount: z.number().int().nonnegative().optional(),
  sourceAreaCount: z.number().int().nonnegative().optional(),
  sourceRelationCount: z.number().int().nonnegative().optional(),
  sourceInternalRelationCount: z.number().int().nonnegative().optional(),
  sourceExternalRelationCount: z.number().int().nonnegative().optional(),
  sourceUnresolvedRelationCount: z.number().int().nonnegative().optional(),
  sourceOmittedRelationCount: z.number().int().nonnegative().optional(),
  sourceSymbolDefinitionCount: z.number().int().nonnegative().optional(),
  sourceSymbolReferenceCount: z.number().int().nonnegative().optional(),
  sourceOmittedSymbolFileCount: z.number().int().nonnegative().optional(),
  sourceOmittedSymbolReferenceCount: z.number().int().nonnegative().optional(),
  sourceSymbolConfigMode: z.enum(['default', 'tsconfig']).optional(),
  sourceSymbolConfigFileCount: z.number().int().nonnegative().optional(),
  sourceSymbolProjectReferenceCount: z.number().int().nonnegative().optional(),
  sourceSymbolPathAliasCount: z.number().int().nonnegative().optional(),
  sourceSymbolConfigDiagnosticCount: z.number().int().nonnegative().optional(),
  sourceOmittedSymbolConfigFileCount: z.number().int().nonnegative().optional(),
  understandingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional(),
}).strict()
const freshnessReasonSchema = z.object({
  kind: z.enum(['canonical-stale', 'source-unavailable', 'file-missing', 'file-changed', 'source-revision-changed']),
  path: portablePathSchema.optional(),
}).strict()
const cardFreshnessSchema = z.object({
  id: idSchema,
  title: z.string(),
  canonicalStatus: z.enum(['verified', 'needs-review', 'stale', 'deprecated']),
  state: z.enum(['fresh', 'stale', 'degraded', 'inactive']),
  reasons: z.array(freshnessReasonSchema),
  omittedReasonCount: z.number().int().nonnegative(),
}).strict()
const projectStatusSchema = z.object({
  sources: z.array(sourceStatusSchema),
  omittedSourceCount: z.number().int().nonnegative(),
  cards: z.array(cardFreshnessSchema),
  omittedCardCount: z.number().int().nonnegative(),
  staleCardCount: z.number().int().nonnegative(),
  degradedCardCount: z.number().int().nonnegative(),
}).strict()
const wikiCoverageSummarySchema = z.object({
  itemCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  analyzing: z.number().int().nonnegative(),
  analyzed: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
}).strict()
const wikiTaskSummarySchema = z.object({
  taskCount: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
}).strict()
const wikiMaterialRangeSummarySchema = z.object({
  rangeCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  analyzedBytes: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
}).strict()
const wikiFileSynthesisSummarySchema = z.object({
  rulesVersion: z.number().int().nonnegative(),
  status: z.enum(['unplanned', 'running', 'complete', 'incomplete', 'unassessed']),
  fileCount: z.number().int().nonnegative(),
  inputClaimCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
  levelCount: z.number().int().nonnegative(),
  completeFileCount: z.number().int().nonnegative(),
  incompleteFileCount: z.number().int().nonnegative().nullable(),
  noReductionFileCount: z.number().int().nonnegative(),
  levelLimitFileCount: z.number().int().nonnegative(),
  limits: z.object({
    maxClaimsPerTask: z.number().int().min(2),
    maxStatementCharactersPerTask: z.number().int().positive(),
    maxLevels: z.number().int().positive(),
  }).strict().nullable(),
}).strict()
const wikiConsistencySummarySchema = z.object({
  rulesVersion: z.number().int().nonnegative(),
  planned: z.boolean(),
  candidatePairCount: z.number().int().nonnegative(),
  candidatePairsComplete: z.boolean(),
  omittedCandidatePairCount: z.number().int().nonnegative().nullable(),
}).strict()
const wikiPageGenerationSummarySchema = z.object({
  rulesVersion: z.number().int().nonnegative(),
  planned: z.boolean(),
  claimCount: z.number().int().nonnegative(),
  taskCount: z.number().int().nonnegative(),
}).strict()
const wikiCompletionCheckSchema = z.object({
  id: z.enum([
    'catalog',
    'coverage',
    'analysis',
    'file-synthesis',
    'verification',
    'consistency',
    'pages',
    'material-exposure',
    'business-questions',
    'cross-module-flows',
  ]),
  state: z.enum(['pass', 'fail', 'unsupported']),
  issueCount: z.number().int().nonnegative(),
}).strict()
const wikiCompletionReportSchema = z.object({
  eligibleForActivation: z.boolean(),
  checks: z.array(wikiCompletionCheckSchema).length(10),
}).strict()
const wikiRunSummarySchema = z.object({
  id: idSchema,
  status: z.enum([
    'planned',
    'analyzing',
    'verifying',
    'synthesizing',
    'needs-review',
    'complete',
    'blocked',
    'failed',
    'cancelled',
  ]),
  catalogHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  catalogComplete: z.boolean(),
  catalogOmittedItemCount: z.number().int().nonnegative().nullable(),
  coverage: wikiCoverageSummarySchema,
  materialRanges: wikiMaterialRangeSummarySchema,
  tasks: wikiTaskSummarySchema,
  fileSynthesis: wikiFileSynthesisSummarySchema,
  consistency: wikiConsistencySummarySchema,
  pageGeneration: wikiPageGenerationSummarySchema,
  completion: wikiCompletionReportSchema,
  rootPageCount: z.number().int().nonnegative(),
  blockingReasons: z.array(z.string().max(2_000)).max(20),
  omittedBlockingReasonCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
}).strict()
const knowledgeVersionSummarySchema = z.object({
  status: z.enum(['draft', 'active']),
  mode: z.enum(['automatic', 'fixed']),
  selectionRevision: z.number().int().positive(),
  analysisGeneration: z.number().int().positive(),
  currentRunId: z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN, 'u')),
  sourceRunId: z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN, 'u')),
  generatedVersionId: z.string().regex(new RegExp(KNOWLEDGE_GENERATED_VERSION_ID_PATTERN, 'u')).optional(),
  effectiveVersionId: z.string().regex(new RegExp(KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN, 'u')).optional(),
  humanRevisionCount: z.number().int().nonnegative(),
}).strict()

const overviewRequestSchema = z.discriminatedUnion('domain', [
  z.object({ domain: z.literal('memory'), ...optionalWorkspace }).strict(),
  z.object({ domain: z.literal('knowledge'), workspaceId: workspaceIdSchema }).strict(),
])
const overviewSchema = z.object({
  workspaces: z.array(workspaceSchema),
  selectedWorkspaceId: workspaceIdSchema.optional(),
  candidates: z.array(candidateSchema),
  records: z.array(recordSchema),
  restrictedCandidateCount: z.number().int().nonnegative(),
  projectStatus: projectStatusSchema.optional(),
  knowledgeVersion: knowledgeVersionSummarySchema.optional(),
  wikiRuns: z.array(wikiRunSummarySchema).max(20).optional(),
  wikiRunHistoryTruncated: z.boolean().optional(),
}).strict()
const wikiPlanRequestSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const wikiPlanResultSchema = z.object({ run: wikiRunSummarySchema }).strict()
const wikiTaskRunRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  dataEgressConfirmed: z.boolean(),
}).strict()
const wikiTaskRunResultSchema = z.object({ run: wikiRunSummarySchema }).strict()
const budgetCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const budgetHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
const budgetTaskIdSchema = z.string().regex(new RegExp(WIKI_TASK_ID_PATTERN, 'u'))
const budgetRunIdSchema = z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN, 'u'))
const wikiBudgetsRequestSchema = z.object({
  workspaceId: workspaceIdSchema, runId: budgetRunIdSchema,
  onlyBlocked: z.boolean(), afterTaskId: budgetTaskIdSchema.optional(),
}).strict()
const wikiBudgetsResultSchema = z.object({
  runId: budgetRunIdSchema,
  items: z.array(z.object({
    taskId: budgetTaskIdSchema,
    kind: z.enum(['analysis', 'file-synthesis', 'verification', 'consistency', 'page']),
    status: z.enum(['planned', 'running', 'succeeded', 'failed', 'cancelled']),
    limitBytes: budgetCount.positive(), reservedBytes: budgetCount, reservationCount: budgetCount,
    blockedReadBytes: budgetCount.nullable(), startedAt: z.string().datetime(),
    startedAtAttempt: budgetCount.positive(), budgetHash: budgetHashSchema,
  }).strict()).max(20),
  nextAfterTaskId: budgetTaskIdSchema.optional(),
}).strict()
const wikiBudgetIncreaseRequestSchema = z.object({
  workspaceId: workspaceIdSchema, runId: budgetRunIdSchema, taskId: budgetTaskIdSchema,
  limitBytes: budgetCount.positive(), expectedBudgetHash: budgetHashSchema,
}).strict()
const wikiBudgetIncreaseResultSchema = z.object({ outcome: z.enum(['updated', 'conflict']) }).strict()
const wikiClaimSourceSchema = z.object({
  role: z.enum(['supports', 'context', 'contradicts']),
  path: portablePathSchema,
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  startByte: z.number().int().nonnegative().optional(),
  endByte: z.number().int().positive().optional(),
}).strict()
const wikiPageClaimSchema = z.object({
  id: idSchema,
  kind: z.enum(['assertion', 'inference', 'unknown']),
  status: z.enum(['proposed', 'verified', 'uncertain', 'conflicted', 'rejected', 'stale']),
  statement: z.string().max(1_000),
  statementTruncated: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
  sources: z.array(wikiClaimSourceSchema).max(8),
  omittedSourceCount: z.number().int().nonnegative(),
  humanReviewPending: z.boolean(),
}).strict()
const knowledgeHumanRevisionBase = {
  id: z.string().regex(new RegExp(KNOWLEDGE_HUMAN_REVISION_ID_PATTERN, 'u')),
  revision: z.number().int().positive(),
  content: z.string().max(20_000),
  createdAt: z.string().datetime(),
}
const knowledgeHumanRevisionSchema = z.discriminatedUnion('kind', [
  z.object({ ...knowledgeHumanRevisionBase, kind: z.literal('replace-page-body'), title: z.string().min(1).max(300) }).strict(),
  z.object({ ...knowledgeHumanRevisionBase, kind: z.literal('append-page-note') }).strict(),
])
const wikiPageNodeSchema = z.object({
  id: idSchema,
  parentId: idSchema.optional(),
  depth: z.number().int().nonnegative(),
  title: z.string().max(200),
  status: z.enum(['draft', 'verified', 'conflicted', 'stale']),
  childCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
  claims: z.array(wikiPageClaimSchema).max(200),
  omittedClaimCount: z.number().int().nonnegative(),
  bodyRevision: knowledgeHumanRevisionSchema.optional(),
  notes: z.array(knowledgeHumanRevisionSchema).max(20),
  omittedNoteCount: z.number().int().nonnegative(),
}).strict()
const wikiTreeRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  runId: z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN, 'u')),
}).strict()
const wikiTreeResultSchema = z.object({
  runId: idSchema,
  pageCount: z.number().int().nonnegative(),
  rootPageIds: z.array(idSchema).max(100),
  pages: z.array(wikiPageNodeSchema).max(100),
  omittedPageCount: z.number().int().nonnegative(),
  omittedClaimCount: z.number().int().nonnegative(),
  omittedSourceCount: z.number().int().nonnegative(),
}).strict()
const knowledgeRevisionSaveRequestBase = {
  workspaceId: workspaceIdSchema,
  requestId: z.string().regex(new RegExp(KNOWLEDGE_HUMAN_REVISION_REQUEST_ID_PATTERN, 'u')),
  expectedSelectionRevision: z.number().int().positive(),
  baseEffectiveVersionId: z.string().regex(new RegExp(KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN, 'u')),
  pageId: z.string().regex(new RegExp(WIKI_PAGE_ID_PATTERN, 'u')),
  content: z.string().trim().min(1).max(20_000),
}
const knowledgeRevisionSaveRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...knowledgeRevisionSaveRequestBase, kind: z.literal('replace-page-body'), title: z.string().trim().min(1).max(300) }).strict(),
  z.object({ ...knowledgeRevisionSaveRequestBase, kind: z.literal('append-page-note') }).strict(),
])
const knowledgeRevisionSaveResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('updated'),
    revision: knowledgeHumanRevisionSchema,
    knowledgeVersion: knowledgeVersionSummarySchema,
  }).strict(),
  z.object({ outcome: z.literal('conflict') }).strict(),
])
const memorySearchQuerySchema = z.string().trim().min(1).max(2_000)
const searchRequestSchema = z.discriminatedUnion('domain', [
  z.object({ domain: z.literal('memory'), query: memorySearchQuerySchema, ...optionalWorkspace }).strict(),
  z.object({ domain: z.literal('knowledge'), query: memorySearchQuerySchema, workspaceId: workspaceIdSchema }).strict(),
])
const searchResultSchema = z.object({ records: z.array(recordSchema) }).strict()
const evidenceSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(MAX_SOURCE_EVIDENCE_QUERY_CHARS),
  workspaceId: workspaceIdSchema,
}).strict()
const evidenceRevisionSchema = z.object({
  sourceId: idSchema,
  revision: z.string(),
  inventoryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  sourceRecordHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict()
const evidenceHitSchema = z.object({
  sourceId: idSchema,
  revision: z.string(),
  path: portablePathSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  area: z.string(),
  artifactKind: z.enum(['code', 'test', 'documentation', 'configuration', 'asset', 'other']),
  language: z.string().optional(),
  kind: z.enum(['code-symbol', 'document-heading']),
  detail: z.string(),
  exported: z.boolean().optional(),
  containerName: z.string().min(1).max(240).optional(),
  name: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict()
const evidencePackSchema = z.object({
  retriever: z.literal('source-evidence-fts'),
  version: z.literal(2),
  query: z.string(),
  totalMatches: z.number().int().nonnegative(),
  omittedHitCount: z.number().int().nonnegative(),
  truncationReasons: z.array(z.enum(['result-limit', 'character-budget'])),
  sourceRevisions: z.array(evidenceRevisionSchema),
  hits: z.array(evidenceHitSchema),
}).strict()
const relationKindSchema = z.enum([
  'import', 'type-import', 're-export', 'type-re-export', 'dynamic-import', 'require', 'import-equals',
])
const relationResolutionSchema = z.enum(['internal', 'external', 'unresolved'])
const relationQueryRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  query: z.string().trim().min(1).max(MAX_SOURCE_RELATION_FILTER_CHARS).optional(),
  area: z.string().trim().min(1).max(MAX_SOURCE_RELATION_FILTER_CHARS).optional(),
  resolution: relationResolutionSchema.optional(),
  kind: relationKindSchema.optional(),
}).strict()
const relationRevisionSchema = z.object({
  sourceId: idSchema,
  revision: z.string(),
  inventoryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  sourceRecordHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  relationProvider: z.string().min(1).max(1_024),
  relationProviderKey: z.string().min(1).max(2_000),
  relationOutputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  graphOmittedEdgeCount: z.number().int().nonnegative(),
}).strict()
const relationEdgeSchema = z.object({
  edgeId: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceId: idSchema,
  revision: z.string(),
  fromPath: portablePathSchema,
  fromContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  toPath: portablePathSchema.optional(),
  specifier: z.string().min(1).max(512),
  kind: relationKindSchema,
  resolution: relationResolutionSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict().superRefine((edge, context) => {
  if ((edge.resolution === 'internal') !== (edge.toPath !== undefined)) {
    context.addIssue({ code: 'custom', message: 'internal relation target is inconsistent' })
  }
  if (edge.endLine < edge.startLine) {
    context.addIssue({ code: 'custom', message: 'relation line range is invalid' })
  }
})
const relationPackSchema = z.object({
  retriever: z.literal('source-relations-sql'),
  version: z.literal(1),
  query: z.string().optional(),
  area: z.string().optional(),
  resolution: relationResolutionSchema.optional(),
  kind: relationKindSchema.optional(),
  totalMatches: z.number().int().nonnegative(),
  omittedEdgeCount: z.number().int().nonnegative(),
  truncationReasons: z.array(z.literal('result-limit')),
  sourceRevisions: z.array(relationRevisionSchema),
  edges: z.array(relationEdgeSchema),
}).strict()
const symbolReferenceKindSchema = z.enum(['import', 'export', 'type', 'value'])
const symbolQueryRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  query: z.string().trim().min(1).max(MAX_SOURCE_SYMBOL_FILTER_CHARS).optional(),
  definitionPath: z.string().trim().min(1).max(MAX_SOURCE_SYMBOL_FILTER_CHARS).optional(),
  referencePath: z.string().trim().min(1).max(MAX_SOURCE_SYMBOL_FILTER_CHARS).optional(),
  referenceKind: symbolReferenceKindSchema.optional(),
}).strict()
const symbolRevisionSchema = z.object({
  sourceId: idSchema,
  revision: z.string().min(1),
  inventoryHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  sourceRecordHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  symbolProvider: z.string().min(1).max(1_024),
  symbolProviderKey: z.string().min(1).max(2_000),
  symbolOutputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  graphOmittedFileCount: z.number().int().nonnegative(),
  graphOmittedReferenceCount: z.number().int().nonnegative(),
  configMode: z.enum(['default', 'tsconfig']),
  configPaths: z.array(portablePathSchema).max(32),
  projectReferenceCount: z.number().int().nonnegative(),
  pathAliasCount: z.number().int().nonnegative(),
  configDiagnosticCount: z.number().int().nonnegative(),
  omittedConfigFileCount: z.number().int().nonnegative(),
}).strict()
const symbolEdgeSchema = z.object({
  referenceId: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceId: idSchema,
  revision: z.string(),
  definitionId: z.string().regex(/^sym_[0-9a-f]{64}$/u),
  symbolName: z.string().min(1).max(240),
  declaration: z.string().min(1).max(240),
  definitionPath: portablePathSchema,
  definitionContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  definitionStartLine: z.number().int().positive(),
  definitionEndLine: z.number().int().positive(),
  referencePath: portablePathSchema,
  referenceContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  referenceKind: symbolReferenceKindSchema,
  referenceStartLine: z.number().int().positive(),
  referenceEndLine: z.number().int().positive(),
}).strict().superRefine((edge, context) => {
  if (edge.definitionEndLine < edge.definitionStartLine || edge.referenceEndLine < edge.referenceStartLine) {
    context.addIssue({ code: 'custom', message: 'symbol line range is invalid' })
  }
})
const symbolPackSchema = z.object({
  retriever: z.literal('source-symbols-sql'),
  version: z.literal(2),
  query: z.string().optional(),
  definitionPath: z.string().optional(),
  referencePath: z.string().optional(),
  referenceKind: symbolReferenceKindSchema.optional(),
  totalMatches: z.number().int().nonnegative(),
  omittedReferenceCount: z.number().int().nonnegative(),
  truncationReasons: z.array(z.literal('result-limit')),
  sourceRevisions: z.array(symbolRevisionSchema),
  edges: z.array(symbolEdgeSchema),
}).strict()
const traceRequestSchema = z.object({ id: idSchema, ...optionalWorkspace }).strict()
const memoryRevisionSchema = z.object({
  revision: z.number().int().positive(),
  kind: z.enum(['created', 'edited', 'deprecated', 'deleted', 'restored']),
  status: z.enum(['active', 'deprecated', 'deleted']),
  title: z.string(),
  updatedAt: z.string(),
}).strict()
const traceSchema = z.object({
  id: idSchema,
  recordType: z.enum(['candidate', 'personal-memory', 'project-memory', 'knowledge-card']),
  title: z.string(),
  content: z.string(),
  contentTruncated: z.boolean(),
  status: z.string(),
  revision: z.number().int().positive().optional(),
  kind: z.enum(['fact', 'decision', 'lesson', 'method', 'preference', 'constraint']).optional(),
  conditions: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  editable: z.boolean().optional(),
  history: z.array(memoryRevisionSchema).max(50).optional(),
  evidence: z.array(z.string()),
  ...optionalWorkspace,
  workspaceTitle: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
}).strict().nullable()
const memoryKindSchema = z.enum(['fact', 'decision', 'lesson', 'method', 'preference', 'constraint'])
const memoryCreateRequestSchema = z.object({
  ...optionalWorkspace,
  kind: memoryKindSchema,
  title: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(20_000),
  conditions: z.array(z.string().trim().min(1).max(500)).max(50),
  tags: z.array(z.string().trim().min(1).max(200)).max(50),
}).strict()
const memoryUpdateRequestSchema = memoryCreateRequestSchema.extend({
  id: z.string().regex(new RegExp(MEMORY_ID_PATTERN, 'u')),
  revision: z.number().int().positive(),
}).strict()
const memoryStatusRequestSchema = z.object({
  id: z.string().regex(new RegExp(MEMORY_ID_PATTERN, 'u')),
  revision: z.number().int().positive(),
  ...optionalWorkspace,
  status: z.enum(['active', 'deprecated', 'deleted']),
}).strict()
const reviewRequestSchema = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  decision: z.enum(['accept', 'reject']),
}).strict()
const promoteRequestSchema = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  ...optionalWorkspace,
}).strict()
const generateRequestSchema = z.object({ workspaceId: workspaceIdSchema }).strict()
const generateResultSchema = z.object({
  candidateCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  sourceRecordCount: z.number().int().nonnegative(),
}).strict()
const mutationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('updated'), candidate: candidateSchema, promotedRecordId: idSchema.optional() }).strict(),
  z.object({ outcome: z.literal('conflict') }).strict(),
])
const memoryMutationSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('updated'), record: recordSchema }).strict(),
  z.object({ outcome: z.literal('conflict') }).strict(),
])

function descriptor(
  method: string,
  requestSymbol: string,
  requestSchema: z.ZodType,
  resultSymbol: string,
  resultSchema: z.ZodType,
  cancellation = false,
): InvocationDescriptor {
  return {
    id: `${PACKAGE_ID}#${SERVICE_KEY}/${method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: { mode: 'strict', typeSymbol: `${PACKAGE_ID}#${requestSymbol}`, schema: requestSchema },
    }],
    ...(cancellation ? { cancellation: { parameter: 'signal' as const } } : {}),
    result: { mode: 'strict', typeSymbol: `${PACKAGE_ID}#${resultSymbol}`, schema: resultSchema },
  }
}

/** Strict descriptors shared by the Host registry and browser Remote mount. */
export const MEMORY_UI_INVOCATIONS: readonly InvocationDescriptor[] = [
  descriptor('overview', 'MemoryUiOverviewRequest', overviewRequestSchema, 'MemoryUiOverview', overviewSchema),
  descriptor('planWiki', 'MemoryUiWikiPlanRequest', wikiPlanRequestSchema, 'MemoryUiWikiPlanResult', wikiPlanResultSchema, true),
  descriptor(
    'runWikiTask',
    'MemoryUiWikiTaskRunRequest',
    wikiTaskRunRequestSchema,
    'MemoryUiWikiTaskRunResult',
    wikiTaskRunResultSchema,
    true,
  ),
  descriptor('wikiTree', 'MemoryUiWikiTreeRequest', wikiTreeRequestSchema, 'MemoryUiWikiTreeResult', wikiTreeResultSchema),
  descriptor('saveKnowledgeRevision', 'MemoryUiKnowledgeRevisionSaveRequest', knowledgeRevisionSaveRequestSchema, 'MemoryUiKnowledgeRevisionSaveResult', knowledgeRevisionSaveResultSchema),
  descriptor('wikiBudgets', 'MemoryUiWikiBudgetsRequest', wikiBudgetsRequestSchema, 'MemoryUiWikiBudgetsResult', wikiBudgetsResultSchema),
  descriptor('increaseWikiBudget', 'MemoryUiWikiBudgetIncreaseRequest', wikiBudgetIncreaseRequestSchema, 'MemoryUiWikiBudgetIncreaseResult', wikiBudgetIncreaseResultSchema),
  descriptor('search', 'MemoryUiSearchRequest', searchRequestSchema, 'MemoryUiSearchResult', searchResultSchema, true),
  descriptor(
    'searchEvidence',
    'MemoryUiEvidenceSearchRequest',
    evidenceSearchRequestSchema,
    'MemoryUiEvidencePack',
    evidencePackSchema,
    true,
  ),
  descriptor(
    'queryRelations',
    'MemoryUiRelationQueryRequest',
    relationQueryRequestSchema,
    'MemoryUiRelationPack',
    relationPackSchema,
    true,
  ),
  descriptor(
    'querySymbols',
    'MemoryUiSymbolQueryRequest',
    symbolQueryRequestSchema,
    'MemoryUiSymbolPack',
    symbolPackSchema,
    true,
  ),
  descriptor('trace', 'MemoryUiTraceRequest', traceRequestSchema, 'MemoryUiTrace', traceSchema),
  descriptor('createMemory', 'MemoryUiMemoryCreateRequest', memoryCreateRequestSchema, 'MemoryUiMemoryMutationResult', memoryMutationSchema),
  descriptor('updateMemory', 'MemoryUiMemoryUpdateRequest', memoryUpdateRequestSchema, 'MemoryUiMemoryMutationResult', memoryMutationSchema),
  descriptor('setMemoryStatus', 'MemoryUiMemoryStatusRequest', memoryStatusRequestSchema, 'MemoryUiMemoryMutationResult', memoryMutationSchema),
  descriptor('review', 'MemoryUiReviewRequest', reviewRequestSchema, 'MemoryUiMutationResult', mutationSchema),
  descriptor('promote', 'MemoryUiPromoteRequest', promoteRequestSchema, 'MemoryUiMutationResult', mutationSchema),
  descriptor('generate', 'MemoryUiGenerateRequest', generateRequestSchema, 'MemoryUiGenerateResult', generateResultSchema),
]

/** Hand-written Host contribution; tree-out packages cannot use the monorepo-only generator inventory. */
export const MEMORY_UI_HOST_CONTRIBUTION = {
  package: PACKAGE_ID,
  face: 'host',
  schemas: [],
  invocations: MEMORY_UI_INVOCATIONS,
  model: { services: [], events: [], objects: [] },
} as const

/** Browser contribution mounted into the shared Typert Remote service. */
export const MEMORY_UI_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: PACKAGE_ID,
  descriptors: MEMORY_UI_INVOCATIONS,
}

interface MemoryKnowledgeUiRemoteNamespace {
  wikiBudgets: (request: MemoryUiWikiBudgetsRequest) => Promise<RemoteResult<MemoryUiWikiBudgetsResult>>
  increaseWikiBudget: (request: MemoryUiWikiBudgetIncreaseRequest) => Promise<RemoteResult<MemoryUiWikiBudgetIncreaseResult>>
  overview: (request: MemoryUiOverviewRequest) => Promise<RemoteResult<MemoryUiOverview>>
  planWiki: (request: MemoryUiWikiPlanRequest) => Promise<RemoteResult<MemoryUiWikiPlanResult>>
  runWikiTask: (request: MemoryUiWikiTaskRunRequest) => Promise<RemoteResult<MemoryUiWikiTaskRunResult>>
  wikiTree: (request: MemoryUiWikiTreeRequest) => Promise<RemoteResult<MemoryUiWikiTreeResult>>
  saveKnowledgeRevision: (request: MemoryUiKnowledgeRevisionSaveRequest) => Promise<RemoteResult<MemoryUiKnowledgeRevisionSaveResult>>
  search: (request: MemoryUiSearchRequest) => Promise<RemoteResult<MemoryUiSearchResult>>
  searchEvidence: (request: MemoryUiEvidenceSearchRequest) => Promise<RemoteResult<MemoryUiEvidencePack>>
  queryRelations: (request: MemoryUiRelationQueryRequest) => Promise<RemoteResult<MemoryUiRelationPack>>
  querySymbols: (request: MemoryUiSymbolQueryRequest) => Promise<RemoteResult<MemoryUiSymbolPack>>
  trace: (request: MemoryUiTraceRequest) => Promise<RemoteResult<MemoryUiTrace | null>>
  createMemory: (request: MemoryUiMemoryCreateRequest) => Promise<RemoteResult<MemoryUiMemoryMutationResult>>
  updateMemory: (request: MemoryUiMemoryUpdateRequest) => Promise<RemoteResult<MemoryUiMemoryMutationResult>>
  setMemoryStatus: (request: MemoryUiMemoryStatusRequest) => Promise<RemoteResult<MemoryUiMemoryMutationResult>>
  review: (request: MemoryUiReviewRequest) => Promise<RemoteResult<MemoryUiMutationResult>>
  promote: (request: MemoryUiPromoteRequest) => Promise<RemoteResult<MemoryUiMutationResult>>
  generate: (request: MemoryUiGenerateRequest) => Promise<RemoteResult<MemoryUiGenerateResult>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'memoryKnowledgeUi/wikiBudgets': MemoryKnowledgeUiRemoteNamespace['wikiBudgets']
    'memoryKnowledgeUi/increaseWikiBudget': MemoryKnowledgeUiRemoteNamespace['increaseWikiBudget']
    'memoryKnowledgeUi/overview': MemoryKnowledgeUiRemoteNamespace['overview']
    'memoryKnowledgeUi/planWiki': MemoryKnowledgeUiRemoteNamespace['planWiki']
    'memoryKnowledgeUi/runWikiTask': MemoryKnowledgeUiRemoteNamespace['runWikiTask']
    'memoryKnowledgeUi/wikiTree': MemoryKnowledgeUiRemoteNamespace['wikiTree']
    'memoryKnowledgeUi/saveKnowledgeRevision': MemoryKnowledgeUiRemoteNamespace['saveKnowledgeRevision']
    'memoryKnowledgeUi/search': MemoryKnowledgeUiRemoteNamespace['search']
    'memoryKnowledgeUi/searchEvidence': MemoryKnowledgeUiRemoteNamespace['searchEvidence']
    'memoryKnowledgeUi/queryRelations': MemoryKnowledgeUiRemoteNamespace['queryRelations']
    'memoryKnowledgeUi/querySymbols': MemoryKnowledgeUiRemoteNamespace['querySymbols']
    'memoryKnowledgeUi/trace': MemoryKnowledgeUiRemoteNamespace['trace']
    'memoryKnowledgeUi/createMemory': MemoryKnowledgeUiRemoteNamespace['createMemory']
    'memoryKnowledgeUi/updateMemory': MemoryKnowledgeUiRemoteNamespace['updateMemory']
    'memoryKnowledgeUi/setMemoryStatus': MemoryKnowledgeUiRemoteNamespace['setMemoryStatus']
    'memoryKnowledgeUi/review': MemoryKnowledgeUiRemoteNamespace['review']
    'memoryKnowledgeUi/promote': MemoryKnowledgeUiRemoteNamespace['promote']
    'memoryKnowledgeUi/generate': MemoryKnowledgeUiRemoteNamespace['generate']
  }
  interface TypertRemoteNamespaceMap {
    memoryKnowledgeUi: MemoryKnowledgeUiRemoteNamespace
  }
}
