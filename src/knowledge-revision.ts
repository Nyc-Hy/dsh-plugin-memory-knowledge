import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import {
  KnowledgeEffectiveVersionId,
  KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN,
  KnowledgeGeneratedVersionId,
  KNOWLEDGE_GENERATED_VERSION_ID_PATTERN,
  KnowledgeHumanRevisionId,
  KNOWLEDGE_HUMAN_REVISION_ID_PATTERN,
  KnowledgeHumanRevisionRequestId,
  KNOWLEDGE_HUMAN_REVISION_REQUEST_ID_PATTERN,
  WikiClaimId,
  WIKI_CLAIM_ID_PATTERN,
  WikiPageId,
  WIKI_PAGE_ID_PATTERN,
} from './ids.js'
import {
  parseKnowledgeEffectiveVersion,
  parseKnowledgeSelection,
  type KnowledgeEffectiveVersion,
  type KnowledgeSelection,
} from './knowledge-version.js'

/** Current immutable operator-authored knowledge revision format. */
export const KNOWLEDGE_HUMAN_REVISION_SCHEMA_VERSION = 1 as const

/** Explicit meaning selected by the operator before saving free text. */
export type KnowledgeHumanRevisionKind = 'replace-page-body' | 'append-page-note'

interface KnowledgeHumanRevisionInputBase {
  requestId: KnowledgeHumanRevisionRequestId
  projectRoot: string
  expectedSelectionRevision: number
  baseEffectiveVersionId: KnowledgeEffectiveVersionId
  pageId: WikiPageId
  content: string
}

/** One validated save request from an operator editing effective project knowledge. */
export type CreateKnowledgeHumanRevisionInput = KnowledgeHumanRevisionInputBase & (
  | { kind: 'replace-page-body'; title: string }
  | { kind: 'append-page-note'; title?: never }
)

interface KnowledgeHumanRevisionBase {
  schemaVersion: typeof KNOWLEDGE_HUMAN_REVISION_SCHEMA_VERSION
  id: KnowledgeHumanRevisionId
  requestId: KnowledgeHumanRevisionRequestId
  requestFingerprint: string
  revision: number
  projectRoot: string
  generatedVersionId: KnowledgeGeneratedVersionId
  baseEffectiveVersionId: KnowledgeEffectiveVersionId
  effectiveVersionId: KnowledgeEffectiveVersionId
  pageId: WikiPageId
  content: string
  affectedClaimIds: WikiClaimId[]
  createdAt: string
}

/** One immutable operator edit layered over an immutable generated Wiki version. */
export type KnowledgeHumanRevision = KnowledgeHumanRevisionBase & (
  | { kind: 'replace-page-body'; title: string }
  | { kind: 'append-page-note'; title?: never }
)

/** Immutable commit result retained for idempotent save retries. */
export interface KnowledgeHumanRevisionResult {
  revision: KnowledgeHumanRevision
  effectiveVersion: KnowledgeEffectiveVersion
  selection: KnowledgeSelection
}

const absolutePath = z.string().min(1).superRefine((value, context) => {
  if (!isAbsolute(value) || resolve(value) !== value) {
    context.addIssue({ code: 'custom', message: 'knowledge revision projectRoot must be a normalized absolute path' })
  }
})
const isoDate = z.string().datetime()
const safePositiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const requestId = z.string().regex(new RegExp(KNOWLEDGE_HUMAN_REVISION_REQUEST_ID_PATTERN, 'u'))
  .transform(KnowledgeHumanRevisionRequestId)
const revisionId = z.string().regex(new RegExp(KNOWLEDGE_HUMAN_REVISION_ID_PATTERN, 'u'))
  .transform(KnowledgeHumanRevisionId)
const generatedVersionId = z.string().regex(new RegExp(KNOWLEDGE_GENERATED_VERSION_ID_PATTERN, 'u'))
  .transform(KnowledgeGeneratedVersionId)
const effectiveVersionId = z.string().regex(new RegExp(KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN, 'u'))
  .transform(KnowledgeEffectiveVersionId)
const pageId = z.string().regex(new RegExp(WIKI_PAGE_ID_PATTERN, 'u')).transform(WikiPageId)
const claimId = z.string().regex(new RegExp(WIKI_CLAIM_ID_PATTERN, 'u')).transform(WikiClaimId)
const humanText = z.string().trim().min(1).max(20_000)
const humanTitle = z.string().trim().min(1).max(300)

const createInputBase = {
  requestId,
  projectRoot: absolutePath,
  expectedSelectionRevision: safePositiveInteger,
  baseEffectiveVersionId: effectiveVersionId,
  pageId,
  content: humanText,
}
const createInputSchema = z.discriminatedUnion('kind', [
  z.object({ ...createInputBase, kind: z.literal('replace-page-body'), title: humanTitle }).strict(),
  z.object({ ...createInputBase, kind: z.literal('append-page-note') }).strict(),
])

const revisionBase = {
  schemaVersion: z.literal(KNOWLEDGE_HUMAN_REVISION_SCHEMA_VERSION),
  id: revisionId,
  requestId,
  requestFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  revision: safePositiveInteger,
  projectRoot: absolutePath,
  generatedVersionId,
  baseEffectiveVersionId: effectiveVersionId,
  effectiveVersionId,
  pageId,
  content: humanText,
  affectedClaimIds: z.array(claimId).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'knowledge revision affected Claim ids must be unique' })
    }
  }),
  createdAt: isoDate,
}
const revisionSchema = z.discriminatedUnion('kind', [
  z.object({ ...revisionBase, kind: z.literal('replace-page-body'), title: humanTitle }).strict(),
  z.object({ ...revisionBase, kind: z.literal('append-page-note') }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'append-page-note' && value.affectedClaimIds.length !== 0) {
    context.addIssue({ code: 'custom', message: 'an appended operator note cannot invalidate generated Claims' })
  }
})

/** Strictly parse one operator edit request from a durable or RPC boundary. */
export function parseCreateKnowledgeHumanRevisionInput(value: unknown): CreateKnowledgeHumanRevisionInput {
  return createInputSchema.parse(value) as CreateKnowledgeHumanRevisionInput
}

/** Strictly parse one immutable human revision from durable storage. */
export function parseKnowledgeHumanRevision(value: unknown): KnowledgeHumanRevision {
  return revisionSchema.parse(value) as KnowledgeHumanRevision
}

/** Compute the stable identity used to reject reused request ids with different content. */
export function knowledgeHumanRevisionRequestFingerprint(input: CreateKnowledgeHumanRevisionInput): string {
  const request = parseCreateKnowledgeHumanRevisionInput(structuredClone(input))
  return `sha256:${createHash('sha256').update(JSON.stringify([
    request.projectRoot,
    request.expectedSelectionRevision,
    request.baseEffectiveVersionId,
    request.pageId,
    request.kind,
    request.title ?? null,
    request.content,
  ])).digest('hex')}`
}

/** Strictly parse one persisted idempotent save result. */
export function parseKnowledgeHumanRevisionResult(value: unknown): KnowledgeHumanRevisionResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('knowledge human revision result must be an object')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join('\0') !== ['effectiveVersion', 'revision', 'selection'].sort().join('\0')) {
    throw new Error('knowledge human revision result contains unknown fields')
  }
  return {
    revision: parseKnowledgeHumanRevision(record['revision']),
    effectiveVersion: parseKnowledgeEffectiveVersion(record['effectiveVersion']),
    selection: parseKnowledgeSelection(record['selection']),
  }
}
