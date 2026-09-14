import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import {
  createKnowledgeEffectiveVersionId,
  createKnowledgeGeneratedVersionId,
  KnowledgeEffectiveVersionId,
  KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN,
  KnowledgeGeneratedVersionId,
  KNOWLEDGE_GENERATED_VERSION_ID_PATTERN,
  KnowledgeHumanRevisionId,
  KNOWLEDGE_HUMAN_REVISION_ID_PATTERN,
  WikiCitationId,
  WIKI_CITATION_ID_PATTERN,
  WikiClaimId,
  WIKI_CLAIM_ID_PATTERN,
  WikiConflictId,
  WIKI_CONFLICT_ID_PATTERN,
  WikiPageId,
  WIKI_PAGE_ID_PATTERN,
  WikiRunId,
  WIKI_RUN_ID_PATTERN,
} from './ids.js'
import {
  parseWikiRunSnapshot,
  type WikiCompletionCheckId,
  type WikiCompletionReport,
  type WikiRunSnapshot,
} from './wiki-model.js'

/** Current immutable knowledge-version record format. */
export const KNOWLEDGE_VERSION_SCHEMA_VERSION = 1 as const

/** Current deterministic user and Agent projection format. */
export const KNOWLEDGE_PROJECTION_VERSION = 1 as const

/** One immutable manifest produced from a completed Wiki snapshot. */
export interface KnowledgeGeneratedVersion {
  schemaVersion: typeof KNOWLEDGE_VERSION_SCHEMA_VERSION
  id: KnowledgeGeneratedVersionId
  projectRoot: string
  runId: WikiRunId
  runSnapshotHash: string
  catalogHash: string
  completion: WikiCompletionReport
  pageIds: WikiPageId[]
  claimIds: WikiClaimId[]
  citationIds: WikiCitationId[]
  conflictIds: WikiConflictId[]
  createdAt: string
}

/** One immutable readable version derived from a generated version and human revisions. */
export interface KnowledgeEffectiveVersion {
  schemaVersion: typeof KNOWLEDGE_VERSION_SCHEMA_VERSION
  id: KnowledgeEffectiveVersionId
  projectRoot: string
  generatedVersionId: KnowledgeGeneratedVersionId
  runId: WikiRunId
  runSnapshotHash: string
  humanRevisionIds: KnowledgeHumanRevisionId[]
  projectionVersion: typeof KNOWLEDGE_PROJECTION_VERSION
  indexVersion: typeof KNOWLEDGE_PROJECTION_VERSION
  createdAt: string
}

/** Local selection and activation pointer for one single-repository project. */
export interface KnowledgeSelection {
  schemaVersion: typeof KNOWLEDGE_VERSION_SCHEMA_VERSION
  projectRoot: string
  revision: number
  mode: 'automatic' | 'fixed'
  analysisGeneration: number
  currentRunId?: WikiRunId
  effectiveVersionId?: KnowledgeEffectiveVersionId
  updatedAt: string
}

/** Consistent version state returned by one database read. */
export interface KnowledgeVersionState {
  selection?: KnowledgeSelection
  generatedVersion?: KnowledgeGeneratedVersion
  effectiveVersion?: KnowledgeEffectiveVersion
}

/** Records inserted and selected by one activation transaction. */
export interface KnowledgeActivationResult {
  generatedVersion: KnowledgeGeneratedVersion
  effectiveVersion: KnowledgeEffectiveVersion
  selection: KnowledgeSelection
}

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
const isoDate = z.string().datetime()
const absolutePath = z.string().min(1).superRefine((value, context) => {
  if (!isAbsolute(value) || resolve(value) !== value) {
    context.addIssue({ code: 'custom', message: 'knowledge version projectRoot must be a normalized absolute path' })
  }
})
const generatedVersionId = z.string().regex(new RegExp(KNOWLEDGE_GENERATED_VERSION_ID_PATTERN, 'u'))
  .transform(KnowledgeGeneratedVersionId)
const effectiveVersionId = z.string().regex(new RegExp(KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN, 'u'))
  .transform(KnowledgeEffectiveVersionId)
const humanRevisionId = z.string().regex(new RegExp(KNOWLEDGE_HUMAN_REVISION_ID_PATTERN, 'u'))
  .transform(KnowledgeHumanRevisionId)
