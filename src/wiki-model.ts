import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import {
  createWikiRunId,
  KnowledgeSourceId,
  KNOWLEDGE_SOURCE_ID_PATTERN,
  WikiCitationId,
  WIKI_CITATION_ID_PATTERN,
  WikiClaimId,
  WIKI_CLAIM_ID_PATTERN,
  WikiConflictId,
  WIKI_CONFLICT_ID_PATTERN,
  WikiCoverageId,
  WIKI_COVERAGE_ID_PATTERN,
  WikiMaterialRangeId,
  WIKI_MATERIAL_RANGE_ID_PATTERN,
  WikiTaskId,
  WIKI_TASK_ID_PATTERN,
  WikiPageId,
  WIKI_PAGE_ID_PATTERN,
  WikiRunId,
  WIKI_RUN_ID_PATTERN,
} from './ids.js'
import type { ProvenanceRef } from './model.js'
import { assertProvenanceRefs, PORTABLE_RELATIVE_PATH_PATTERN } from './schema.js'

/** Current local LLM Wiki runtime format. */
export const WIKI_RUN_SCHEMA_VERSION = 8 as const

/** Language-neutral metadata budgets for natural Wiki analysis shards. */
export interface WikiShardConfig {
  maxItems: number
  maxBytes: number
}

/** Default shard size keeps one analysis unit bounded before model-specific chunking. */
export const DEFAULT_WIKI_SHARD_CONFIG: WikiShardConfig = {
  maxItems: 80,
  maxBytes: 256 * 1_024,
}

/** Default number of claims assigned to one cross-shard verification task. */
export const DEFAULT_WIKI_VERIFICATION_BATCH_CLAIMS = 16

/** Maximum characters retained in one concise, model-produced Wiki Claim. */
export const MAX_WIKI_CLAIM_STATEMENT_CHARACTERS = 20_000

/** Maximum characters retained in one organizational Wiki Page title. */
export const MAX_WIKI_PAGE_TITLE_CHARACTERS = 200

/** Maximum characters retained in one task-local Wiki Page slug. */
export const MAX_WIKI_PAGE_SLUG_CHARACTERS = 80

/** Version of the language-neutral file-level Claim synthesis rules. */
export const WIKI_FILE_SYNTHESIS_RULES_VERSION = 2

/** Tunable bounds for one file-level synthesis task. */
export interface WikiFileSynthesisConfig {
  maxClaimsPerTask: number
  maxStatementCharactersPerTask: number
  maxLevels: number
}

/** Bounded defaults keep file-level synthesis independent of file size. */
export const DEFAULT_WIKI_FILE_SYNTHESIS_CONFIG: WikiFileSynthesisConfig = {
  maxClaimsPerTask: 16,
  maxStatementCharactersPerTask: 64_000,
  maxLevels: 8,
}

/** Version of the language-neutral global consistency recall rules. */
export const WIKI_CONSISTENCY_RULES_VERSION = 1

/** Tunable bounds for deterministic global consistency candidate recall. */
export interface WikiConsistencyConfig {
  maxClaimsPerTask: number
  maxCandidatePairs: number
  maxClaimsPerRecallKey: number
  maxRecallKeysPerClaim: number
}

/** Bounded defaults for global consistency recall and verification. */
export const DEFAULT_WIKI_CONSISTENCY_CONFIG: WikiConsistencyConfig = {
  maxClaimsPerTask: 12,
  maxCandidatePairs: 256,
  maxClaimsPerRecallKey: 32,
  maxRecallKeysPerClaim: 32,
}

/** Version of the language-neutral Claim-to-Page organization rules. */
export const WIKI_PAGE_RULES_VERSION = 1

/** Tunable bounds for one Claim-to-Page synthesis task. */
export interface WikiPageConfig {
  maxClaimsPerTask: number
  maxStatementCharactersPerTask: number
}

/** Bounded defaults keep Page prompts independent of project size. */
export const DEFAULT_WIKI_PAGE_CONFIG: WikiPageConfig = {
  maxClaimsPerTask: 16,
  maxStatementCharactersPerTask: 64_000,
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u
const PORTABLE_PATH_PATTERN = new RegExp(PORTABLE_RELATIVE_PATH_PATTERN, 'u')

/** Revision identity for one file without requiring its contents to be read. */
export type WikiFileRevision =
  | { kind: 'git-object'; commit: string; objectId: string }
  | { kind: 'content-hash'; contentHash: string }

/** Processing state for one file in a complete project catalog. */
export type WikiCoverageStatus =
  | 'pending'
  | 'analyzing'
  | 'analyzed'
  | 'deferred'
  | 'excluded'
  | 'blocked'
  | 'stale'

/** One language-neutral file entry tracked by a Wiki run. */
export interface WikiCoverageItem {
  id: WikiCoverageId
  runId: WikiRunId
  sourceId: KnowledgeSourceId
  path: string
  byteSize: number
  revision: WikiFileRevision
  area: string
  shardKey: string
  language?: string
  artifactKind?: string
  status: WikiCoverageStatus
  reason?: string
  attemptCount: number
  preparedContentHash?: string
  analyzedContentHash?: string
  analyzedAt?: string
}

/** Exact coverage totals stored with a Wiki run for cheap UI reads. */
export interface WikiCoverageSummary {
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

/** One exact core interval and its bounded context window inside an immutable file. */
export interface WikiMaterialRange {
  id: WikiMaterialRangeId
  coverageId: WikiCoverageId
  ordinal: number
  startByte: number
  endByte: number
  startLine: number
  endLine: number
  contentStartByte: number
  contentEndByte: number
  contentStartLine: number
  contentEndLine: number
  contentHash: string
}

/** Exact progress for large-file material ranges retained in a Wiki run header. */
export interface WikiMaterialRangeSummary {
  rangeCount: number
  totalBytes: number
  analyzedBytes: number
  planned: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
}

/** Auditable planning totals for cross-range file-level Claim synthesis. */
export interface WikiFileSynthesisSummary {
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
  limits: WikiFileSynthesisConfig | null
}

/** 一个文件综合批次的层级、同层位置及终止原因。 */
export interface WikiFileSynthesisTaskState {
  level: number
  batchIndex: number
  batchCount: number
  outcome?: 'complete' | 'no-reduction' | 'level-limit'
}

/** Lifecycle state for one independently resumable Wiki shard task. */
export type WikiTaskStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Recall reason for one possible cross-batch semantic relationship. */
export type WikiConsistencyRecallReason = 'shared-coverage' | 'statement-key'

/** One auditable candidate pair; recall reasons never decide semantic truth. */
export interface WikiConsistencyCandidatePair {
  fingerprint: string
  claimIds: [WikiClaimId, WikiClaimId]
  reasons: WikiConsistencyRecallReason[]
}

/** Project-level recall coverage stored with each Wiki run. */
export interface WikiConsistencySummary {
  rulesVersion: number
  planned: boolean
  candidatePairCount: number
  candidatePairsComplete: boolean
  omittedCandidatePairCount: number | null
}

/** Auditable planning totals for Claim-to-Page synthesis. */
export interface WikiPageGenerationSummary {
  rulesVersion: number
  planned: boolean
  claimCount: number
  taskCount: number
}

/** One bounded shard task owned by exactly one durable Agent Session. */
export interface WikiShardTask {
  id: WikiTaskId
  runId: WikiRunId
  kind: 'analysis' | 'file-synthesis' | 'verification' | 'consistency' | 'page'
  shardKey: string
  coverageIds: WikiCoverageId[]
  claimIds: WikiClaimId[]
  candidatePairs: WikiConsistencyCandidatePair[]
  materialRanges: WikiMaterialRange[]
  fileSynthesis?: WikiFileSynthesisTaskState
  status: WikiTaskStatus
  attemptCount: number
  agentSessionId?: SessionId
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  failure?: string
}

/** Exact task totals stored with a Wiki run for bounded UI reads. */
export interface WikiTaskSummary {
  taskCount: number
  planned: number
  running: number
  succeeded: number
  failed: number
  cancelled: number
}

/** Lifecycle state for one durable LLM Wiki generation. */
export type WikiRunStatus =
  | 'planned'
  | 'analyzing'
  | 'verifying'
  | 'synthesizing'
  | 'needs-review'
  | 'complete'
  | 'blocked'
  | 'failed'
  | 'cancelled'

/** Durable local header for one evidence-constrained Wiki generation. */
export interface WikiRun {
  schemaVersion: typeof WIKI_RUN_SCHEMA_VERSION
  id: WikiRunId
  projectRoot: string
  status: WikiRunStatus
  catalogHash: string
  catalogComplete: boolean
  catalogOmittedItemCount: number | null
  coverage: WikiCoverageSummary
  materialRanges: WikiMaterialRangeSummary
  tasks: WikiTaskSummary
  fileSynthesis: WikiFileSynthesisSummary
  consistency: WikiConsistencySummary
  pageGeneration: WikiPageGenerationSummary
  rootPageIds: WikiPageId[]
  blockingReasons: string[]
  createdAt: string
  updatedAt: string
  completedAt?: string
  failure?: string
}

/** One evidence location used by one or more Wiki claims. */
export interface WikiCitation {
  id: WikiCitationId
  runId: WikiRunId
  role: 'supports' | 'context' | 'contradicts'
  provenance: ProvenanceRef
  rangeId?: WikiMaterialRangeId
  note?: string
}

/** One explicit statement, inference, or unknown retained by a Wiki run. */
export interface WikiClaim {
  id: WikiClaimId
  runId: WikiRunId
  kind: 'assertion' | 'inference' | 'unknown'
  status: 'proposed' | 'verified' | 'uncertain' | 'conflicted' | 'rejected' | 'stale'
  statement: string
  citationIds: WikiCitationId[]
  coverageIds: WikiCoverageId[]
  sourceClaimIds: WikiClaimId[]
  sourceTaskId?: WikiTaskId
}

/** One explicit contradiction between claims or their source evidence. */
export interface WikiConflict {
  id: WikiConflictId
  runId: WikiRunId
  status: 'open' | 'resolved'
  summary: string
  claimIds: WikiClaimId[]
  citationIds: WikiCitationId[]
  resolution?: string
}

/** One Wiki page whose prose is assembled only from referenced claims. */
export interface WikiPage {
  id: WikiPageId
  runId: WikiRunId
  slug: string
  title: string
  status: 'draft' | 'verified' | 'conflicted' | 'stale'
  legacy?: true
  sourceTaskId?: WikiTaskId
  claimIds: WikiClaimId[]
  childPageIds: WikiPageId[]
}

/** Complete auditable state for one local LLM Wiki generation. */
export interface WikiRunSnapshot {
  schemaVersion: typeof WIKI_RUN_SCHEMA_VERSION
  run: WikiRun
  coverage: WikiCoverageItem[]
  tasks: WikiShardTask[]
  citations: WikiCitation[]
  claims: WikiClaim[]
  conflicts: WikiConflict[]
  pages: WikiPage[]
  snapshotHash: string
}

/** Stable identifiers for the checks required before generated Wiki output can become project knowledge. */
export type WikiCompletionCheckId =
  | 'catalog'
  | 'coverage'
  | 'analysis'
  | 'file-synthesis'
  | 'verification'
  | 'consistency'
  | 'pages'
  | 'material-exposure'
  | 'business-questions'
  | 'cross-module-flows'

/** One conservative activation check derived from durable Wiki state. */
export interface WikiCompletionCheck {
  id: WikiCompletionCheckId
  state: 'pass' | 'fail' | 'unsupported'
  issueCount: number
}

/** Host-computed readiness report; unsupported required checks always prevent activation. */
export interface WikiCompletionReport {
  eligibleForActivation: boolean
  checks: WikiCompletionCheck[]
}

/** One catalog entry accepted by the language-neutral Wiki planner. */
export interface WikiCatalogEntry {
  sourceId: KnowledgeSourceId
  path: string
  byteSize: number
  revision: WikiFileRevision
  language?: string
  artifactKind?: string
  shardKey?: string
  preparedMaterial?: {
    contentHash: string
    ranges: Array<Omit<WikiMaterialRange, 'id' | 'coverageId'>>
  }
  disposition?: { status: 'deferred' | 'excluded' | 'blocked'; reason: string }
}

/** Input required to create a durable Wiki coverage plan. */
export interface PlanWikiRunInput {
  projectRoot: string
  catalogHash: string
  catalogComplete: boolean
  catalogOmittedItemCount: number | null
  catalogBlockingReasons?: readonly string[]
  entries: readonly WikiCatalogEntry[]
  now?: string
}

const nonEmpty = z.string().trim().min(1)
const claimStatement = z.string().trim().min(1).max(
  MAX_WIKI_CLAIM_STATEMENT_CHARACTERS,
  `Wiki claim statement exceeds ${MAX_WIKI_CLAIM_STATEMENT_CHARACTERS} characters`,
)
const pageTitle = z.string().trim().min(1).max(
  MAX_WIKI_PAGE_TITLE_CHARACTERS,
  `Wiki Page title exceeds ${MAX_WIKI_PAGE_TITLE_CHARACTERS} characters`,
)
const isoDate = z.string().refine(value => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}, 'must be a canonical ISO timestamp')
const sha256 = z.string().regex(SHA256_PATTERN)
const portablePath = z.string().regex(PORTABLE_PATH_PATTERN)
const absolutePath = z.string().refine(isAbsolute, 'must be an absolute path')
const positiveOrZeroInteger = z.number().int().nonnegative().safe()
const uniqueStrings = <T extends z.ZodType<string>>(schema: T) => z.array(schema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'must contain unique values' })
})

const sourceId = z.string().regex(new RegExp(KNOWLEDGE_SOURCE_ID_PATTERN, 'u')).transform(KnowledgeSourceId)
const runId = z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN, 'u')).transform(WikiRunId)
const coverageId = z.string().regex(new RegExp(WIKI_COVERAGE_ID_PATTERN, 'u')).transform(WikiCoverageId)
const materialRangeId = z.string().regex(new RegExp(WIKI_MATERIAL_RANGE_ID_PATTERN, 'u')).transform(WikiMaterialRangeId)
const taskId = z.string().regex(new RegExp(WIKI_TASK_ID_PATTERN, 'u')).transform(WikiTaskId)
const citationId = z.string().regex(new RegExp(WIKI_CITATION_ID_PATTERN, 'u')).transform(WikiCitationId)
const claimId = z.string().regex(new RegExp(WIKI_CLAIM_ID_PATTERN, 'u')).transform(WikiClaimId)
const conflictId = z.string().regex(new RegExp(WIKI_CONFLICT_ID_PATTERN, 'u')).transform(WikiConflictId)
const pageId = z.string().regex(new RegExp(WIKI_PAGE_ID_PATTERN, 'u')).transform(WikiPageId)
const sessionId = nonEmpty.transform(value => value as SessionId)

const fileRevisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('git-object'),
    commit: z.string().regex(/^[0-9a-f]{7,64}$/u),
    objectId: z.string().regex(/^[0-9a-f]{40,64}$/u),
  }).strict(),
  z.object({
    kind: z.literal('content-hash'),
    contentHash: sha256,
  }).strict(),
])

const coverageStatusSchema = z.enum([
  'pending',
  'analyzing',
  'analyzed',
  'deferred',
  'excluded',
  'blocked',
  'stale',
])

const coverageItemSchema = z.object({
  id: coverageId,
  runId,
  sourceId,
  path: portablePath,
  byteSize: positiveOrZeroInteger,
  revision: fileRevisionSchema,
  area: nonEmpty,
  shardKey: nonEmpty,
  language: nonEmpty.optional(),
  artifactKind: nonEmpty.optional(),
  status: coverageStatusSchema,
  reason: nonEmpty.optional(),
  attemptCount: positiveOrZeroInteger,
  preparedContentHash: sha256.optional(),
  analyzedContentHash: sha256.optional(),
  analyzedAt: isoDate.optional(),
}).strict().superRefine((value, context) => {
  const requiresReason = ['deferred', 'excluded', 'blocked', 'stale'].includes(value.status)
  if (requiresReason !== (value.reason !== undefined)) {
    context.addIssue({ code: 'custom', message: `${value.status} reason is inconsistent` })
  }
  if (value.status === 'analyzed' && (value.analyzedAt === undefined || value.analyzedContentHash === undefined)) {
    context.addIssue({ code: 'custom', message: 'analyzed coverage requires timestamp and content hash' })
  }
  if (value.preparedContentHash !== undefined && value.analyzedContentHash !== undefined
    && value.preparedContentHash !== value.analyzedContentHash) {
    context.addIssue({ code: 'custom', message: 'analyzed content hash does not match the prepared material' })
  }
  if (value.revision.kind === 'content-hash' && value.analyzedContentHash !== undefined
    && value.revision.contentHash !== value.analyzedContentHash) {
    context.addIssue({ code: 'custom', message: 'analyzed content hash does not match the catalog revision' })
  }
})

const coverageSummarySchema = z.object({
  itemCount: positiveOrZeroInteger,
  totalBytes: positiveOrZeroInteger,
  pending: positiveOrZeroInteger,
  analyzing: positiveOrZeroInteger,
  analyzed: positiveOrZeroInteger,
  deferred: positiveOrZeroInteger,
  excluded: positiveOrZeroInteger,
  blocked: positiveOrZeroInteger,
  stale: positiveOrZeroInteger,
}).strict()

const materialRangeSchema = z.object({
  id: materialRangeId,
  coverageId,
  ordinal: positiveOrZeroInteger,
  startByte: positiveOrZeroInteger,
  endByte: positiveOrZeroInteger,
  startLine: z.number().int().positive().safe(),
  endLine: z.number().int().positive().safe(),
  contentStartByte: positiveOrZeroInteger,
  contentEndByte: positiveOrZeroInteger,
  contentStartLine: z.number().int().positive().safe(),
  contentEndLine: z.number().int().positive().safe(),
  contentHash: sha256,
}).strict().superRefine((value, context) => {
  if (value.startByte >= value.endByte || value.contentStartByte > value.startByte
    || value.contentEndByte < value.endByte || value.contentStartByte >= value.contentEndByte) {
    context.addIssue({ code: 'custom', message: 'Wiki material byte range is inconsistent' })
  }
  if (value.startLine > value.endLine || value.contentStartLine > value.startLine
    || value.contentEndLine < value.endLine) {
    context.addIssue({ code: 'custom', message: 'Wiki material line range is inconsistent' })
  }
})

const materialRangeSummarySchema = z.object({
  rangeCount: positiveOrZeroInteger,
  totalBytes: positiveOrZeroInteger,
  analyzedBytes: positiveOrZeroInteger,
  planned: positiveOrZeroInteger,
  running: positiveOrZeroInteger,
  succeeded: positiveOrZeroInteger,
  failed: positiveOrZeroInteger,
  cancelled: positiveOrZeroInteger,
}).strict()

const fileSynthesisConfigSchema = z.object({
  maxClaimsPerTask: positiveOrZeroInteger.refine(value => value >= 2),
  maxStatementCharactersPerTask: positiveOrZeroInteger.refine(value => value >= MAX_WIKI_CLAIM_STATEMENT_CHARACTERS),
  maxLevels: positiveOrZeroInteger.refine(value => value >= 1),
}).strict()

const fileSynthesisSummarySchema = z.object({
  rulesVersion: positiveOrZeroInteger,
  status: z.enum(['unplanned', 'running', 'complete', 'incomplete', 'unassessed']),
  fileCount: positiveOrZeroInteger,
  inputClaimCount: positiveOrZeroInteger,
  taskCount: positiveOrZeroInteger,
  levelCount: positiveOrZeroInteger,
  completeFileCount: positiveOrZeroInteger,
  incompleteFileCount: positiveOrZeroInteger.nullable(),
  noReductionFileCount: positiveOrZeroInteger,
  levelLimitFileCount: positiveOrZeroInteger,
  limits: fileSynthesisConfigSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.rulesVersion !== WIKI_FILE_SYNTHESIS_RULES_VERSION) {
    context.addIssue({ code: 'custom', message: 'Wiki file synthesis rules version is unsupported' })
  }
  const assessed = value.status !== 'unplanned' && value.status !== 'unassessed'
  if (assessed !== (value.limits !== null) || assessed !== (value.incompleteFileCount !== null)) {
    context.addIssue({ code: 'custom', message: 'Wiki 文件综合评估必须记录预算和未完成文件数' })
  }
})

const taskSchema = z.object({
  id: taskId,
  runId,
  kind: z.enum(['analysis', 'file-synthesis', 'verification', 'consistency', 'page']),
  shardKey: nonEmpty,
  coverageIds: uniqueStrings(coverageId),
  claimIds: uniqueStrings(claimId),
  candidatePairs: z.array(z.object({
    fingerprint: sha256,
    claimIds: z.tuple([claimId, claimId]),
    reasons: uniqueStrings(z.enum(['shared-coverage', 'statement-key']))
      .refine(values => values.length > 0, 'a consistency candidate requires a recall reason'),
  }).strict()),
  materialRanges: z.array(materialRangeSchema),
  fileSynthesis: z.object({
    level: positiveOrZeroInteger,
    batchIndex: positiveOrZeroInteger,
    batchCount: positiveOrZeroInteger.refine(value => value >= 1),
    outcome: z.enum(['complete', 'no-reduction', 'level-limit']).optional(),
  }).strict().optional(),
  status: z.enum(['planned', 'running', 'succeeded', 'failed', 'cancelled']),
  attemptCount: positiveOrZeroInteger,
  agentSessionId: sessionId.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
  startedAt: isoDate.optional(),
  completedAt: isoDate.optional(),
  failure: nonEmpty.optional(),
}).strict().superRefine((value, context) => {
  if ((value.kind === 'file-synthesis') !== (value.fileSynthesis !== undefined)) {
    context.addIssue({ code: 'custom', message: '只有文件综合任务必须记录层级信息' })
  }
  if (value.fileSynthesis !== undefined && (value.fileSynthesis.batchIndex >= value.fileSynthesis.batchCount
    || (value.fileSynthesis.outcome !== undefined && value.status !== 'succeeded'))) {
    context.addIssue({ code: 'custom', message: '文件综合批次位置或完成状态不一致' })
  }
  if (value.kind === 'analysis'
    && (value.coverageIds.length === 0 || value.claimIds.length !== 0 || value.candidatePairs.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'a Wiki analysis task requires coverage and no claims' })
  }
  if (value.kind === 'analysis' && value.materialRanges.length > 0
    && (value.materialRanges.length !== 1 || value.coverageIds.length !== 1
      || value.materialRanges[0]?.coverageId !== value.coverageIds[0])) {
    context.addIssue({ code: 'custom', message: 'a ranged Wiki analysis task requires exactly one matching range' })
  }
  if (value.kind !== 'analysis' && value.materialRanges.length !== 0) {
    context.addIssue({ code: 'custom', message: 'only Wiki analysis tasks may own material ranges' })
  }
  if (value.kind === 'file-synthesis'
    && (value.coverageIds.length !== 1 || value.claimIds.length === 0 || value.candidatePairs.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'a Wiki file synthesis task requires one file and input Claims' })
  }
  if (value.kind === 'verification'
    && (value.coverageIds.length === 0 || value.claimIds.length === 0 || value.candidatePairs.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'a Wiki verification task requires claims and coverage' })
  }
  if (value.kind === 'consistency'
    && (value.coverageIds.length === 0 || value.claimIds.length < 2 || value.candidatePairs.length === 0)) {
    context.addIssue({ code: 'custom', message: 'a Wiki consistency task requires candidate pairs, claims, and coverage' })
  }
  if (value.kind === 'page' && (value.claimIds.length === 0 || value.candidatePairs.length !== 0)) {
    context.addIssue({ code: 'custom', message: 'a Wiki Page task requires claims and no candidate pairs' })
  }
  const started = value.status !== 'planned'
  const completed = ['succeeded', 'failed', 'cancelled'].includes(value.status)
  if (started !== (value.agentSessionId !== undefined && value.startedAt !== undefined && value.attemptCount > 0)) {
    context.addIssue({ code: 'custom', message: 'Wiki task start metadata is inconsistent with status' })
  }
  if (completed !== (value.completedAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Wiki task completion timestamp is inconsistent with status' })
  }
  if ((value.status === 'failed') !== (value.failure !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Wiki task failure detail is inconsistent with status' })
  }
})

const taskSummarySchema = z.object({
  taskCount: positiveOrZeroInteger,
  planned: positiveOrZeroInteger,
  running: positiveOrZeroInteger,
  succeeded: positiveOrZeroInteger,
  failed: positiveOrZeroInteger,
  cancelled: positiveOrZeroInteger,
}).strict()

const consistencySummarySchema = z.object({
  rulesVersion: positiveOrZeroInteger,
  planned: z.boolean(),
  candidatePairCount: positiveOrZeroInteger,
  candidatePairsComplete: z.boolean(),
  omittedCandidatePairCount: positiveOrZeroInteger.nullable(),
}).strict().superRefine((value, context) => {
  if (!value.planned && (value.candidatePairCount !== 0 || value.candidatePairsComplete
    || value.omittedCandidatePairCount !== null)) {
    context.addIssue({ code: 'custom', message: 'unplanned Wiki consistency recall cannot report results' })
  }
  if (value.planned && value.rulesVersion !== WIKI_CONSISTENCY_RULES_VERSION) {
    context.addIssue({ code: 'custom', message: 'Wiki consistency rules version is unsupported' })
  }
  if (value.planned && value.candidatePairsComplete !== (value.omittedCandidatePairCount === 0)) {
    context.addIssue({ code: 'custom', message: 'Wiki consistency omissions are inconsistent with recall completeness' })
  }
})

const pageGenerationSummarySchema = z.object({
  rulesVersion: positiveOrZeroInteger,
  planned: z.boolean(),
  claimCount: positiveOrZeroInteger,
  taskCount: positiveOrZeroInteger,
}).strict().superRefine((value, context) => {
  if (!value.planned && (value.claimCount !== 0 || value.taskCount !== 0)) {
    context.addIssue({ code: 'custom', message: 'unplanned Wiki Page generation cannot report work' })
  }
  if (value.planned && value.rulesVersion !== WIKI_PAGE_RULES_VERSION) {
    context.addIssue({ code: 'custom', message: 'Wiki Page rules version is unsupported' })
  }
})

const runSchema = z.object({
  schemaVersion: z.literal(WIKI_RUN_SCHEMA_VERSION),
  id: runId,
  projectRoot: absolutePath,
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
  catalogHash: sha256,
  catalogComplete: z.boolean(),
  catalogOmittedItemCount: positiveOrZeroInteger.nullable(),
  coverage: coverageSummarySchema,
  materialRanges: materialRangeSummarySchema,
  tasks: taskSummarySchema,
  fileSynthesis: fileSynthesisSummarySchema,
  consistency: consistencySummarySchema,
  pageGeneration: pageGenerationSummarySchema,
  rootPageIds: uniqueStrings(pageId),
  blockingReasons: uniqueStrings(nonEmpty),
  createdAt: isoDate,
  updatedAt: isoDate,
  completedAt: isoDate.optional(),
  failure: nonEmpty.optional(),
}).strict().superRefine((value, context) => {
  if ((value.catalogComplete && value.catalogOmittedItemCount !== 0)
    || (!value.catalogComplete && value.catalogOmittedItemCount === 0)) {
    context.addIssue({ code: 'custom', message: 'catalog completeness is inconsistent with omitted item count' })
  }
  if (!value.catalogComplete && !['blocked', 'failed', 'cancelled'].includes(value.status)) {
    context.addIssue({ code: 'custom', message: 'an incomplete catalog cannot be used for Wiki generation' })
  }
  if (value.status === 'blocked' && value.blockingReasons.length === 0) {
    context.addIssue({ code: 'custom', message: 'a blocked Wiki run requires a reason' })
  }
  if (value.status === 'failed' && value.failure === undefined) {
    context.addIssue({ code: 'custom', message: 'a failed Wiki run requires failure detail' })
  }
  if ((value.status === 'complete') !== (value.completedAt !== undefined)) {
    context.addIssue({ code: 'custom', message: 'completedAt is inconsistent with Wiki run status' })
  }
})

const provenanceSchema = z.custom<ProvenanceRef>((value): value is ProvenanceRef => {
  try {
    assertProvenanceRefs([value])
    return true
  } catch {
    return false
  }
}, 'invalid Wiki citation provenance')

const citationSchema = z.object({
  id: citationId,
  runId,
  role: z.enum(['supports', 'context', 'contradicts']),
  provenance: provenanceSchema,
  rangeId: materialRangeId.optional(),
  note: nonEmpty.optional(),
}).strict()

