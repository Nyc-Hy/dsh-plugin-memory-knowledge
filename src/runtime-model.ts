import type { KnowledgeCardId, KnowledgeSourceId, MemoryCandidateId, MemoryId, WikiPageId } from './ids.js'
import type {
  KnowledgeCard,
  KnowledgeSection,
  MemoryEntry,
  ProvenanceRef,
  SharedKnowledgeScope,
} from './model.js'
import type { SourceUnderstandingSummary } from './source-records.js'

/** Review lifecycle of one local memory candidate. */
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'promoted'

/** Where an accepted personal candidate may be recalled. */
export type MemoryCandidateApplicability = 'global' | 'project'

/** Shared review fields for local memory and Knowledge Card candidates. */
interface ReviewCandidateBase {
  id: MemoryCandidateId
  revision: number
  applicability: MemoryCandidateApplicability
  projectRoot?: string
  title: string
  content: string
  tags: string[]
  sensitivity: MemoryEntry['sensitivity']
  status: MemoryCandidateStatus
  suggestedBy: 'model' | 'human' | 'conversation' | 'inventory' | 'wiki'
  provenance: ProvenanceRef[]
  createdAt: string
  updatedAt: string
  reviewedAt?: string
}

/** Durable local long-term-memory candidate awaiting or recording a human decision. */
export interface MemoryCandidate extends ReviewCandidateBase {
  target: 'memory'
  kind: MemoryEntry['kind']
  localMemoryId?: MemoryId
  promotedMemoryId?: MemoryId
}

/** Lifecycle of one local long-term memory entry. */
export type LocalMemoryEntryStatus = 'active' | 'deprecated' | 'deleted'

/** One local long-term memory entry independently owned from its review candidate. */
export interface LocalMemoryEntry {
  id: MemoryId
  revision: number
  applicability: MemoryCandidateApplicability
  projectRoot?: string
  kind: MemoryEntry['kind']
  status: LocalMemoryEntryStatus
  title: string
  content: string
  conditions: string[]
  tags: string[]
  sensitivity: MemoryEntry['sensitivity']
  provenance: ProvenanceRef[]
  supersedes: MemoryId[]
  conflictsWith: MemoryId[]
  sourceCandidateId?: MemoryCandidateId
  createdAt: string
  updatedAt: string
}

/** Reason recorded beside one immutable local memory revision. */
export type LocalMemoryRevisionKind = 'created' | 'edited' | 'deprecated' | 'deleted' | 'restored'

/** Immutable historical snapshot of one local long-term memory entry. */
export interface LocalMemoryRevision {
  entry: LocalMemoryEntry
  kind: LocalMemoryRevisionKind
}

/** Query for bounded local long-term memory entries. */
export interface ListLocalMemoryEntriesRequest {
  projectRoot?: string
  status?: LocalMemoryEntryStatus
  limit: number
}

/** Fields accepted when a user explicitly creates a long-term memory entry. */
export interface CreateLocalMemoryEntryInput {
  applicability: MemoryCandidateApplicability
  projectRoot?: string
  kind: MemoryEntry['kind']
  title: string
  content: string
  conditions: string[]
  tags: string[]
  sensitivity: MemoryEntry['sensitivity']
  /** Source evidence; an explicit operator-created local entry may start empty. */
  provenance: ProvenanceRef[]
}

/** Editable fields of one local long-term memory entry. */
export interface UpdateLocalMemoryEntryInput {
  title: string
  content: string
  kind: MemoryEntry['kind']
  conditions: string[]
  tags: string[]
  sensitivity: MemoryEntry['sensitivity']
  supersedes: MemoryId[]
  conflictsWith: MemoryId[]
}

/** Stable checkpoint that makes deterministic candidate generation idempotent. */
export interface KnowledgeCandidateGeneration {
  key: string
  generator: 'source-inventory' | 'source-record-map' | 'source-evidence-map' | 'wiki-page'
  version: number
  sourceId: KnowledgeSourceId
  inventoryHash?: string
  catalogHash?: string
  inputHash?: string
}

/** Canonical Knowledge Card fields retained locally until the candidate is approved. */
export interface KnowledgeCardDraft {
  targetCardId?: KnowledgeCardId
  baseRevision?: number
  scope: SharedKnowledgeScope
  kind: KnowledgeCard['kind']
  summary: string
  sections: KnowledgeSection[]
  provenance: ProvenanceRef[]
  sourceRevisions: KnowledgeCard['sourceRevisions']
  evidenceClass: KnowledgeCard['evidenceClass']
}

/** Durable local Knowledge Card candidate produced from deterministic project evidence. */
export interface KnowledgeCardCandidate extends ReviewCandidateBase {
  target: 'knowledge-card'
  applicability: 'project'
  projectRoot: string
  kind: KnowledgeCard['kind']
  sensitivity: 'normal'
  suggestedBy: 'inventory' | 'wiki'
  generation: KnowledgeCandidateGeneration
  card: KnowledgeCardDraft
  promotedKnowledgeCardId?: KnowledgeCardId
}

/** One candidate shown in the shared human review inbox. */
export type ReviewCandidate = MemoryCandidate | KnowledgeCardCandidate

/** One source intentionally omitted from deterministic candidate generation. */
export interface KnowledgeCardCandidateSkip {
  sourceId?: KnowledgeSourceId
  pageId?: WikiPageId
  cardKind?: 'overview' | 'architecture' | 'module'
  kind: 'source-limit' | 'source-degraded' | 'source-dirty' | 'missing-revision' | 'missing-understanding'
    | 'missing-evidence' | 'already-current' | 'ambiguous-overview' | 'ambiguous-architecture' | 'ambiguous-module'
    | 'wiki-run-incomplete' | 'wiki-page-not-verified' | 'wiki-page-unsupported-evidence' | 'wiki-source-changed'
}