const runId = z.string().regex(new RegExp(WIKI_RUN_ID_PATTERN, 'u')).transform(WikiRunId)
const pageId = z.string().regex(new RegExp(WIKI_PAGE_ID_PATTERN, 'u')).transform(WikiPageId)
const claimId = z.string().regex(new RegExp(WIKI_CLAIM_ID_PATTERN, 'u')).transform(WikiClaimId)
const citationId = z.string().regex(new RegExp(WIKI_CITATION_ID_PATTERN, 'u')).transform(WikiCitationId)
const conflictId = z.string().regex(new RegExp(WIKI_CONFLICT_ID_PATTERN, 'u')).transform(WikiConflictId)
const safePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const completionCheckIds = [
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
] as const satisfies readonly WikiCompletionCheckId[]
const completionReportSchema = z.object({
  eligibleForActivation: z.boolean(),
  checks: z.array(z.object({
    id: z.enum(completionCheckIds),
    state: z.enum(['pass', 'fail', 'unsupported']),
    issueCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).length(completionCheckIds.length),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.checks.map(check => check.id))
  if (ids.size !== completionCheckIds.length || completionCheckIds.some(id => !ids.has(id))) {
    context.addIssue({ code: 'custom', message: 'knowledge version completion report must contain every check exactly once' })
  }
  const eligible = value.checks.every(check => check.state === 'pass' && check.issueCount === 0)
  if (value.eligibleForActivation !== eligible) {
    context.addIssue({ code: 'custom', message: 'knowledge version activation eligibility is inconsistent with its checks' })
  }
})

function uniqueIds<T extends string>(schema: z.ZodType<T>): z.ZodType<T[]> {
  return z.array(schema).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'knowledge version ids must be unique' })
  })
}

const generatedVersionSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_VERSION_SCHEMA_VERSION),
  id: generatedVersionId,
  projectRoot: absolutePath,
  runId,
  runSnapshotHash: sha256,
  catalogHash: sha256,
  completion: completionReportSchema,
  pageIds: uniqueIds(pageId),
  claimIds: uniqueIds(claimId),
  citationIds: uniqueIds(citationId),
  conflictIds: uniqueIds(conflictId),
  createdAt: isoDate,
}).strict().superRefine((value, context) => {
  if (!value.completion.eligibleForActivation) {
    context.addIssue({ code: 'custom', message: 'generated knowledge version requires a passing completion report' })
  }
})

const effectiveVersionSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_VERSION_SCHEMA_VERSION),
  id: effectiveVersionId,
  projectRoot: absolutePath,
  generatedVersionId,
  runId,
  runSnapshotHash: sha256,
  humanRevisionIds: uniqueIds(humanRevisionId).default([]),
  projectionVersion: z.literal(KNOWLEDGE_PROJECTION_VERSION),
  indexVersion: z.literal(KNOWLEDGE_PROJECTION_VERSION),
  createdAt: isoDate,
}).strict()

const selectionSchema = z.object({
  schemaVersion: z.literal(KNOWLEDGE_VERSION_SCHEMA_VERSION),
  projectRoot: absolutePath,
  revision: safePositiveInteger,
  mode: z.enum(['automatic', 'fixed']),
  analysisGeneration: safePositiveInteger,
  currentRunId: runId.optional(),
  effectiveVersionId: effectiveVersionId.optional(),
  updatedAt: isoDate,
}).strict()

/** Strictly parse one generated version loaded from a durable boundary. */
export function parseKnowledgeGeneratedVersion(value: unknown): KnowledgeGeneratedVersion {
  return generatedVersionSchema.parse(value) as KnowledgeGeneratedVersion
}

/** Strictly parse one effective version loaded from a durable boundary. */
export function parseKnowledgeEffectiveVersion(value: unknown): KnowledgeEffectiveVersion {
  return effectiveVersionSchema.parse(value) as KnowledgeEffectiveVersion
}

/** Strictly parse one local project selection loaded from a durable boundary. */
export function parseKnowledgeSelection(value: unknown): KnowledgeSelection {
  return selectionSchema.parse(value) as KnowledgeSelection
}

/** Seal an immutable generated version from a completed, activation-eligible Wiki snapshot. */
export function createKnowledgeGeneratedVersion(
  value: WikiRunSnapshot,
  completion: WikiCompletionReport,
  createdAt = new Date().toISOString(),
): KnowledgeGeneratedVersion {
  const snapshot = parseWikiRunSnapshot(structuredClone(value))
  if (snapshot.run.status !== 'complete') throw new Error('knowledge version requires a complete Wiki run')
  return parseKnowledgeGeneratedVersion({
    schemaVersion: KNOWLEDGE_VERSION_SCHEMA_VERSION,
    id: createKnowledgeGeneratedVersionId(),
    projectRoot: snapshot.run.projectRoot,
    runId: snapshot.run.id,
    runSnapshotHash: snapshot.snapshotHash,
    catalogHash: snapshot.run.catalogHash,
    completion: structuredClone(completion),
    pageIds: snapshot.pages.map(page => page.id).sort(),
    claimIds: snapshot.claims.map(claim => claim.id).sort(),
    citationIds: snapshot.citations.map(citation => citation.id).sort(),
    conflictIds: snapshot.conflicts.map(conflict => conflict.id).sort(),
    createdAt,
  })
}

