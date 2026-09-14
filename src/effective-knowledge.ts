import { z } from 'zod'
import {
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
  WikiPageId,
  WIKI_PAGE_ID_PATTERN,
  WikiRunId,
  WIKI_RUN_ID_PATTERN,
} from './ids.js'
import type { KnowledgeHumanRevision } from './knowledge-revision.js'
import type { KnowledgeEffectiveVersion, KnowledgeGeneratedVersion } from './knowledge-version.js'
import type { ProvenanceRef } from './model.js'
import { assertProvenanceRefs } from './schema.js'
import type { WikiRunSnapshot } from './wiki-model.js'

/** One original Claim citation retained beside a searchable effective Wiki page. */
export interface EffectiveKnowledgeSource {
  claimId: WikiClaimId
  citationId: WikiCitationId
  provenance: ProvenanceRef
}

/** One current EffectiveVersion page prepared for local full-text retrieval. */
export interface EffectiveKnowledgeDocument {
  pageId: WikiPageId
  projectRoot: string
  runId: WikiRunId
  generatedVersionId: KnowledgeGeneratedVersionId
  effectiveVersionId: KnowledgeEffectiveVersionId
  runSnapshotHash: string
  title: string
  content: string
  status: 'draft' | 'verified' | 'conflicted' | 'stale'
  tags: string[]
  humanRevisionIds: KnowledgeHumanRevisionId[]
  bodyRevisionId?: KnowledgeHumanRevisionId
  noteRevisionIds: KnowledgeHumanRevisionId[]
  sources: EffectiveKnowledgeSource[]
  updatedAt: string
}

/** Bounded search request over only the selected EffectiveVersion of one project. */
export interface EffectiveKnowledgeSearchRequest {
  query: string
  projectRoot: string
  limit: number
  maxChars: number
  signal?: AbortSignal
}

/** One version-addressed effective Wiki page returned from the local FTS index. */
export interface EffectiveKnowledgeSearchHit extends EffectiveKnowledgeDocument {
  score: number
  truncated: boolean
}

const id = (pattern: string) => z.string().regex(new RegExp(pattern, 'u'))
const sourceSchema = z.object({
  claimId: id(WIKI_CLAIM_ID_PATTERN).transform(WikiClaimId),
  citationId: id(WIKI_CITATION_ID_PATTERN).transform(WikiCitationId),
  provenance: z.unknown(),
}).strict()
const documentSchema = z.object({
  pageId: id(WIKI_PAGE_ID_PATTERN).transform(WikiPageId),
  projectRoot: z.string().min(1),
  runId: id(WIKI_RUN_ID_PATTERN).transform(WikiRunId),
  generatedVersionId: id(KNOWLEDGE_GENERATED_VERSION_ID_PATTERN).transform(KnowledgeGeneratedVersionId),
  effectiveVersionId: id(KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN).transform(KnowledgeEffectiveVersionId),
  runSnapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  title: z.string().min(1).max(300),
  content: z.string(),
  status: z.enum(['draft', 'verified', 'conflicted', 'stale']),
  tags: z.array(z.string()).max(100),
  humanRevisionIds: z.array(id(KNOWLEDGE_HUMAN_REVISION_ID_PATTERN).transform(KnowledgeHumanRevisionId)),
  bodyRevisionId: id(KNOWLEDGE_HUMAN_REVISION_ID_PATTERN).transform(KnowledgeHumanRevisionId).optional(),
  noteRevisionIds: z.array(id(KNOWLEDGE_HUMAN_REVISION_ID_PATTERN).transform(KnowledgeHumanRevisionId)),
  sources: z.array(sourceSchema),
  updatedAt: z.string().datetime(),
}).strict()

/** Parse one derived effective-knowledge search document from local durable storage. */
export function parseEffectiveKnowledgeDocument(value: unknown): EffectiveKnowledgeDocument {
  const parsed = documentSchema.parse(value)
  for (const source of parsed.sources) assertProvenanceRefs([source.provenance])
  return parsed as EffectiveKnowledgeDocument
}