/** Durable outcome of one explicit deterministic candidate-generation request. */
export interface GenerateKnowledgeCardCandidatesResult {
  candidates: KnowledgeCardCandidate[]
  skipped: KnowledgeCardCandidateSkip[]
  understandings: SourceUnderstandingSummary[]
}

/** Input accepted when a producer proposes a local candidate. */
export interface SaveMemoryCandidateInput {
  target: 'memory'
  applicability: MemoryCandidateApplicability
  projectRoot?: string
  kind: MemoryEntry['kind']
  title: string
  content: string
  tags: string[]
  sensitivity: MemoryEntry['sensitivity']
  suggestedBy: MemoryCandidate['suggestedBy']
  provenance: ProvenanceRef[]
}

/** Durable identity of one conversation extractor's progress through a session log. */
export interface ConversationExtractionKey {
  sessionId: Extract<ProvenanceRef, { kind: 'session' }>['sessionId']
  extractor: string
  version: number
}

/** Initializes a conversation extractor without backfilling older session history. */
export interface PrepareConversationExtractionRequest extends ConversationExtractionKey {
  baselineSeq: number
}

/** Atomically checkpoints one turn and optionally saves its extracted candidate. */
export interface RecordConversationExtractionRequest extends ConversationExtractionKey {
  turnEndSeq: number
  candidate?: SaveMemoryCandidateInput
}

/** Durable result of preparing one conversation extractor checkpoint. */
export interface ConversationExtractionCheckpoint extends ConversationExtractionKey {
  throughSeq: number
  updatedAt: string
}

/** Result of atomically recording one conversation turn. */
export interface RecordConversationExtractionResult {
  outcome: 'candidate' | 'skipped' | 'already-processed'
  throughSeq: number
  candidate?: MemoryCandidate
}

/** Input accepted from the deterministic Source inventory candidate generator. */
export interface SaveKnowledgeCardCandidateInput {
  target: 'knowledge-card'
  applicability: 'project'
  projectRoot: string
  kind: KnowledgeCard['kind']
  title: string
  content: string
  tags: string[]
  sensitivity: 'normal'
  suggestedBy: 'inventory' | 'wiki'
  provenance: ProvenanceRef[]
  generation: KnowledgeCandidateGeneration
  card: KnowledgeCardDraft
}

/** Query for local review candidates. */
export interface ListReviewCandidatesRequest {
  projectRoot?: string
  applicability?: MemoryCandidateApplicability
  status?: MemoryCandidateStatus
  limit: number
}

/** Human decision applied to a pending local candidate. */
export type ReviewCandidateDecision = 'accept' | 'reject'

/** Record domain selected by a caller querying the shared local index. */
export type MemoryRecordDomain = 'memory' | 'knowledge'

/** Scope behavior selected by a caller querying the shared local index. */
export type MemoryScopeMode = 'applicable' | 'selected'

/** Search request across accepted personal memory and reviewed project knowledge. */
export interface MemorySearchRequest {
  query: string
  projectRoot?: string
  domain?: MemoryRecordDomain
  scopeMode?: MemoryScopeMode
  limit: number
  maxChars: number
  includeRestricted?: boolean
  signal?: AbortSignal
}

/** One bounded search result with enough provenance for a recall trace. */
export interface MemorySearchHit {
  id: MemoryCandidateId | MemoryId | KnowledgeCardId
  recordType: 'personal-memory' | 'project-memory' | 'knowledge-card'
  title: string
  content: string
  tags: string[]
  evidenceClass: MemoryEntry['evidenceClass']
  sensitivity: MemoryEntry['sensitivity']
  projectRoot?: string
  scope?: SharedKnowledgeScope
  provenance: ProvenanceRef[]
  updatedAt: string
  score: number
  truncated: boolean
}

/** Query for recallable personal memory and one project's reviewed knowledge. */
export interface ListRecallableMemoryRequest {
  projectRoot?: string
  domain?: MemoryRecordDomain
  scopeMode?: MemoryScopeMode
  limit: number
}

/** One complete, currently recallable record shown in the human memory browser. */
export interface RecallableMemoryRecord {
  id: MemorySearchHit['id']
  recordType: MemorySearchHit['recordType']
  title: string
  content: string
  tags: string[]
  evidenceClass: MemoryEntry['evidenceClass']
  sensitivity: MemoryEntry['sensitivity']
  status: string
  projectRoot?: string
  scope?: SharedKnowledgeScope
  provenance: ProvenanceRef[]
  updatedAt: string
}

/** Exact stored facts behind one candidate or indexed recall document. */
export interface MemoryTrace {
  id: MemorySearchHit['id']
  recordType: 'candidate' | MemorySearchHit['recordType']
  title: string
  content: string
  status: string
  sensitivity: MemoryEntry['sensitivity']
  projectRoot?: string
  scope?: SharedKnowledgeScope
  provenance: ProvenanceRef[]
  createdAt?: string
  updatedAt: string
}

/** Result of promoting one reviewed long-term-memory candidate. */
export interface PromoteMemoryCandidateResult {
  recordType: 'memory'
  candidate: MemoryCandidate
  memory: MemoryEntry
  path: string
}

/** Result of promoting one reviewed Knowledge Card candidate. */
export interface PromoteKnowledgeCardCandidateResult {
  recordType: 'knowledge-card'
  candidate: KnowledgeCardCandidate
  card: KnowledgeCard
  path: string
}

/** Result of materializing one reviewed candidate into Git-shared canonical data. */
export type PromoteReviewCandidateResult = PromoteMemoryCandidateResult | PromoteKnowledgeCardCandidateResult