/** Prepare one effective version that initially contains the generated version without human revisions. */
export function createKnowledgeEffectiveVersion(
  generatedVersion: KnowledgeGeneratedVersion,
  createdAt = new Date().toISOString(),
): KnowledgeEffectiveVersion {
  const generated = parseKnowledgeGeneratedVersion(structuredClone(generatedVersion))
  return parseKnowledgeEffectiveVersion({
    schemaVersion: KNOWLEDGE_VERSION_SCHEMA_VERSION,
    id: createKnowledgeEffectiveVersionId(),
    projectRoot: generated.projectRoot,
    generatedVersionId: generated.id,
    runId: generated.runId,
    runSnapshotHash: generated.runSnapshotHash,
    humanRevisionIds: [],
    projectionVersion: KNOWLEDGE_PROJECTION_VERSION,
    indexVersion: KNOWLEDGE_PROJECTION_VERSION,
    createdAt,
  })
}

/** Prepare a new immutable effective version that includes one additional human revision. */
export function createRevisedKnowledgeEffectiveVersion(
  current: KnowledgeEffectiveVersion,
  revisionId: KnowledgeHumanRevisionId,
  createdAt = new Date().toISOString(),
): KnowledgeEffectiveVersion {
  const effective = parseKnowledgeEffectiveVersion(structuredClone(current))
  if (effective.humanRevisionIds.includes(revisionId)) return effective
  return parseKnowledgeEffectiveVersion({
    ...effective,
    id: createKnowledgeEffectiveVersionId(),
    humanRevisionIds: [...effective.humanRevisionIds, revisionId],
    createdAt,
  })
}

/** Select a new analysis run while preserving an existing effective version. */
export function selectKnowledgeRun(
  projectRoot: string,
  selectedRunId: WikiRunId,
  previous?: KnowledgeSelection,
  updatedAt = new Date().toISOString(),
): KnowledgeSelection {
  const root = resolve(projectRoot)
  if (previous !== undefined) {
    const current = parseKnowledgeSelection(structuredClone(previous))
    if (current.projectRoot !== root) throw new Error('knowledge selection belongs to another project')
    if (current.currentRunId === selectedRunId) return current
    return parseKnowledgeSelection({
      ...current,
      revision: current.revision + 1,
      analysisGeneration: current.analysisGeneration + 1,
      currentRunId: selectedRunId,
      updatedAt,
    })
  }
  return parseKnowledgeSelection({
    schemaVersion: KNOWLEDGE_VERSION_SCHEMA_VERSION,
    projectRoot: root,
    revision: 1,
    mode: 'automatic',
    analysisGeneration: 1,
    currentRunId: selectedRunId,
    updatedAt,
  })
}

/** Move one automatic selection to a prepared effective version. */
export function activateKnowledgeSelection(
  selection: KnowledgeSelection,
  effectiveVersion: KnowledgeEffectiveVersion,
  updatedAt = new Date().toISOString(),
): KnowledgeSelection {
  const current = parseKnowledgeSelection(structuredClone(selection))
  const effective = parseKnowledgeEffectiveVersion(structuredClone(effectiveVersion))
  if (current.mode !== 'automatic') throw new Error('fixed knowledge selection cannot be activated automatically')
  if (current.projectRoot !== effective.projectRoot || current.currentRunId !== effective.runId) {
    throw new Error('effective knowledge version does not match the current analysis selection')
  }
  if (current.effectiveVersionId === effective.id) return current
  return parseKnowledgeSelection({
    ...current,
    revision: current.revision + 1,
    effectiveVersionId: effective.id,
    updatedAt,
  })
}

/** Move a selection to a human-revised version and prevent unmerged background replacement. */
export function reviseKnowledgeSelection(
  selection: KnowledgeSelection,
  baseEffectiveVersionId: KnowledgeEffectiveVersionId,
  effectiveVersion: KnowledgeEffectiveVersion,
  updatedAt = new Date().toISOString(),
): KnowledgeSelection {
  const current = parseKnowledgeSelection(structuredClone(selection))
  const effective = parseKnowledgeEffectiveVersion(structuredClone(effectiveVersion))
  if (current.effectiveVersionId !== baseEffectiveVersionId) {
    throw new Error('human knowledge revision is based on another effective version')
  }
  if (current.projectRoot !== effective.projectRoot || current.currentRunId !== effective.runId) {
    throw new Error('human-revised effective version does not match the current project selection')
  }
  return parseKnowledgeSelection({
    ...current,
    revision: current.revision + 1,
    mode: 'fixed',
    effectiveVersionId: effective.id,
    updatedAt,
  })
}