/** Build the searchable pages for one immutable generated version plus its selected human revision chain. */
export function effectiveKnowledgeDocuments(
  snapshot: WikiRunSnapshot,
  generated: KnowledgeGeneratedVersion,
  effective: KnowledgeEffectiveVersion,
  availableRevisions: readonly KnowledgeHumanRevision[],
): EffectiveKnowledgeDocument[] {
  if (snapshot.run.id !== generated.runId || snapshot.snapshotHash !== generated.runSnapshotHash
    || effective.projectRoot !== generated.projectRoot || effective.generatedVersionId !== generated.id
    || effective.runId !== generated.runId || effective.runSnapshotHash !== snapshot.snapshotHash) {
    throw new Error('effective knowledge search inputs do not identify one immutable Wiki generation')
  }
  const revisionById = new Map(availableRevisions.map(revision => [String(revision.id), revision]))
  const revisions = effective.humanRevisionIds.map(revisionId => {
    const revision = revisionById.get(String(revisionId))
    if (revision === undefined) throw new Error(`effective knowledge revision is missing: ${revisionId}`)
    if (revision.projectRoot !== effective.projectRoot || revision.generatedVersionId !== generated.id) {
      throw new Error('effective knowledge revision crosses project or generated-version ownership')
    }
    return revision
  })
  for (let index = 1; index < revisions.length; index += 1) {
    if (revisions[index]!.baseEffectiveVersionId !== revisions[index - 1]!.effectiveVersionId) {
      throw new Error('effective knowledge revision chain is discontinuous')
    }
  }
  if (revisions.length > 0 && revisions.at(-1)!.effectiveVersionId !== effective.id) {
    throw new Error('effective knowledge revision chain does not reach the selected version')
  }

  const pageById = new Map(snapshot.pages.filter(page => page.legacy !== true).map(page => [String(page.id), page]))
  const claimById = new Map(snapshot.claims.map(claim => [String(claim.id), claim]))
  const citationById = new Map(snapshot.citations.map(citation => [String(citation.id), citation]))
  return generated.pageIds.map(pageId => {
    const page = pageById.get(String(pageId))
    if (page === undefined) throw new Error(`generated knowledge page is missing: ${pageId}`)
    const pageRevisions = revisions.filter(revision => revision.pageId === page.id)
    const bodyRevision = pageRevisions.filter(revision => revision.kind === 'replace-page-body').at(-1)
    const notes = pageRevisions.filter(revision => revision.kind === 'append-page-note')
    const claims = page.claimIds.map(claimId => {
      const claim = claimById.get(String(claimId))
      if (claim === undefined || !generated.claimIds.includes(claim.id)) {
        throw new Error(`generated knowledge page Claim is missing: ${claimId}`)
      }
      return claim
    })
    const sources = bodyRevision === undefined
      ? claims.flatMap(claim => claim.citationIds.map(citationId => {
          const citation = citationById.get(String(citationId))
          if (citation === undefined) throw new Error(`generated knowledge citation is missing: ${citationId}`)
          return { claimId: claim.id, citationId: citation.id, provenance: structuredClone(citation.provenance) }
        }))
      : []
    const generatedContent = claims.map(claim => `[${claim.kind}:${claim.status}] ${claim.statement}`).join('\n')
    const noteContent = notes.map(note => `[human-note:${note.id}] ${note.content}`).join('\n')
    const primaryContent = bodyRevision === undefined ? generatedContent : `[human-body:${bodyRevision.id}] ${bodyRevision.content}`
    const tags = [...new Set([
      'effective-wiki-page',
      page.status,
      ...claims.flatMap(claim => [claim.kind, claim.status]),
      ...(pageRevisions.length === 0 ? [] : ['human-revision']),
    ])]
    return parseEffectiveKnowledgeDocument({
      pageId: page.id,
      projectRoot: effective.projectRoot,
      runId: effective.runId,
      generatedVersionId: generated.id,
      effectiveVersionId: effective.id,
      runSnapshotHash: effective.runSnapshotHash,
      title: bodyRevision?.title ?? page.title,
      content: [primaryContent, noteContent].filter(Boolean).join('\n\n'),
      status: page.status,
      tags,
      humanRevisionIds: pageRevisions.map(revision => revision.id),
      ...(bodyRevision === undefined ? {} : { bodyRevisionId: bodyRevision.id }),
      noteRevisionIds: notes.map(note => note.id),
      sources,
      updatedAt: pageRevisions.at(-1)?.createdAt ?? effective.createdAt,
    })
  })
}