const claimSchema = z.object({
  id: claimId,
  runId,
  kind: z.enum(['assertion', 'inference', 'unknown']),
  status: z.enum(['proposed', 'verified', 'uncertain', 'conflicted', 'rejected', 'stale']),
  statement: claimStatement,
  citationIds: uniqueStrings(citationId),
  coverageIds: uniqueStrings(coverageId),
  sourceClaimIds: uniqueStrings(claimId),
  sourceTaskId: taskId.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === 'unknown' && value.status !== 'uncertain') {
    context.addIssue({ code: 'custom', message: 'unknown claims must remain uncertain' })
  }
  if (value.kind !== 'assertion' && value.status === 'verified') {
    context.addIssue({ code: 'custom', message: 'only source assertions can be verified' })
  }
  if ((value.sourceClaimIds.length > 0) !== (value.sourceTaskId !== undefined)
    || (value.sourceClaimIds.length > 0 && value.kind === 'unknown')) {
    context.addIssue({ code: 'custom', message: '综合声明必须记录来源任务且不能是未知项' })
  }
})

const conflictSchema = z.object({
  id: conflictId,
  runId,
  status: z.enum(['open', 'resolved']),
  summary: nonEmpty,
  claimIds: uniqueStrings(claimId).refine(values => values.length > 0, 'a conflict requires a claim'),
  citationIds: uniqueStrings(citationId).refine(values => values.length >= 2, 'a conflict requires at least two citations'),
  resolution: nonEmpty.optional(),
}).strict().superRefine((value, context) => {
  if ((value.status === 'resolved') !== (value.resolution !== undefined)) {
    context.addIssue({ code: 'custom', message: 'conflict resolution is inconsistent with status' })
  }
})

const pageSchema = z.object({
  id: pageId,
  runId,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: pageTitle,
  status: z.enum(['draft', 'verified', 'conflicted', 'stale']),
  legacy: z.literal(true).optional(),
  sourceTaskId: taskId.optional(),
  claimIds: uniqueStrings(claimId),
  childPageIds: uniqueStrings(pageId),
}).strict()

const snapshotPayloadSchema = z.object({
  schemaVersion: z.literal(WIKI_RUN_SCHEMA_VERSION),
  run: runSchema,
  coverage: z.array(coverageItemSchema),
  tasks: z.array(taskSchema),
  citations: z.array(citationSchema),
  claims: z.array(claimSchema),
  conflicts: z.array(conflictSchema),
  pages: z.array(pageSchema),
}).strict()

const snapshotSchema = snapshotPayloadSchema.extend({ snapshotHash: sha256 }).strict()

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Create an explicit not-yet-planned global consistency summary. */
export function createUnplannedWikiConsistencySummary(): WikiConsistencySummary {
  return {
    rulesVersion: WIKI_CONSISTENCY_RULES_VERSION,
    planned: false,
    candidatePairCount: 0,
    candidatePairsComplete: false,
    omittedCandidatePairCount: null,
  }
}

/** Create an explicit not-yet-planned file-level synthesis summary. */
export function createUnplannedWikiFileSynthesisSummary(): WikiFileSynthesisSummary {
  return {
    rulesVersion: WIKI_FILE_SYNTHESIS_RULES_VERSION,
    status: 'unplanned',
    fileCount: 0,
    inputClaimCount: 0,
    taskCount: 0,
    levelCount: 0,
    completeFileCount: 0,
    incompleteFileCount: null,
    noReductionFileCount: 0,
    levelLimitFileCount: 0,
    limits: null,
  }
}

/** Mark a migrated run whose earlier runtime did not assess file-level synthesis. */
export function createUnassessedWikiFileSynthesisSummary(tasks: readonly WikiShardTask[] = []): WikiFileSynthesisSummary {
  const synthesisTasks = tasks.filter(task => task.kind === 'file-synthesis')
  return {
    ...createUnplannedWikiFileSynthesisSummary(),
    status: 'unassessed',
    fileCount: new Set(synthesisTasks.flatMap(task => task.coverageIds)).size,
    inputClaimCount: synthesisTasks.reduce((total, task) => total + task.claimIds.length, 0),
    taskCount: synthesisTasks.length,
    levelCount: synthesisTasks.length > 0 ? 1 : 0,
  }
}

/** Create an explicit not-yet-planned Claim-to-Page summary. */
export function createUnplannedWikiPageGenerationSummary(): WikiPageGenerationSummary {
  return {
    rulesVersion: WIKI_PAGE_RULES_VERSION,
    planned: false,
    claimCount: 0,
    taskCount: 0,
  }
}

function assertUniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = values.map(value => String(value.id))
  if (new Set(ids).size !== ids.length) throw new Error(`memory-knowledge: duplicate ${label} id`)
}

function citationMatchesCoverage(citation: WikiCitation, item: WikiCoverageItem): boolean {
  const provenance = citation.provenance
  if (provenance.kind !== 'git-file' && provenance.kind !== 'document') return false
  if (provenance.sourceId !== item.sourceId || provenance.path !== item.path) return false
  if (provenance.contentHash !== item.analyzedContentHash) return false
  if (item.revision.kind === 'content-hash') return provenance.contentHash === item.revision.contentHash
  return provenance.kind === 'git-file' && provenance.commit === item.revision.commit
}

function assertPageTree(run: WikiRun, pages: readonly WikiPage[]): void {
  const pageById = new Map(pages.map(page => [String(page.id), page]))
  if (pages.length === 0) {
    if (run.rootPageIds.length !== 0) throw new Error('memory-knowledge: empty Wiki pages must not have roots')
    return
  }
  if (run.rootPageIds.length === 0) throw new Error('memory-knowledge: Wiki pages require at least one root')
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: WikiPageId): void => {
    const key = String(id)
    if (visiting.has(key)) throw new Error('memory-knowledge: Wiki page tree contains a cycle')
    if (visited.has(key)) throw new Error('memory-knowledge: Wiki page tree contains multiple parents')
    const page = pageById.get(key)
    if (page === undefined) throw new Error('memory-knowledge: Wiki page tree references a missing page')
    visiting.add(key)
    for (const childId of page.childPageIds) {
      if (childId === page.id) throw new Error('memory-knowledge: Wiki page cannot contain itself')
      visit(childId)
    }
    visiting.delete(key)
    visited.add(key)
  }
  for (const rootId of run.rootPageIds) visit(rootId)
  if (visited.size !== pages.length) throw new Error('memory-knowledge: Wiki page tree contains an orphan page')
}

function assertSnapshotGraph(snapshot: Omit<WikiRunSnapshot, 'snapshotHash'>): void {
  const runIdValue = String(snapshot.run.id)
  const groups: Array<[string, readonly { id: string; runId: WikiRunId }[]]> = [
    ['coverage', snapshot.coverage],
    ['task', snapshot.tasks],
    ['citation', snapshot.citations],
    ['claim', snapshot.claims],
    ['conflict', snapshot.conflicts],
    ['page', snapshot.pages],
  ]
  for (const [label, values] of groups) {
    assertUniqueIds(values, label)
    if (values.some(value => String(value.runId) !== runIdValue)) {
      throw new Error(`memory-knowledge: ${label} belongs to another Wiki run`)
    }
  }

  const coverageKeys = new Set<string>()
  for (const item of snapshot.coverage) {
    const key = `${item.sourceId}\0${item.path}`
    if (coverageKeys.has(key)) throw new Error('memory-knowledge: duplicate Wiki coverage path')
    coverageKeys.add(key)
    if (item.id !== wikiCoverageId(item.sourceId, item.path)) {
      throw new Error('memory-knowledge: Wiki coverage id does not match its source path')
    }
  }
  const expectedCoverage = summarizeWikiCoverage(snapshot.coverage)
  if (JSON.stringify(snapshot.run.coverage) !== JSON.stringify(expectedCoverage)) {
    throw new Error('memory-knowledge: Wiki coverage summary is inconsistent')
  }
  const expectedTasks = summarizeWikiTasks(snapshot.tasks)
  if (JSON.stringify(snapshot.run.tasks) !== JSON.stringify(expectedTasks)) {
    throw new Error('memory-knowledge: Wiki task summary is inconsistent')
  }
  const expectedMaterialRanges = summarizeWikiMaterialRanges(snapshot.tasks)
  if (JSON.stringify(snapshot.run.materialRanges) !== JSON.stringify(expectedMaterialRanges)) {
    throw new Error('memory-knowledge: Wiki material range summary is inconsistent')
  }

  const coverageById = new Map(snapshot.coverage.map(value => [String(value.id), value]))
  const claimById = new Map(snapshot.claims.map(value => [String(value.id), value]))
  const citationById = new Map(snapshot.citations.map(value => [String(value.id), value]))
  const taskCoverageIds = new Set<string>()
  const fileSynthesisClaimIds = new Set<string>()
  const verificationClaimIds = new Set<string>()
  const consistencyClaimIds = new Set<string>()
  const pageClaimIds = new Set<string>()
  const taskShardKeys = new Set<string>()
  const materialRangeById = new Map<string, { range: WikiMaterialRange; task: WikiShardTask }>()
  const rangeTasksByCoverage = new Map<string, WikiShardTask[]>()
  for (const task of snapshot.tasks) {
    if (task.id !== wikiTaskId(task.runId, task.shardKey)) {
      throw new Error('memory-knowledge: Wiki task id does not match its run and shard')
    }
    if (taskShardKeys.has(task.shardKey)) throw new Error('memory-knowledge: duplicate Wiki task shard')
    taskShardKeys.add(task.shardKey)
    const taskCoverage = task.coverageIds.map(id => coverageById.get(String(id)))
    if (taskCoverage.some(item => item === undefined)) {
      throw new Error('memory-knowledge: Wiki task references missing project coverage')
    }
    if (task.kind === 'analysis' && task.materialRanges.length === 0
      && taskCoverage.some(item => item?.shardKey !== task.shardKey)) {
      throw new Error('memory-knowledge: Wiki task spans multiple shards')
    }
    if (task.kind === 'analysis' && task.materialRanges.length === 0) {
      for (const id of task.coverageIds) {
        if (taskCoverageIds.has(String(id))) throw new Error('memory-knowledge: Wiki coverage belongs to multiple analysis tasks')
        taskCoverageIds.add(String(id))
      }
    } else if (task.kind === 'analysis') {
      const range = task.materialRanges[0]!
      const coverageKey = String(range.coverageId)
      taskCoverageIds.add(coverageKey)
      if (range.id !== wikiMaterialRangeId(range.coverageId, range.ordinal, range.startByte, range.endByte)) {
        throw new Error('memory-knowledge: Wiki material range id does not match its Coverage interval')
      }
      if (materialRangeById.has(String(range.id))) throw new Error('memory-knowledge: duplicate Wiki material range id')
      materialRangeById.set(String(range.id), { range, task })
      const rangeTasks = rangeTasksByCoverage.get(coverageKey) ?? []
      rangeTasks.push(task)
      rangeTasksByCoverage.set(coverageKey, rangeTasks)
    } else {
      const claims = task.claimIds.map(id => claimById.get(String(id)))
      if (claims.some(claim => claim === undefined)) {
        throw new Error('memory-knowledge: Wiki task references a missing claim')
      }
      const expectedCoverageIds = new Set(claims.flatMap(claim => claim?.coverageIds.map(String) ?? []))
      if (expectedCoverageIds.size !== task.coverageIds.length
        || task.coverageIds.some(id => !expectedCoverageIds.has(String(id)))) {
        throw new Error('memory-knowledge: Wiki task coverage does not match its claims')
      }
      if (task.kind === 'page' && claims.some(claim => claim?.status === 'rejected' || claim?.status === 'stale')) {
        throw new Error('memory-knowledge: Wiki Page tasks cannot organize rejected or stale Claims')
      }
      const assignedClaims = task.kind === 'file-synthesis'
        ? fileSynthesisClaimIds
        : task.kind === 'verification'
          ? verificationClaimIds
          : task.kind === 'consistency'
            ? consistencyClaimIds
            : pageClaimIds
      for (const id of task.claimIds) {
        const key = task.kind === 'file-synthesis' ? `${task.fileSynthesis!.level}:${id}` : String(id)
        if (assignedClaims.has(key)) {
          throw new Error(`memory-knowledge: Wiki claim belongs to multiple ${task.kind} tasks`)
        }
        assignedClaims.add(key)
      }
      if (task.kind === 'file-synthesis'
        && (taskCoverage[0]?.preparedContentHash === undefined
          || (task.fileSynthesis!.level === 0 && claims.some(claim => claim?.sourceClaimIds.length !== 0)))) {
        throw new Error('memory-knowledge: Wiki 首层文件综合必须来自分区原始声明')
      }
      if (task.kind === 'consistency') {
        const candidateClaimIds = new Set<string>()
        const fingerprints = new Set<string>()
        for (const pair of task.candidatePairs) {
          const [leftClaimId, rightClaimId] = pair.claimIds
          const leftId = String(leftClaimId)
          const rightId = String(rightClaimId)
          if (compareText(leftId, rightId) >= 0 || !task.claimIds.includes(pair.claimIds[0])
            || !task.claimIds.includes(pair.claimIds[1])) {
            throw new Error('memory-knowledge: Wiki consistency candidate Claim ids are invalid')
          }
          if (fingerprints.has(pair.fingerprint)) {
            throw new Error('memory-knowledge: duplicate Wiki consistency candidate fingerprint')
          }
          const left = claimById.get(leftId)!
          const right = claimById.get(rightId)!
          const expected = wikiConsistencyPairFingerprint(pair.claimIds, pair.reasons, [left, right], snapshot.citations, snapshot.coverage)
          if (pair.fingerprint !== expected) {
            throw new Error('memory-knowledge: Wiki consistency candidate fingerprint is stale')
          }
          fingerprints.add(pair.fingerprint)
          candidateClaimIds.add(leftId)
          candidateClaimIds.add(rightId)
        }
        if (candidateClaimIds.size !== task.claimIds.length
          || task.claimIds.some(id => !candidateClaimIds.has(String(id)))) {
          throw new Error('memory-knowledge: Wiki consistency task Claims do not match its candidate pairs')
        }
      }
    }
    if (task.kind === 'analysis' && task.status === 'succeeded'
      && taskCoverage.some(item => task.materialRanges.length > 0
        ? item?.status !== 'analyzing' && item?.status !== 'analyzed'
        : item?.status !== 'analyzed' && item?.status !== 'deferred')) {
      throw new Error('memory-knowledge: a succeeded Wiki task requires analyzed or explicitly deferred coverage')
    }
  }
  for (const [coverageKey, rangeTasks] of rangeTasksByCoverage) {
    const item = coverageById.get(coverageKey)!
    if (item.preparedContentHash === undefined) {
      throw new Error('memory-knowledge: ranged Wiki coverage requires a prepared content hash')
    }
    const ranges = rangeTasks.map(task => task.materialRanges[0]!)
      .sort((left, right) => left.ordinal - right.ordinal)
    let nextByte = 0
    for (const [index, range] of ranges.entries()) {
      if (range.ordinal !== index || range.startByte !== nextByte || range.endByte > item.byteSize) {
        throw new Error('memory-knowledge: Wiki material ranges do not exactly partition Coverage bytes')
      }
      nextByte = range.endByte
    }
    if (nextByte !== item.byteSize) {
      throw new Error('memory-knowledge: Wiki material ranges do not cover the complete file')
    }
    const allSucceeded = rangeTasks.every(task => task.status === 'succeeded')
    if (allSucceeded !== (item.status === 'analyzed')) {
      throw new Error('memory-knowledge: ranged Wiki Coverage status does not match its tasks')
    }
    if (item.status === 'analyzed' && item.analyzedContentHash !== item.preparedContentHash) {
      throw new Error('memory-knowledge: ranged Wiki Coverage hash does not match its prepared material')
    }
  }
  for (const item of snapshot.coverage) {
    if (item.preparedContentHash !== undefined && !rangeTasksByCoverage.has(String(item.id))) {
      throw new Error('memory-knowledge: prepared Wiki Coverage is missing material ranges')
    }
  }
  const claimedCoverageIds = new Set(snapshot.claims.flatMap(claim => claim.coverageIds.map(String)))
  const expectedTaskCoverageIds = new Set(snapshot.coverage
    .filter(item => ['pending', 'analyzing'].includes(item.status)
      || (item.status === 'analyzed'
        && (!claimedCoverageIds.has(String(item.id)) || taskCoverageIds.has(String(item.id)))))
    .map(item => String(item.id)))
  if (snapshot.run.status === 'blocked') {
    if (snapshot.tasks.length !== 0) throw new Error('memory-knowledge: a blocked Wiki run must not schedule tasks')
  } else if (taskCoverageIds.size !== expectedTaskCoverageIds.size
    || [...taskCoverageIds].some(id => !expectedTaskCoverageIds.has(id))) {
    throw new Error('memory-knowledge: Wiki tasks do not cover every analyzable catalog item')
  }
  const analysisTasks = snapshot.tasks.filter(task => task.kind === 'analysis')
  const fileSynthesisTasks = snapshot.tasks.filter(task => task.kind === 'file-synthesis')
  const verificationTasks = snapshot.tasks.filter(task => task.kind === 'verification')
  const consistencyTasks = snapshot.tasks.filter(task => task.kind === 'consistency')
  const pageTasks = snapshot.tasks.filter(task => task.kind === 'page')
  const analysisComplete = analysisTasks.length > 0
    ? analysisTasks.every(task => task.status === 'succeeded')
    : snapshot.coverage.every(item => !['pending', 'analyzing'].includes(item.status))
  const fileSynthesisComplete = ['complete', 'incomplete', 'unassessed'].includes(snapshot.run.fileSynthesis.status)
    && fileSynthesisTasks.every(task => task.status === 'succeeded')
  const verificationComplete = verificationTasks.every(task => task.status === 'succeeded')
  const activeClaims = activeWikiClaims(snapshot.claims)
  const expectedVerificationClaimIds = new Set(activeClaims
    .filter(claim => claim.kind !== 'unknown')
    .map(claim => String(claim.id)))
  assertFileSynthesisGraph(snapshot)
  if (!analysisComplete && fileSynthesisTasks.length !== 0) {
    throw new Error('memory-knowledge: Wiki file synthesis cannot start before analysis completes')
  }
  if (!analysisComplete && verificationTasks.length !== 0) {
    throw new Error('memory-knowledge: Wiki verification cannot start before analysis completes')
  }
  if (!fileSynthesisComplete && verificationTasks.length !== 0) {
    throw new Error('memory-knowledge: Wiki verification cannot start before file synthesis completes')
  }
  if (verificationTasks.length > 0 && (verificationClaimIds.size !== expectedVerificationClaimIds.size
    || [...verificationClaimIds].some(id => !expectedVerificationClaimIds.has(id)))) {
    throw new Error('memory-knowledge: Wiki verification tasks do not cover every verifiable claim')
  }
  if (!verificationComplete && consistencyTasks.length !== 0) {
    throw new Error('memory-knowledge: Wiki consistency recall cannot start before Claim verification completes')
  }
  const consistencyPairCount = consistencyTasks.reduce((total, task) => total + task.candidatePairs.length, 0)
  if (snapshot.run.consistency.candidatePairCount !== consistencyPairCount) {
    throw new Error('memory-knowledge: Wiki consistency candidate summary is inconsistent')
  }
  if (!snapshot.run.consistency.planned && consistencyTasks.length !== 0) {
    throw new Error('memory-knowledge: unplanned Wiki consistency recall cannot schedule tasks')
  }
  const consistencyComplete = snapshot.run.consistency.planned
    && consistencyTasks.every(task => task.status === 'succeeded')
  if (pageTasks.length > 0 && !consistencyComplete) {
    throw new Error('memory-knowledge: Wiki Page generation cannot start before global consistency completes')
  }
  const eligiblePageClaimIds = new Set(activeClaims
    .filter(claim => claim.status !== 'rejected' && claim.status !== 'stale')
    .map(claim => String(claim.id)))
  if (snapshot.run.pageGeneration.taskCount !== pageTasks.length
    || snapshot.run.pageGeneration.claimCount !== pageClaimIds.size) {
    throw new Error('memory-knowledge: Wiki Page generation summary is inconsistent')
  }
  if (!snapshot.run.pageGeneration.planned && pageTasks.length !== 0) {
    throw new Error('memory-knowledge: unplanned Wiki Page generation cannot schedule tasks')
  }
  if (snapshot.run.pageGeneration.planned
    && (pageClaimIds.size !== eligiblePageClaimIds.size
      || [...pageClaimIds].some(id => !eligiblePageClaimIds.has(id)))) {
    throw new Error('memory-knowledge: Wiki Page tasks do not cover every eligible Claim')
  }
  if (snapshot.run.status === 'synthesizing'
    && (!snapshot.run.pageGeneration.planned || pageTasks.every(task => task.status === 'succeeded'))) {
    throw new Error('memory-knowledge: synthesizing Wiki runs require unfinished Page tasks')
  }
  if (['synthesizing', 'needs-review', 'complete'].includes(snapshot.run.status)
    && (!snapshot.run.consistency.planned || consistencyTasks.some(task => task.status !== 'succeeded'))) {
    throw new Error('memory-knowledge: reviewed Wiki runs require completed global consistency recall')
  }
  if (['needs-review', 'complete'].includes(snapshot.run.status)
    && (!snapshot.run.pageGeneration.planned || pageTasks.some(task => task.status !== 'succeeded'))) {
    throw new Error('memory-knowledge: reviewed Wiki runs require completed Page generation')
  }
  if (snapshot.run.status === 'analyzing' && analysisComplete && fileSynthesisComplete) {
    throw new Error('memory-knowledge: analyzing Wiki runs require unfinished analysis or file synthesis')
  }
  const conflictByClaim = new Map<string, WikiConflict[]>()
  for (const citation of snapshot.citations) {
    if (citation.rangeId === undefined) continue
    const ranged = materialRangeById.get(String(citation.rangeId))
    if (ranged === undefined) throw new Error('memory-knowledge: Wiki Citation references a missing material range')
    const item = coverageById.get(String(ranged.range.coverageId))!
    const provenance = citation.provenance
    if (provenance.kind !== 'git-file' && provenance.kind !== 'document') {
      throw new Error('memory-knowledge: Wiki Citation does not match its material range')
    }
    if (provenance.sourceId !== item.sourceId || provenance.path !== item.path
      || provenance.contentHash !== item.preparedContentHash) {
      throw new Error('memory-knowledge: Wiki Citation does not match its material range')
    }
    if (provenance.kind === 'git-file' && provenance.startLine !== undefined
      && (provenance.startLine < ranged.range.contentStartLine
        || provenance.endLine === undefined || provenance.endLine > ranged.range.contentEndLine)) {
      throw new Error('memory-knowledge: Wiki Citation line interval exceeds its material range')
    }
  }
  for (const conflict of snapshot.conflicts) {
    const citations = conflict.citationIds.map(id => citationById.get(String(id)))
    if (citations.some(value => value === undefined)) throw new Error('memory-knowledge: conflict references a missing citation')
    const conflictCoverage = new Map<string, WikiCoverageItem>()
    for (const id of conflict.claimIds) {
      const claim = claimById.get(String(id))
      if (claim === undefined) throw new Error('memory-knowledge: conflict references a missing claim')
      if (conflict.status === 'open' && claim.status !== 'conflicted') {
        throw new Error('memory-knowledge: an open conflict requires conflicted claims')
      }
      for (const coverage of claim.coverageIds) {
        const item = coverageById.get(String(coverage))
        if (item === undefined) throw new Error('memory-knowledge: conflict claim references missing project coverage')
        conflictCoverage.set(String(item.id), item)
      }
      const entries = conflictByClaim.get(String(id)) ?? []
      entries.push(conflict)
      conflictByClaim.set(String(id), entries)
    }
    const coverage = [...conflictCoverage.values()]
    if (!citations.some(value => value?.role === 'supports' && coverage.some(item => citationMatchesCoverage(value, item)))
      || !citations.some(value => value?.role === 'contradicts' && coverage.some(item => citationMatchesCoverage(value, item)))) {
      throw new Error('memory-knowledge: conflict requires catalog-backed supporting and contradicting evidence')
    }
  }
  const consumedSourceClaimIds = new Set<string>()
  for (const claim of snapshot.claims) {
    const citations = claim.citationIds.map(id => citationById.get(String(id)))
    if (citations.some(value => value === undefined)) throw new Error('memory-knowledge: claim references a missing citation')
    const coverage = claim.coverageIds.map(id => coverageById.get(String(id)))
    if (coverage.some(value => value === undefined)) throw new Error('memory-knowledge: claim references missing project coverage')
    const projectCoverage = coverage.filter(value => value !== undefined)
    if (claim.kind !== 'unknown' && projectCoverage.length === 0) {
      throw new Error('memory-knowledge: an assertion or inference requires project coverage')
    }
    const hasCatalogSupport = citations.some(value => {
      if (value?.role !== 'supports') return false
      if (projectCoverage.some(item => citationMatchesCoverage(value, item))) return true
      if (value.rangeId === undefined) return false
      const ranged = materialRangeById.get(String(value.rangeId))
      if (ranged?.task.status !== 'succeeded') return false
      const item = coverageById.get(String(ranged.range.coverageId))
      const provenance = value.provenance
      if (provenance.kind !== 'git-file' && provenance.kind !== 'document') return false
      return item !== undefined && projectCoverage.includes(item)
        && item.preparedContentHash === provenance.contentHash
        && provenance.sourceId === item.sourceId && provenance.path === item.path
    })
    if (claim.kind !== 'unknown' && projectCoverage.some(item => item.status !== 'analyzed')
      && !citations.some(value => value?.rangeId !== undefined
        && materialRangeById.get(String(value.rangeId))?.task.status === 'succeeded')) {
      throw new Error('memory-knowledge: an assertion or inference requires analyzed project coverage or a completed range')
    }
    if (claim.kind !== 'unknown' && !hasCatalogSupport) {
      throw new Error('memory-knowledge: an assertion or inference requires catalog-backed supporting evidence')
    }
    if (claim.sourceClaimIds.length > 0) {
      const sources = claim.sourceClaimIds.map(id => claimById.get(String(id)))
      if (sources.some(source => source === undefined || source.kind === 'unknown' || source.status !== 'proposed')) {
        throw new Error('memory-knowledge: synthesized Wiki Claims require proposed source Claims')
      }
      if (claim.sourceClaimIds.some(id => String(id) === String(claim.id)
        || consumedSourceClaimIds.has(String(id)))) {
        throw new Error('memory-knowledge: a source Wiki Claim can be consumed by only one synthesized Claim')
      }
      const sourceIds = new Set(claim.sourceClaimIds.map(String))
      const sourceTask = fileSynthesisTasks.find(task => task.id === claim.sourceTaskId && task.status === 'succeeded'
        && sourceIds.size >= 2 && [...sourceIds].every(id => task.claimIds.some(taskId => String(taskId) === id)))
      if (sourceTask === undefined || claim.coverageIds.length !== 1
        || claim.coverageIds[0] !== sourceTask.coverageIds[0]) {
        throw new Error('memory-knowledge: synthesized Wiki Claim does not match a completed file synthesis task')
      }
      if (sources.some(source => source!.sourceTaskId !== undefined
        && (fileSynthesisTasks.find(task => task.id === source!.sourceTaskId)?.fileSynthesis?.level ?? Infinity)
          >= sourceTask.fileSynthesis!.level)) {
        throw new Error('memory-knowledge: 综合声明来源必须来自更低层，不能循环引用')
      }
      const allowedCitationIds = new Set(sources.flatMap(source => source!.citationIds.map(String)))
      if (claim.citationIds.some(id => !allowedCitationIds.has(String(id)))) {
        throw new Error('memory-knowledge: synthesized Wiki Claim may only reuse source Claim Citations')
      }
      const selectedSupports = claim.citationIds.map(id => citationById.get(String(id)))
        .filter((citation): citation is WikiCitation => citation?.role === 'supports')
      if (sources.some(source => source!.sourceClaimIds.length > 0 && source!.citationIds.some(id =>
        citationById.get(String(id))?.role === 'supports' && !claim.citationIds.includes(id)))) {
        throw new Error('memory-knowledge: 递归综合必须继承来源综合声明的全部支持引用')
      }
      if (sources.some(source => !source!.citationIds.some(id => selectedSupports.some(citation => citation.id === id)))
        || new Set(selectedSupports.flatMap(citation => citation.rangeId === undefined ? [] : [String(citation.rangeId)])).size < 2) {
        throw new Error('memory-knowledge: synthesized Wiki Claim requires supporting evidence from every source and two ranges')
      }
      if (claim.kind === 'assertion' && sources.some(source => source!.kind !== 'assertion')) {
        throw new Error('memory-knowledge: file synthesis cannot upgrade an inference to an assertion')
      }
      for (const id of claim.sourceClaimIds) consumedSourceClaimIds.add(String(id))
    }
    if (claim.status === 'conflicted'
      && !(conflictByClaim.get(String(claim.id)) ?? []).some(conflict => conflict.status === 'open')) {
      throw new Error('memory-knowledge: a conflicted claim requires an open conflict')
    }
  }

  const legacyPages = snapshot.pages.filter(page => page.legacy === true)
  const activePages = snapshot.pages.filter(page => page.legacy !== true)
  const legacyPageIds = new Set(legacyPages.map(page => String(page.id)))
  for (const page of legacyPages) {
    if (page.status !== 'stale' || page.sourceTaskId !== undefined
      || page.claimIds.some(id => !claimById.has(String(id)))
      || page.childPageIds.some(id => !legacyPageIds.has(String(id)))) {
      throw new Error('memory-knowledge: preserved legacy Wiki Page is inconsistent')
    }
  }
  if (!snapshot.run.pageGeneration.planned && (activePages.length !== 0 || snapshot.run.rootPageIds.length !== 0)) {
    throw new Error('memory-knowledge: unplanned Wiki Page generation cannot retain pages')
  }
  const taskByKey = new Map(snapshot.tasks.map(task => [String(task.id), task]))
  const pageById = new Map(activePages.map(page => [String(page.id), page]))
  const pagesByTask = new Map<string, WikiPage[]>()
  const pageClaims = new Set<string>()
  const syntheticPages: WikiPage[] = []
  for (const page of activePages) {
    const claims = page.claimIds.map(id => claimById.get(String(id)))
    if (claims.some(value => value === undefined)) throw new Error('memory-knowledge: Wiki page references a missing claim')
    for (const claimIdValue of page.claimIds) {
      if (pageClaims.has(String(claimIdValue))) {
        throw new Error('memory-knowledge: a Wiki Claim cannot belong to multiple Pages')
      }
      pageClaims.add(String(claimIdValue))
    }
    if (page.sourceTaskId === undefined) {
      syntheticPages.push(page)
      if (!page.slug.startsWith('overview-') || page.claimIds.length !== 0) {
        throw new Error('memory-knowledge: the synthetic Wiki root may only organize generated child Pages')
      }
      continue
    }
    const sourceTask = taskByKey.get(String(page.sourceTaskId))
    if (sourceTask?.kind !== 'page' || sourceTask.status !== 'succeeded') {
      throw new Error('memory-knowledge: Wiki Page source task is not a completed Page task')
    }
    if (page.claimIds.some(id => !sourceTask.claimIds.includes(id))) {
      throw new Error('memory-knowledge: Wiki Page references a Claim outside its source task')
    }
    if (page.childPageIds.some(id => pageById.get(String(id))?.sourceTaskId !== page.sourceTaskId)) {
      throw new Error('memory-knowledge: only the synthetic Wiki root can join different Page tasks')
    }
    const values = pagesByTask.get(String(page.sourceTaskId)) ?? []
    values.push(page)
    pagesByTask.set(String(page.sourceTaskId), values)
  }
  assertPageTree(snapshot.run, activePages)

  const taskRoots: WikiPageId[] = []
  for (const task of pageTasks) {
    const taskPages = pagesByTask.get(String(task.id)) ?? []
    if (task.status !== 'succeeded' && taskPages.length !== 0) {
      throw new Error('memory-knowledge: unfinished Page tasks cannot retain generated Pages')
    }
    if (task.status !== 'succeeded') continue
    if (taskPages.length === 0 || taskPages.length > task.claimIds.length + 1) {
      throw new Error('memory-knowledge: completed Page tasks require a bounded non-empty Page tree')
    }
    const taskPageClaims = new Set(taskPages.flatMap(page => page.claimIds.map(String)))
    if (taskPageClaims.size !== task.claimIds.length
      || task.claimIds.some(id => !taskPageClaims.has(String(id)))) {
      throw new Error('memory-knowledge: completed Page tasks must organize every assigned Claim exactly once')
    }
    const childIds = new Set(taskPages.flatMap(page => page.childPageIds.map(String)))
    const roots = taskPages.filter(page => !childIds.has(String(page.id)))
    if (roots.length !== 1) throw new Error('memory-knowledge: each Page task must produce exactly one root')
    taskRoots.push(roots[0]!.id)
  }
  const pageTasksComplete = pageTasks.every(task => task.status === 'succeeded')
  if (pageTasksComplete && pageTasks.length > 0) {
    if (syntheticPages.length !== 1 || snapshot.run.rootPageIds.length !== 1
      || snapshot.run.rootPageIds[0] !== syntheticPages[0]!.id
      || syntheticPages[0]!.childPageIds.length !== taskRoots.length
      || taskRoots.some(id => !syntheticPages[0]!.childPageIds.includes(id))) {
      throw new Error('memory-knowledge: completed Page generation requires one synthetic root over every task tree')
    }
  } else {
    if (syntheticPages.length !== 0 || snapshot.run.rootPageIds.length !== taskRoots.length
      || taskRoots.some(id => !snapshot.run.rootPageIds.includes(id))) {
      throw new Error('memory-knowledge: partial Page generation roots are inconsistent')
    }
  }

  const derivedStatus = new Map<string, WikiPage['status']>()
  const deriveStatus = (page: WikiPage): WikiPage['status'] => {
    const cached = derivedStatus.get(String(page.id))
    if (cached !== undefined) return cached
    const claimStatuses = page.claimIds.map(id => claimById.get(String(id))!.status)
    const childStatuses = page.childPageIds.map(id => deriveStatus(pageById.get(String(id))!))
    const statuses = [...claimStatuses, ...childStatuses]
    const status: WikiPage['status'] = statuses.includes('conflicted')
      ? 'conflicted'
      : statuses.includes('stale')
        ? 'stale'
        : statuses.length > 0 && statuses.every(value => value === 'verified')
          ? 'verified'
          : 'draft'
    derivedStatus.set(String(page.id), status)
    return status
  }
  for (const page of activePages) {
    if (page.status !== deriveStatus(page)) {
      throw new Error('memory-knowledge: Wiki Page status does not match its Claims and children')
    }
  }

  if (snapshot.run.status === 'complete') {
    const incompleteCoverage = snapshot.coverage.some(item => ['pending', 'analyzing', 'blocked', 'stale'].includes(item.status))
    if (!snapshot.run.catalogComplete || incompleteCoverage || !snapshot.run.consistency.planned
      || consistencyTasks.some(task => task.status !== 'succeeded')
      || pageTasks.some(task => task.status !== 'succeeded') || activePages.length === 0
      || activePages.some(page => page.status !== 'verified')) {
      throw new Error('memory-knowledge: a complete Wiki run requires complete coverage and verified pages')
    }
  }
}

function snapshotPayload(snapshot: Omit<WikiRunSnapshot, 'snapshotHash'>): Omit<WikiRunSnapshot, 'snapshotHash'> {
  return {
    schemaVersion: WIKI_RUN_SCHEMA_VERSION,
    run: structuredClone(snapshot.run),
    coverage: [...snapshot.coverage].map(value => structuredClone(value))
      .sort((left, right) => compareText(String(left.id), String(right.id))),
    tasks: [...snapshot.tasks].map(value => structuredClone(value))
      .sort((left, right) => compareText(left.shardKey, right.shardKey)),
    citations: [...snapshot.citations].map(value => structuredClone(value))
      .sort((left, right) => compareText(String(left.id), String(right.id))),
    claims: [...snapshot.claims].map(value => structuredClone(value))
      .sort((left, right) => compareText(String(left.id), String(right.id))),
    conflicts: [...snapshot.conflicts].map(value => structuredClone(value))
      .sort((left, right) => compareText(String(left.id), String(right.id))),
    pages: [...snapshot.pages].map(value => structuredClone(value))
      .sort((left, right) => compareText(String(left.id), String(right.id))),
  }
}

function hashSnapshot(snapshot: Omit<WikiRunSnapshot, 'snapshotHash'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`
}

/** Compute the deterministic id for one Source file in a Wiki coverage catalog. */
export function wikiCoverageId(source: KnowledgeSourceId, path: string): WikiCoverageId {
  if (!PORTABLE_PATH_PATTERN.test(path)) throw new Error('memory-knowledge: Wiki coverage path must be portable')
  const digest = createHash('sha256').update(`${source}\0${path}`).digest('hex')
  return WikiCoverageId(`wcov_${digest}`)
}

/** Compute the deterministic identity for one exact core interval inside Coverage. */
export function wikiMaterialRangeId(
  coverage: WikiCoverageId,
  ordinal: number,
  startByte: number,
  endByte: number,
): WikiMaterialRangeId {
  for (const value of [ordinal, startByte, endByte]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('memory-knowledge: Wiki material range coordinates must be non-negative safe integers')
    }
  }
  if (startByte >= endByte) throw new Error('memory-knowledge: Wiki material range must not be empty')
  const digest = createHash('sha256').update(`${coverage}\0${ordinal}\0${startByte}\0${endByte}`).digest('hex')
  return WikiMaterialRangeId(`wrange_${digest}`)
}

/** Compute the deterministic id for one shard task inside a Wiki run. */
export function wikiTaskId(run: WikiRunId, shardKey: string): WikiTaskId {
  if (shardKey.trim().length === 0) throw new Error('memory-knowledge: Wiki task shardKey must not be empty')
  const digest = createHash('sha256').update(`${run}\0${shardKey}`).digest('hex')
  return WikiTaskId(`wtask_${digest}`)
}

/** Recompute exact file and byte totals for a Wiki run. */
export function summarizeWikiCoverage(items: readonly WikiCoverageItem[]): WikiCoverageSummary {
  const summary: WikiCoverageSummary = {
    itemCount: items.length,
    totalBytes: 0,
    pending: 0,
    analyzing: 0,
    analyzed: 0,
    deferred: 0,
    excluded: 0,
    blocked: 0,
    stale: 0,
  }
  for (const item of items) {
    if (!Number.isSafeInteger(item.byteSize) || item.byteSize < 0) {
      throw new Error('memory-knowledge: Wiki coverage byteSize must be a non-negative safe integer')
    }
    summary.totalBytes += item.byteSize
    if (!Number.isSafeInteger(summary.totalBytes)) throw new Error('memory-knowledge: Wiki coverage byte total is unsafe')
    summary[item.status] += 1
  }
  return summary
}

/** Recompute exact task lifecycle totals for a Wiki run header. */
export function summarizeWikiTasks(tasks: readonly WikiShardTask[]): WikiTaskSummary {
  const summary: WikiTaskSummary = {
    taskCount: tasks.length,
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const task of tasks) summary[task.status] += 1
  return summary
}

/** Recompute exact large-file range progress from durable analysis tasks. */
export function summarizeWikiMaterialRanges(tasks: readonly WikiShardTask[]): WikiMaterialRangeSummary {
  const summary: WikiMaterialRangeSummary = {
    rangeCount: 0,
    totalBytes: 0,
    analyzedBytes: 0,
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  }
  for (const task of tasks) {
    for (const range of task.materialRanges) {
      const bytes = range.endByte - range.startByte
      summary.rangeCount += 1
      summary.totalBytes += bytes
      summary[task.status] += 1
      if (task.status === 'succeeded') summary.analyzedBytes += bytes
      if (![summary.rangeCount, summary.totalBytes, summary.analyzedBytes].every(Number.isSafeInteger)) {
        throw new Error('memory-knowledge: Wiki material range totals are unsafe')
      }
    }
  }
  return summary
}

/** Assess whether one durable Wiki run satisfies the current project-knowledge activation requirements. */
export function assessWikiCompletion(run: WikiRun): WikiCompletionReport {
  const coverageIssueCount = run.coverage.pending
    + run.coverage.analyzing
    + run.coverage.deferred
    + run.coverage.blocked
    + run.coverage.stale
  const terminalPageState = run.status === 'needs-review' || run.status === 'complete'
  const postVerificationState = terminalPageState || run.status === 'synthesizing'
  const fileSynthesis: WikiCompletionCheck = run.fileSynthesis.status === 'unassessed'
    ? { id: 'file-synthesis', state: 'unsupported', issueCount: Math.max(1, run.fileSynthesis.fileCount) }
    : run.fileSynthesis.status === 'complete'
      && run.fileSynthesis.completeFileCount === run.fileSynthesis.fileCount
      && run.fileSynthesis.incompleteFileCount === 0
      ? { id: 'file-synthesis', state: 'pass', issueCount: 0 }
      : run.fileSynthesis.status === 'unplanned'
        && run.fileSynthesis.fileCount === 0
        && run.fileSynthesis.taskCount === 0
        ? { id: 'file-synthesis', state: 'pass', issueCount: 0 }
        : {
            id: 'file-synthesis',
            state: 'fail',
            issueCount: Math.max(1, run.fileSynthesis.incompleteFileCount ?? run.fileSynthesis.fileCount),
          }
  const catalogComplete = run.catalogComplete && run.catalogOmittedItemCount === 0
  const consistencyComplete = run.consistency.planned
    && run.consistency.candidatePairsComplete
    && run.consistency.omittedCandidatePairCount === 0
    && postVerificationState
  const pagesComplete = terminalPageState && run.pageGeneration.planned && run.rootPageIds.length > 0
  const checks: WikiCompletionCheck[] = [{
    id: 'catalog',
    state: catalogComplete ? 'pass' : 'fail',
    issueCount: catalogComplete ? 0 : Math.max(1, run.catalogOmittedItemCount ?? 0),
  }, {
    id: 'coverage',
    state: coverageIssueCount === 0 ? 'pass' : 'fail',
    issueCount: coverageIssueCount,
  }, {
    id: 'analysis',
    state: coverageIssueCount === 0 ? 'pass' : 'fail',
    issueCount: coverageIssueCount,
  }, fileSynthesis, {
    id: 'verification',
    state: postVerificationState ? 'pass' : 'fail',
    issueCount: postVerificationState ? 0 : 1,
  }, {
    id: 'consistency',
    state: consistencyComplete ? 'pass' : 'fail',
    issueCount: consistencyComplete ? 0 : Math.max(1, run.consistency.omittedCandidatePairCount ?? 0),
  }, {
    id: 'pages',
    state: pagesComplete ? 'pass' : 'fail',
    issueCount: pagesComplete ? 0 : 1,
  }, {
    id: 'material-exposure',
    state: 'unsupported',
    issueCount: 1,
  }, {
    id: 'business-questions',
    state: 'unsupported',
    issueCount: 1,
  }, {
    id: 'cross-module-flows',
    state: 'unsupported',
    issueCount: 1,
  }]
  return {
    eligibleForActivation: checks.every(check => check.state === 'pass'),
    checks,
  }
}

function consistencyRecallKeys(statement: string, maxKeys: number): { keys: string[]; complete: boolean } {
  const normalized = statement.normalize('NFKC').toLocaleLowerCase('und')
  const values = new Set<string>()
  const add = (value: string): boolean => {
    values.add(value)
    return values.size <= maxKeys
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0]
    const characters = [...token]
    if (characters.length >= 2 && !add(`token:${token}`)) {
      return { keys: [...values].slice(0, maxKeys), complete: false }
    }
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= characters.length; index += 1) {
        if (!add(`ngram:${characters.slice(index, index + size).join('')}`)) {
          return { keys: [...values].slice(0, maxKeys), complete: false }
        }
      }
    }
  }
  return { keys: [...values], complete: true }
}

/** Hash one recalled pair against its current Claims, Citations, and Coverage identities. */
export function wikiConsistencyPairFingerprint(
  claimIds: readonly [WikiClaimId, WikiClaimId],
  reasons: readonly WikiConsistencyRecallReason[],
  claims: readonly WikiClaim[],
  citations: readonly WikiCitation[],
  coverage: readonly WikiCoverageItem[],
): string {
  const claimById = new Map(claims.map(claim => [String(claim.id), claim]))
  const citationById = new Map(citations.map(citation => [String(citation.id), citation]))
  const coverageById = new Map(coverage.map(item => [String(item.id), item]))
  const ids = [...claimIds].map(String).sort(compareText)
  if (ids.length !== 2 || ids[0] === ids[1]) {
    throw new Error('memory-knowledge: Wiki consistency candidate requires two distinct Claims')
  }
  const payload = ids.map(id => {
    const claim = claimById.get(id)
    if (claim === undefined) throw new Error('memory-knowledge: Wiki consistency candidate references a missing Claim')
    return {
      id,
      kind: claim.kind,
      statement: claim.statement.normalize('NFKC'),
      citations: claim.citationIds.map(String).sort(compareText).map(citationIdValue => {
        const citation = citationById.get(citationIdValue)
        if (citation === undefined) throw new Error('memory-knowledge: Wiki consistency candidate references a missing Citation')
        return { id: citationIdValue, role: citation.role, provenance: citation.provenance }
      }),
      coverage: claim.coverageIds.map(String).sort(compareText).map(coverageIdValue => {
        const item = coverageById.get(coverageIdValue)
        if (item === undefined) throw new Error('memory-knowledge: Wiki consistency candidate references missing Coverage')
        return { id: coverageIdValue, revision: item.revision, analyzedContentHash: item.analyzedContentHash }
      }),
    }
  })
  const digest = createHash('sha256').update(JSON.stringify({
    rulesVersion: WIKI_CONSISTENCY_RULES_VERSION,
    reasons: [...new Set(reasons)].sort(compareText),
    claims: payload,
  })).digest('hex')
  return `sha256:${digest}`
}

/** Return Claims that remain visible after file-level synthesis consumes their inputs. */
export function activeWikiClaims(claims: readonly WikiClaim[]): WikiClaim[] {
  const consumed = new Set(claims.flatMap(claim => claim.sourceClaimIds.map(String)))
  return claims.filter(claim => !consumed.has(String(claim.id)))
}

function planFileSynthesisLayer(
  runId: WikiRunId,
  coverageId: WikiCoverageId,
  groups: Map<string, WikiClaim[]>,
  level: number,
  now: string,
  config: WikiFileSynthesisConfig,
): WikiShardTask[] {
  const cursors = [...groups.entries()].sort(([left], [right]) => compareText(left, right))
    .map(([, values]) => ({ values: [...values].sort((left, right) => compareText(String(left.id), String(right.id))), index: 0 }))
  const batches: WikiClaim[][] = []
  let batch: WikiClaim[] = []
  let statementCharacters = 0
  while (cursors.some(cursor => cursor.index < cursor.values.length)) {
    for (const cursor of cursors) {
      const claim = cursor.values[cursor.index]
      if (claim === undefined) continue
      cursor.index += 1
      if (batch.length > 0 && (batch.length === config.maxClaimsPerTask
        || statementCharacters + claim.statement.length > config.maxStatementCharactersPerTask)) {
        batches.push(batch)
        batch = []
        statementCharacters = 0
      }
      batch.push(claim)
      statementCharacters += claim.statement.length
    }
  }
  if (batch.length > 0) batches.push(batch)
  const coverageDigest = createHash('sha256').update(String(coverageId)).digest('hex').slice(0, 20)
  return batches.map((assigned, index) => {
    const shardKey = `file_synthesis_${coverageDigest}_${level.toString().padStart(4, '0')}_${index.toString().padStart(6, '0')}`
    return {
      id: wikiTaskId(runId, shardKey), runId, kind: 'file-synthesis', shardKey,
      coverageIds: [coverageId],
      claimIds: assigned.map(claim => claim.id).sort((left, right) => compareText(String(left), String(right))),
      candidatePairs: [], materialRanges: [],
      fileSynthesis: { level, batchIndex: index, batchCount: batches.length },
      status: 'planned', attemptCount: 0, createdAt: now, updatedAt: now,
    }
  })
}

function fileSynthesisSurvivors(tasks: readonly WikiShardTask[], claims: readonly WikiClaim[]): Map<string, WikiClaim[]> {
  const claimById = new Map(claims.map(claim => [claim.id, claim]))
  const outputs = Map.groupBy(claims.filter(claim => claim.sourceTaskId !== undefined), claim => claim.sourceTaskId!)
  return new Map(tasks.map(task => {
    const produced = outputs.get(task.id) ?? []
    const consumed = new Set(produced.flatMap(claim => claim.sourceClaimIds))
    return [task.shardKey, [...task.claimIds.filter(id => !consumed.has(id)).map(id => claimById.get(id)!), ...produced]]
  }))
}

function summarizeFileSynthesis(tasks: readonly WikiShardTask[], limits: WikiFileSynthesisConfig): WikiFileSynthesisSummary {
  const synthesisTasks = tasks.filter(task => task.kind === 'file-synthesis')
  const fileCount = new Set(synthesisTasks.flatMap(task => task.coverageIds)).size
  const completeFileCount = synthesisTasks.filter(task => task.fileSynthesis?.outcome === 'complete').length
  const noReductionFileCount = synthesisTasks.filter(task => task.fileSynthesis?.outcome === 'no-reduction').length
  const levelLimitFileCount = synthesisTasks.filter(task => task.fileSynthesis?.outcome === 'level-limit').length
  const incompleteFileCount = noReductionFileCount + levelLimitFileCount
  return {
    rulesVersion: WIKI_FILE_SYNTHESIS_RULES_VERSION,
    status: completeFileCount + incompleteFileCount < fileCount ? 'running' : incompleteFileCount > 0 ? 'incomplete' : 'complete',
    fileCount,
    inputClaimCount: synthesisTasks.filter(task => task.fileSynthesis!.level === 0).reduce((total, task) => total + task.claimIds.length, 0),
    taskCount: synthesisTasks.length,
    levelCount: synthesisTasks.reduce((max, task) => Math.max(max, task.fileSynthesis!.level + 1), 0),
    completeFileCount, incompleteFileCount, noReductionFileCount, levelLimitFileCount,
    limits: { ...limits },
  }
}

function assertFileSynthesisGraph(snapshot: Omit<WikiRunSnapshot, 'snapshotHash'>): void {
  const { tasks, claims, run } = snapshot
  const synthesisTasks = tasks.filter(task => task.kind === 'file-synthesis')
  const summary = run.fileSynthesis
  const expectedSummary = summary.status === 'unplanned' ? createUnplannedWikiFileSynthesisSummary()
    : summary.status === 'unassessed' ? createUnassessedWikiFileSynthesisSummary(tasks)
      : summarizeFileSynthesis(tasks, summary.limits!)
  if (JSON.stringify(summary) !== JSON.stringify(expectedSummary)
    || (summary.status === 'unplanned' && synthesisTasks.length !== 0)) {
    throw new Error('memory-knowledge: Wiki file synthesis summary is inconsistent')
  }
  const limits = summary.limits
  const samePlan = (actual: readonly WikiShardTask[], expected: readonly WikiShardTask[]): boolean => {
    const project = (values: readonly WikiShardTask[]) => values.map(task => ({
      id: task.id, claimIds: task.claimIds, coverageIds: task.coverageIds,
      level: task.fileSynthesis!.level, batchIndex: task.fileSynthesis!.batchIndex, batchCount: task.fileSynthesis!.batchCount,
    })).sort((left, right) => compareText(String(left.id), String(right.id)))
    return JSON.stringify(project(actual)) === JSON.stringify(project(expected))
  }
  if (limits !== null) {
    const first = createWikiFileSynthesisTasks(run.id, snapshot.coverage, snapshot.citations,
      claims.filter(claim => claim.sourceClaimIds.length === 0), tasks, run.createdAt, limits).tasks
    if (!samePlan(synthesisTasks.filter(task => task.fileSynthesis!.level === 0), first)) {
      throw new Error('memory-knowledge: Wiki 首层综合任务没有完整匹配原始声明')
    }
  }
  const byFile = Map.groupBy(synthesisTasks, task => task.coverageIds[0]!)
  for (const [coverageId, fileTasks] of byFile) {
    const layers = [...Map.groupBy(fileTasks, task => task.fileSynthesis!.level).entries()]
      .sort(([left], [right]) => left - right)
    for (const [index, [level, unsorted]] of layers.entries()) {
      const layer = [...unsorted].sort((left, right) => left.fileSynthesis!.batchIndex - right.fileSynthesis!.batchIndex)
      if (level !== index || layer.some((task, batchIndex) => task.fileSynthesis!.batchIndex !== batchIndex
        || task.fileSynthesis!.batchCount !== layer.length)) {
        throw new Error('memory-knowledge: Wiki 综合层和批次必须连续且完整')
      }
      if (limits === null) {
        if (level !== 0 || layer.some(task => task.fileSynthesis!.outcome !== undefined)) {
          throw new Error('memory-knowledge: 未评估的历史综合不能包含递归结论')
        }
        continue
      }
      const last = layer.at(-1)!
      const next = layers[index + 1]?.[1]
      const allSucceeded = layer.every(task => task.status === 'succeeded')
      if (level >= limits.maxLevels || layer.slice(0, -1).some(task => task.fileSynthesis!.outcome !== undefined)
        || (!allSucceeded && (next !== undefined || last.fileSynthesis!.outcome !== undefined))) {
        throw new Error('memory-knowledge: Wiki 综合层完成状态或层数预算不一致')
      }
      if (!allSucceeded) continue
      const expectedNext = planFileSynthesisLayer(run.id, coverageId, fileSynthesisSurvivors(layer, claims), level + 1, run.createdAt, limits)
      const outcome = layer.length === 1 ? 'complete' : level + 1 >= limits.maxLevels ? 'level-limit'
        : expectedNext.length >= layer.length ? 'no-reduction' : undefined
      if (last.fileSynthesis!.outcome !== outcome
        || (outcome === undefined ? next === undefined || !samePlan(next, expectedNext) : next !== undefined)) {
        throw new Error('memory-knowledge: Wiki 综合下一层或停止原因与存活声明不一致')
      }
    }
  }
}

/** 根据已完成层的存活声明追加更小的一层；预算来自持久化 Run。
 * @param tasks 当前运行的全部任务。
 * @param claims 包含各层来源的全部声明。
 * @param summary 已持久化的文件综合状态及预算。
 * @param now 本次推进时间。
 * @returns 更新终止原因及新层任务后的任务列表和汇总。
 */
export function advanceWikiFileSynthesisTasks(
  tasks: readonly WikiShardTask[], claims: readonly WikiClaim[], summary: WikiFileSynthesisSummary, now: string,
): { tasks: WikiShardTask[]; summary: WikiFileSynthesisSummary } {
  if (summary.limits === null) return { tasks: [...tasks], summary }
  const limits = summary.limits
  const updated = tasks.map(task => ({ ...task, ...(task.fileSynthesis === undefined ? {} : { fileSynthesis: { ...task.fileSynthesis } }) }))
  const byFile = Map.groupBy(updated.filter(task => task.kind === 'file-synthesis'), task => task.coverageIds[0]!)
  for (const [coverageId, fileTasks] of byFile) {
    const level = fileTasks.reduce((max, task) => Math.max(max, task.fileSynthesis!.level), 0)
    const layer = fileTasks.filter(task => task.fileSynthesis!.level === level)
      .sort((left, right) => left.fileSynthesis!.batchIndex - right.fileSynthesis!.batchIndex)
    const last = layer.at(-1)!
    if (layer.some(task => task.status !== 'succeeded') || last.fileSynthesis!.outcome !== undefined) continue
    if (layer.length === 1) last.fileSynthesis!.outcome = 'complete'
    else if (level + 1 >= limits.maxLevels) last.fileSynthesis!.outcome = 'level-limit'
    else {
      const next = planFileSynthesisLayer(last.runId, coverageId, fileSynthesisSurvivors(layer, claims), level + 1, now, limits)
      if (next.length >= layer.length) last.fileSynthesis!.outcome = 'no-reduction'
      else updated.push(...next)
    }
    last.updatedAt = now
  }
  return { tasks: updated, summary: summarizeFileSynthesis(updated, limits) }
}

/** Plan bounded cross-range synthesis batches for large files with evidence in multiple ranges. */
export function createWikiFileSynthesisTasks(
  runId: WikiRunId,
  coverage: readonly WikiCoverageItem[],
  citations: readonly WikiCitation[],
  claims: readonly WikiClaim[],
  tasks: readonly WikiShardTask[],
  now: string,
  config: WikiFileSynthesisConfig = DEFAULT_WIKI_FILE_SYNTHESIS_CONFIG,
): { tasks: WikiShardTask[]; summary: WikiFileSynthesisSummary } {
  if (!fileSynthesisConfigSchema.safeParse(config).success) {
    throw new Error('memory-knowledge: Wiki file synthesis task budgets are invalid')
  }
  if (claims.some(claim => claim.sourceClaimIds.length > 0)) {
    throw new Error('memory-knowledge: Wiki file synthesis can only be planned from raw analysis Claims')
  }
  const analysisTasks = tasks.filter(task => task.kind === 'analysis')
  if (analysisTasks.length === 0) {
    return {
      tasks: [],
      summary: summarizeFileSynthesis([], config),
    }
  }
  if (analysisTasks.some(task => task.status !== 'succeeded')) {
    throw new Error('memory-knowledge: Wiki file synthesis requires every analysis task to succeed')
  }
  const coverageById = new Map(coverage.map(item => [String(item.id), item]))
  const rangedCoverageIds = new Set(analysisTasks
    .filter(task => task.materialRanges.length === 1)
    .map(task => String(task.coverageIds[0])))
  const citationById = new Map(citations.map(citation => [String(citation.id), citation]))
  const claimsByCoverage = Map.groupBy(
    claims.filter(claim => claim.coverageIds.length === 1 && rangedCoverageIds.has(String(claim.coverageIds[0]))),
    claim => String(claim.coverageIds[0]),
  )
  const plannedTasks: WikiShardTask[] = []
  for (const [coverageKey, unsortedClaims] of [...claimsByCoverage.entries()]
    .sort(([left], [right]) => compareText(left, right))) {
    const item = coverageById.get(coverageKey)
    if (item === undefined) throw new Error('memory-knowledge: Wiki file synthesis references missing Coverage')
    const rangeIds = new Set<string>()
    for (const claim of unsortedClaims) {
      if (claim.kind === 'unknown') continue
      for (const id of claim.citationIds) {
        const citation = citationById.get(String(id))
        if (citation?.role === 'supports' && citation.rangeId !== undefined) rangeIds.add(String(citation.rangeId))
      }
    }
    if (rangeIds.size < 2) continue
    const groups = new Map<string, WikiClaim[]>()
    for (const claim of [...unsortedClaims].sort((left, right) => compareText(String(left.id), String(right.id)))) {
      const primaryRange = claim.citationIds.map(id => citationById.get(String(id)))
        .filter((citation): citation is WikiCitation => citation?.role === 'supports' && citation.rangeId !== undefined)
        .map(citation => String(citation.rangeId))
        .sort(compareText)[0] ?? '~unranged'
      const values = groups.get(primaryRange) ?? []
      values.push(claim)
      groups.set(primaryRange, values)
    }
    plannedTasks.push(...planFileSynthesisLayer(runId, item.id, groups, 0, now, config))
  }
  plannedTasks.sort((left, right) => compareText(left.shardKey, right.shardKey))
  return {
    tasks: plannedTasks,
    summary: summarizeFileSynthesis(plannedTasks, config),
  }
}

/** Build deterministic, bounded verification batches that mix claims from different analysis shards. */
export function createWikiVerificationTasks(
  runId: WikiRunId,
  coverage: readonly WikiCoverageItem[],
  claims: readonly WikiClaim[],
  now: string,
  maxClaims = DEFAULT_WIKI_VERIFICATION_BATCH_CLAIMS,
): WikiShardTask[] {
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1) {
    throw new Error('memory-knowledge: Wiki verification batch size must be a positive safe integer')
  }
  const coverageById = new Map(coverage.map(item => [String(item.id), item]))
  const byShard = new Map<string, WikiClaim[]>()
  for (const claim of claims.filter(value => value.kind !== 'unknown')) {
    const shardKeys = [...new Set(claim.coverageIds.map(id => {
      const item = coverageById.get(String(id))
      if (item === undefined) throw new Error('memory-knowledge: Wiki verification claim references missing coverage')
      return item.shardKey
    }))].sort(compareText)
    if (shardKeys.length === 0) throw new Error('memory-knowledge: Wiki verification claim requires project coverage')
    const key = shardKeys[0]!
    const values = byShard.get(key) ?? []
    values.push(structuredClone(claim))
    byShard.set(key, values)
  }
  const groups = [...byShard.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, values]) => ({
      values: values.sort((left, right) => compareText(String(left.id), String(right.id))),
      index: 0,
    }))
  const batches: WikiClaim[][] = []
  let batch: WikiClaim[] = []
  while (groups.some(group => group.index < group.values.length)) {
    for (const group of groups) {
      const claim = group.values[group.index]
      if (claim === undefined) continue
      batch.push(claim)
      group.index += 1
      if (batch.length === maxClaims) {
        batches.push(batch)
        batch = []
      }
    }
  }
  if (batch.length > 0) batches.push(batch)
  return batches.map((values, index): WikiShardTask => {
    const shardKey = `verification_${index.toString().padStart(6, '0')}`
    return {
      id: wikiTaskId(runId, shardKey),
      runId,
      kind: 'verification',
      shardKey,
      coverageIds: [...new Set(values.flatMap(claim => claim.coverageIds.map(String)))]
        .sort(compareText)
        .map(WikiCoverageId),
      claimIds: values.map(claim => claim.id).sort((left, right) => compareText(String(left), String(right))),
      candidatePairs: [],
      materialRanges: [],
      status: 'planned',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }
  })
}

/** Build deterministic, bounded Claim groups for language-neutral Page organization. */
export function createWikiPageTasks(
  runId: WikiRunId,
  coverage: readonly WikiCoverageItem[],
  claims: readonly WikiClaim[],
  now: string,
  config: WikiPageConfig = DEFAULT_WIKI_PAGE_CONFIG,
): { tasks: WikiShardTask[]; summary: WikiPageGenerationSummary } {
  if (!Number.isSafeInteger(config.maxClaimsPerTask) || config.maxClaimsPerTask < 1
    || !Number.isSafeInteger(config.maxStatementCharactersPerTask)
    || config.maxStatementCharactersPerTask < MAX_WIKI_CLAIM_STATEMENT_CHARACTERS) {
    throw new Error('memory-knowledge: Wiki Page task budgets are invalid')
  }
  const coverageById = new Map(coverage.map(item => [String(item.id), item]))
  const byArea = new Map<string, WikiClaim[]>()
  const eligible = claims.filter(claim => claim.status !== 'rejected' && claim.status !== 'stale')
    .sort((left, right) => compareText(String(left.id), String(right.id)))
  for (const claim of eligible) {
    const areas = [...new Set(claim.coverageIds.map(id => {
      const item = coverageById.get(String(id))
      if (item === undefined) throw new Error('memory-knowledge: Wiki Page Claim references missing Coverage')
      return item.area
    }))].sort(compareText)
    const area = areas[0] ?? 'unknown'
    const values = byArea.get(area) ?? []
    values.push(claim)
    byArea.set(area, values)
  }
  const tasks: WikiShardTask[] = []
  for (const [area, values] of [...byArea.entries()].sort(([left], [right]) => compareText(left, right))) {
    const batches: WikiClaim[][] = []
    let batch: WikiClaim[] = []
    let statementCharacters = 0
    for (const claim of values) {
      if (batch.length > 0 && (batch.length === config.maxClaimsPerTask
        || statementCharacters + claim.statement.length > config.maxStatementCharactersPerTask)) {
        batches.push(batch)
        batch = []
        statementCharacters = 0
      }
      batch.push(claim)
      statementCharacters += claim.statement.length
    }
    if (batch.length > 0) batches.push(batch)
    const areaDigest = createHash('sha256').update(area).digest('hex').slice(0, 16)
    for (const [index, assigned] of batches.entries()) {
      const shardKey = `page_${areaDigest}_${index.toString().padStart(6, '0')}`
      tasks.push({
        id: wikiTaskId(runId, shardKey),
        runId,
        kind: 'page',
        shardKey,
        coverageIds: [...new Set(assigned.flatMap(claim => claim.coverageIds.map(String)))]
          .sort(compareText)
          .map(WikiCoverageId),
        claimIds: assigned.map(claim => claim.id).sort((left, right) => compareText(String(left), String(right))),
        candidatePairs: [],
        materialRanges: [],
        status: 'planned',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
  tasks.sort((left, right) => compareText(left.shardKey, right.shardKey))
  return {
    tasks,
    summary: {
      rulesVersion: WIKI_PAGE_RULES_VERSION,
      planned: true,
      claimCount: eligible.length,
      taskCount: tasks.length,
    },
  }
}

/** Recall bounded cross-batch candidate groups without treating recall as a semantic decision. */
export function createWikiConsistencyTasks(
  runId: WikiRunId,
  coverage: readonly WikiCoverageItem[],
  citations: readonly WikiCitation[],
  claims: readonly WikiClaim[],
  tasks: readonly WikiShardTask[],
  now: string,
  config: WikiConsistencyConfig = DEFAULT_WIKI_CONSISTENCY_CONFIG,
): { tasks: WikiShardTask[]; summary: WikiConsistencySummary } {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < 1 || (name === 'maxClaimsPerTask' && value < 2)) {
      throw new Error(`memory-knowledge: Wiki consistency ${name} must be a positive safe integer`)
    }
  }
  const verificationTasks = tasks.filter(value => value.kind === 'verification')
  if (verificationTasks.some(task => task.status !== 'succeeded')) {
    throw new Error('memory-knowledge: Wiki consistency recall requires every verification task to succeed')
  }
  const verificationTaskByClaim = new Map<string, string>()
  for (const task of verificationTasks) {
    for (const claimIdValue of task.claimIds) {
      const claimKey = String(claimIdValue)
      if (verificationTaskByClaim.has(claimKey)) {
        throw new Error('memory-knowledge: Wiki consistency recall requires one verification task per Claim')
      }
      verificationTaskByClaim.set(claimKey, String(task.id))
    }
  }
  const eligible = claims.filter(claim => claim.kind !== 'unknown'
    && (claim.status === 'verified' || claim.status === 'uncertain')
    && verificationTaskByClaim.has(String(claim.id)))
    .sort((left, right) => compareText(String(left.id), String(right.id)))
  const eligibleById = new Map(eligible.map(claim => [String(claim.id), claim]))
  const buckets = new Map<string, WikiClaim[]>()
  let complete = true
  const addToBucket = (key: string, claim: WikiClaim): void => {
    const values = buckets.get(key) ?? []
    if (values.length === config.maxClaimsPerRecallKey) {
      complete = false
      return
    }
    values.push(claim)
    buckets.set(key, values)
  }
  for (const claim of eligible) {
    for (const coverageIdValue of claim.coverageIds) addToBucket(`coverage:${coverageIdValue}`, claim)
    const recall = consistencyRecallKeys(claim.statement, config.maxRecallKeysPerClaim)
    if (!recall.complete) complete = false
    for (const key of recall.keys) addToBucket(key, claim)
  }
  type MutablePair = { claimIds: [WikiClaimId, WikiClaimId]; reasons: Set<WikiConsistencyRecallReason> }
  const pairByKey = new Map<string, MutablePair>()
  recall: for (const [key, unsorted] of [...buckets.entries()].sort(([left], [right]) => compareText(left, right))) {
    const values = [...new Map(unsorted.map(claim => [String(claim.id), claim])).values()]
      .sort((left, right) => compareText(String(left.id), String(right.id)))
    for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
        const left = values[leftIndex]!
        const right = values[rightIndex]!
        if (verificationTaskByClaim.get(String(left.id)) === verificationTaskByClaim.get(String(right.id))) continue
        const pairKey = `${left.id}\0${right.id}`
        const reason: WikiConsistencyRecallReason = key.startsWith('coverage:') ? 'shared-coverage' : 'statement-key'
        const existing = pairByKey.get(pairKey)
        if (existing !== undefined) {
          existing.reasons.add(reason)
          continue
        }
        if (pairByKey.size === config.maxCandidatePairs) {
          complete = false
          break recall
        }
        pairByKey.set(pairKey, { claimIds: [left.id, right.id], reasons: new Set([reason]) })
      }
    }
  }
  const candidates = [...pairByKey.values()].map((pair): WikiConsistencyCandidatePair => {
    const reasons = [...pair.reasons].sort(compareText)
    return {
      claimIds: pair.claimIds,
      reasons,
      fingerprint: wikiConsistencyPairFingerprint(pair.claimIds, reasons, eligible, citations, coverage),
    }
  }).sort((left, right) => {
    const leftPriority = left.reasons.includes('shared-coverage') ? 0 : 1
    const rightPriority = right.reasons.includes('shared-coverage') ? 0 : 1
    return leftPriority - rightPriority || compareText(left.claimIds.join('\0'), right.claimIds.join('\0'))
  })

  const parent = new Map<string, string>(eligible.map(claim => [String(claim.id), String(claim.id)]))
  const members = new Map<string, Set<string>>(eligible.map(claim => [String(claim.id), new Set([String(claim.id)])]))
  const find = (id: string): string => {
    const current = parent.get(id)!
    if (current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }
  const accepted: WikiConsistencyCandidatePair[] = []
  for (const pair of candidates) {
    const leftRoot = find(String(pair.claimIds[0]))
    const rightRoot = find(String(pair.claimIds[1]))
    if (leftRoot !== rightRoot) {
      const leftMembers = members.get(leftRoot)!
      const rightMembers = members.get(rightRoot)!
      if (leftMembers.size + rightMembers.size > config.maxClaimsPerTask) {
        complete = false
        continue
      }
      const [root, child] = compareText(leftRoot, rightRoot) <= 0 ? [leftRoot, rightRoot] : [rightRoot, leftRoot]
      parent.set(child, root)
      members.set(root, new Set([...members.get(root)!, ...members.get(child)!]))
      members.delete(child)
    }
    accepted.push(pair)
  }
  const pairsByRoot = new Map<string, WikiConsistencyCandidatePair[]>()
  for (const pair of accepted) {
    const root = find(String(pair.claimIds[0]))
    const values = pairsByRoot.get(root) ?? []
    values.push(pair)
    pairsByRoot.set(root, values)
  }
  const consistencyTasks = [...pairsByRoot.values()].map((pairs): WikiShardTask => {
    const claimIds = [...new Set(pairs.flatMap(pair => pair.claimIds.map(String)))].sort(compareText).map(WikiClaimId)
    const coverageIds = [...new Set(claimIds.flatMap(id => eligibleById.get(String(id))!.coverageIds.map(String)))]
      .sort(compareText).map(WikiCoverageId)
    const shardDigest = createHash('sha256').update(pairs.map(pair => pair.fingerprint).sort(compareText).join('\0')).digest('hex')
    const shardKey = `consistency_${shardDigest.slice(0, 24)}`
    return {
      id: wikiTaskId(runId, shardKey),
      runId,
      kind: 'consistency',
      shardKey,
      coverageIds,
      claimIds,
      candidatePairs: pairs,
      materialRanges: [],
      status: 'planned',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }
  }).sort((left, right) => compareText(left.shardKey, right.shardKey))
  return {
    tasks: consistencyTasks,
    summary: {
      rulesVersion: WIKI_CONSISTENCY_RULES_VERSION,
      planned: true,
      candidatePairCount: accepted.length,
      candidatePairsComplete: complete,
      omittedCandidatePairCount: complete ? 0 : null,
    },
  }
}

/** Validate and hash one complete Wiki runtime snapshot. */
export function finalizeWikiRunSnapshot(
  value: Omit<WikiRunSnapshot, 'snapshotHash'>,
): WikiRunSnapshot {
  const parsed = snapshotPayloadSchema.parse(value) as unknown as Omit<WikiRunSnapshot, 'snapshotHash'>
  const normalized = snapshotPayload(parsed)
  assertSnapshotGraph(normalized)
  return { ...normalized, snapshotHash: hashSnapshot(normalized) }
}

/** Strictly parse one durable Wiki runtime header. */
export function parseWikiRun(value: unknown): WikiRun {
  return runSchema.parse(value) as WikiRun
}

/** 校验单条 Coverage；跨记录来源关系仍由完整快照校验负责。
 * @param value 持久化的文件记录。
 * @returns 已校验的 Coverage。
 */
export function parseWikiCoverageItem(value: unknown): WikiCoverageItem {
  return coverageItemSchema.parse(value) as WikiCoverageItem
}

/** 校验单条任务及材料区间；不替代完整快照的引用关系校验。
 * @param value 持久化的任务记录。
 * @returns 已校验的任务。
 */
export function parseWikiShardTask(value: unknown): WikiShardTask {
  return taskSchema.parse(value) as WikiShardTask
}

/** Strictly parse and cross-check one durable Wiki runtime snapshot. */
export function parseWikiRunSnapshot(value: unknown): WikiRunSnapshot {
  const parsed = snapshotSchema.parse(value) as unknown as WikiRunSnapshot
  const normalized = snapshotPayload(parsed)
  assertSnapshotGraph(normalized)
  const expectedHash = hashSnapshot(normalized)
  if (parsed.snapshotHash !== expectedHash) throw new Error('memory-knowledge: Wiki snapshot hash is inconsistent')
  return { ...normalized, snapshotHash: expectedHash }
}

function defaultArea(path: string): string {
  const separator = path.indexOf('/')
  return separator === -1 ? 'repository-root' : path.slice(0, separator)
}

function automaticShardKeys(
  entries: readonly WikiCatalogEntry[],
  config: WikiShardConfig,
): Map<string, string> {
  if (!Number.isSafeInteger(config.maxItems) || config.maxItems < 1
    || !Number.isSafeInteger(config.maxBytes) || config.maxBytes < 1) {
    throw new Error('memory-knowledge: Wiki shard budgets must be positive safe integers')
  }
  const keys = new Map<string, string>()
  const sorted = [...entries].sort((left, right) => {
    const sourceOrder = compareText(String(left.sourceId), String(right.sourceId))
    return sourceOrder === 0 ? compareText(left.path, right.path) : sourceOrder
  })
  let group = ''
  let shardIndex = -1
  let shardItems = 0
  let shardBytes = 0
  let shardPrefix = ''
  for (const entry of sorted) {
    if (entry.shardKey !== undefined) continue
    const area = defaultArea(entry.path)
    const nextGroup = `${entry.sourceId}\0${area}`
    if (nextGroup !== group) {
      group = nextGroup
      shardIndex = 0
      shardItems = 0
      shardBytes = 0
      shardPrefix = createHash('sha256').update(group).digest('hex').slice(0, 16)
    }
    if (shardItems > 0 && (shardItems + 1 > config.maxItems || shardBytes + entry.byteSize > config.maxBytes)) {
      shardIndex += 1
      shardItems = 0
      shardBytes = 0
    }
    keys.set(`${entry.sourceId}\0${entry.path}`, `shard_${shardPrefix}_${shardIndex.toString().padStart(6, '0')}`)
    shardItems += 1
    shardBytes += entry.byteSize
    if (!Number.isSafeInteger(shardBytes)) throw new Error('memory-knowledge: Wiki shard byte total is unsafe')
  }
  return keys
}

function coverageContentMatches(previous: WikiCoverageItem, revision: WikiFileRevision): boolean {
  if (previous.revision.kind === 'git-object' && revision.kind === 'git-object') {
    return previous.revision.objectId === revision.objectId
  }
  if (previous.revision.kind === 'content-hash' && revision.kind === 'content-hash') {
    return previous.revision.contentHash === revision.contentHash
  }
  return revision.kind === 'content-hash' && previous.analyzedContentHash === revision.contentHash
}

function reusableLeafClaims(
  previous: WikiRunSnapshot | undefined,
  coverage: readonly WikiCoverageItem[],
  runId: WikiRunId,
): { claims: WikiClaim[]; citations: WikiCitation[]; coverageIds: Set<string> } {
  if (previous === undefined) return { claims: [], citations: [], coverageIds: new Set() }
  const currentCoverageById = new Map(coverage.map(item => [String(item.id), item]))
  const previousCoverageById = new Map(previous.coverage.map(item => [String(item.id), item]))
  const citationById = new Map(previous.citations.map(citation => [String(citation.id), citation]))
  const reusableCitations = new Map<string, WikiCitation>()
  const candidateClaims: WikiClaim[] = []
  for (const claim of previous.claims) {
    if (claim.kind !== 'assertion' || claim.status !== 'verified'
      || claim.sourceClaimIds.length !== 0 || claim.sourceTaskId !== undefined || claim.citationIds.length === 0) continue
    const claimCoverage = claim.coverageIds.map(id => currentCoverageById.get(String(id)))
    if (claimCoverage.some(item => item === undefined || item.status !== 'analyzed')) continue
    if (claim.coverageIds.some(id => {
      const previousItem = previousCoverageById.get(String(id))
      const currentItem = currentCoverageById.get(String(id))
      return previousItem === undefined || currentItem === undefined
        || !coverageContentMatches(previousItem, currentItem.revision)
    })) continue
    const claimCitations = claim.citationIds.map(id => citationById.get(String(id)))
    if (claimCitations.some(citation => citation === undefined)) continue
    let valid = true
    for (const citation of claimCitations) {
      if (citation!.role !== 'supports' || citation!.rangeId !== undefined) {
        valid = false
        break
      }
      const provenance = citation!.provenance
      if (provenance.kind !== 'git-file' && provenance.kind !== 'document') {
        valid = false
        break
      }
      const item = coverage.find(candidate => candidate.sourceId === provenance.sourceId && candidate.path === provenance.path)
      if (item === undefined || item.status !== 'analyzed' || item.analyzedContentHash !== provenance.contentHash) {
        valid = false
        break
      }
      let currentProvenance: WikiCitation['provenance']
      if (item.revision.kind === 'git-object') {
        if (provenance.kind !== 'git-file') {
          valid = false
          break
        }
        currentProvenance = { ...structuredClone(provenance), commit: item.revision.commit }
      } else {
        if (provenance.kind !== 'document' || provenance.contentHash !== item.revision.contentHash) {
          valid = false
          break
        }
        currentProvenance = structuredClone(provenance)
      }
      reusableCitations.set(String(citation!.id), {
        ...structuredClone(citation!),
        runId,
        provenance: currentProvenance,
      })
    }
    if (!valid) continue
    candidateClaims.push({ ...structuredClone(claim), runId })
  }
  const candidateClaimIds = new Set(candidateClaims.map(claim => String(claim.id)))
  const reusableCoverageIds = new Set<string>()
  for (const claim of candidateClaims) {
    for (const coverageId of claim.coverageIds) {
      const key = String(coverageId)
      const previousClaims = previous.claims.filter(value => value.coverageIds.some(id => String(id) === key))
      if (previousClaims.length > 0 && previousClaims.every(value => candidateClaimIds.has(String(value.id))
        || value.status === 'rejected' || value.status === 'stale')) {
        reusableCoverageIds.add(key)
      }
    }
  }
  const claims = candidateClaims.filter(claim => claim.coverageIds.every(id => reusableCoverageIds.has(String(id))))
  const citations = [...reusableCitations.values()].filter(citation => claims.some(claim =>
    claim.citationIds.some(id => String(id) === String(citation.id))))
  const coverageIds = new Set(claims.flatMap(claim => claim.coverageIds.map(String)))
  return { claims, citations, coverageIds }
}

/** Create a language-neutral coverage plan without claiming project semantics. */
export function createPlannedWikiRun(
  input: PlanWikiRunInput,
  previousCoverage: readonly WikiCoverageItem[] = [],
  shardConfig: WikiShardConfig = DEFAULT_WIKI_SHARD_CONFIG,
  previousSnapshot?: WikiRunSnapshot,
): WikiRunSnapshot {
  const projectRoot = resolve(input.projectRoot)
  const timestamp = input.now ?? new Date().toISOString()
  const runIdValue = createWikiRunId()
  const reusableCoverage = new Map(previousCoverage.map(item => [`${item.sourceId}\0${item.path}`, item]))
  if (reusableCoverage.size !== previousCoverage.length) {
    throw new Error('memory-knowledge: previous Wiki coverage contains duplicate Source paths')
  }
  const shardKeys = automaticShardKeys(input.entries, shardConfig)
  const coverage: WikiCoverageItem[] = input.entries.map((entry): WikiCoverageItem => {
    const area = defaultArea(entry.path)
    const planned: WikiCoverageItem = {
      id: wikiCoverageId(entry.sourceId, entry.path),
      runId: runIdValue,
      sourceId: entry.sourceId,
      path: entry.path,
      byteSize: entry.byteSize,
      revision: structuredClone(entry.revision),
      area,
      shardKey: entry.shardKey ?? shardKeys.get(`${entry.sourceId}\0${entry.path}`)!,
      ...(entry.language === undefined ? {} : { language: entry.language }),
      ...(entry.artifactKind === undefined ? {} : { artifactKind: entry.artifactKind }),
      ...(entry.preparedMaterial === undefined ? {} : { preparedContentHash: entry.preparedMaterial.contentHash }),
      status: entry.disposition?.status ?? 'pending',
      ...(entry.disposition === undefined ? {} : { reason: entry.disposition.reason }),
      attemptCount: 0,
    }
    const previous = reusableCoverage.get(`${entry.sourceId}\0${entry.path}`)
    if (entry.preparedMaterial !== undefined || planned.status !== 'pending' || previous?.status !== 'analyzed'
      || !coverageContentMatches(previous, planned.revision)) return planned
    if (previous.analyzedContentHash === undefined || previous.analyzedAt === undefined) {
      throw new Error('memory-knowledge: reusable analyzed coverage is incomplete')
    }
    return {
      ...planned,
      status: 'analyzed',
      attemptCount: previous.attemptCount,
      analyzedContentHash: previous.analyzedContentHash,
      analyzedAt: previous.analyzedAt,
    }
  })
  const itemBlockingReasons = coverage.flatMap(item => item.status === 'blocked' ? [item.reason!] : [])
  const catalogBlockingReason = input.catalogComplete
    ? []
    : [input.catalogOmittedItemCount === null
        ? '项目目录清单不完整，遗漏数量未知，禁止生成 Wiki'
        : `项目目录清单遗漏 ${input.catalogOmittedItemCount} 项，禁止生成 Wiki`]
  const catalogIssueReasons = input.catalogBlockingReasons?.map(reason => reason.trim()).filter(Boolean) ?? []
  const blockingReasons = [...new Set([...catalogBlockingReason, ...catalogIssueReasons, ...itemBlockingReasons])]
  const preparedByCoverage = new Map<string, WikiMaterialRange[]>()
  for (const entry of input.entries) {
    if (entry.preparedMaterial === undefined) continue
    const coverageIdValue = wikiCoverageId(entry.sourceId, entry.path)
    preparedByCoverage.set(String(coverageIdValue), entry.preparedMaterial.ranges.map(range => ({
      ...structuredClone(range),
      id: wikiMaterialRangeId(coverageIdValue, range.ordinal, range.startByte, range.endByte),
      coverageId: coverageIdValue,
    })))
  }
  const reused = reusableLeafClaims(previousSnapshot, coverage, runIdValue)
  let tasks: WikiShardTask[] = []
  if (blockingReasons.length === 0) {
    tasks = [...Map.groupBy(
      coverage.filter(item => ['pending', 'analyzed'].includes(item.status)
        && !reused.coverageIds.has(String(item.id))
        && !preparedByCoverage.has(String(item.id))),
      item => item.shardKey,
    )].map(([shardKey, items]): WikiShardTask => ({
        id: wikiTaskId(runIdValue, shardKey),
        runId: runIdValue,
        kind: 'analysis',
        shardKey,
        coverageIds: items.map(item => item.id)
          .sort((left, right) => compareText(String(left), String(right))),
        claimIds: [],
        candidatePairs: [],
        materialRanges: [],
        status: 'planned',
        attemptCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }))
    for (const item of coverage) {
      const ranges = preparedByCoverage.get(String(item.id))
      if (ranges === undefined) continue
      for (const range of ranges) {
        const shardKey = `${item.shardKey}_range_${range.ordinal.toString().padStart(8, '0')}`
        tasks.push({
          id: wikiTaskId(runIdValue, shardKey),
          runId: runIdValue,
          kind: 'analysis',
          shardKey,
          coverageIds: [item.id],
          claimIds: [],
          candidatePairs: [],
          materialRanges: [range],
          status: 'planned',
          attemptCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }
    }
    tasks.sort((left, right) => compareText(left.shardKey, right.shardKey))
  }
  const run: WikiRun = {
    schemaVersion: WIKI_RUN_SCHEMA_VERSION,
    id: runIdValue,
    projectRoot,
    status: blockingReasons.length === 0 ? 'planned' : 'blocked',
    catalogHash: input.catalogHash,
    catalogComplete: input.catalogComplete,
    catalogOmittedItemCount: input.catalogOmittedItemCount,
    coverage: summarizeWikiCoverage(coverage),
    materialRanges: summarizeWikiMaterialRanges(tasks),
    tasks: summarizeWikiTasks(tasks),
    fileSynthesis: createUnplannedWikiFileSynthesisSummary(),
    consistency: createUnplannedWikiConsistencySummary(),
    pageGeneration: createUnplannedWikiPageGenerationSummary(),
    rootPageIds: [],
    blockingReasons,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  if (blockingReasons.length === 0 && tasks.length === 0 && reused.claims.length > 0) {
    tasks = createWikiVerificationTasks(runIdValue, coverage, reused.claims, timestamp)
    run.fileSynthesis = createWikiFileSynthesisTasks(
      runIdValue, coverage, reused.citations, reused.claims, [], timestamp,
    ).summary
    run.tasks = summarizeWikiTasks(tasks)
    run.materialRanges = summarizeWikiMaterialRanges(tasks)
    run.status = tasks.length > 0 ? 'verifying' : 'planned'
  }
  return finalizeWikiRunSnapshot({
    schemaVersion: WIKI_RUN_SCHEMA_VERSION,
    run,
    coverage,
    tasks,
    citations: reused.citations,
    claims: reused.claims,
    conflicts: [],
    pages: [],
  })
}
