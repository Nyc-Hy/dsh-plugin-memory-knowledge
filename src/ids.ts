import { randomUUID } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one Git-shareable knowledge space. */
export type KnowledgeSpaceId = Branded<'KnowledgeSpaceId'>

/** Identifies one repository or document source inside a knowledge space. */
export type KnowledgeSourceId = Branded<'KnowledgeSourceId'>

/** Identifies one long-term memory entry. */
export type MemoryId = Branded<'MemoryId'>

/** Identifies one structured knowledge card. */
export type KnowledgeCardId = Branded<'KnowledgeCardId'>

/** Identifies one local review candidate. */
export type MemoryCandidateId = Branded<'MemoryCandidateId'>

/** Identifies one deterministic symbol definition in a Source checkpoint. */
export type SourceSymbolId = Branded<'SourceSymbolId'>

/** Identifies one local LLM Wiki generation run. */
export type WikiRunId = Branded<'WikiRunId'>

/** Identifies one project file in an LLM Wiki coverage catalog. */
export type WikiCoverageId = Branded<'WikiCoverageId'>

/** Identifies one verified byte range inside a Wiki coverage file. */
export type WikiMaterialRangeId = Branded<'WikiMaterialRangeId'>

/** Identifies one durable shard-analysis task inside an LLM Wiki run. */
export type WikiTaskId = Branded<'WikiTaskId'>

/** Identifies one evidence citation retained by an LLM Wiki run. */
export type WikiCitationId = Branded<'WikiCitationId'>

/** Identifies one auditable statement retained by an LLM Wiki run. */
export type WikiClaimId = Branded<'WikiClaimId'>

/** Identifies one unresolved or resolved LLM Wiki contradiction. */
export type WikiConflictId = Branded<'WikiConflictId'>

/** Identifies one generated LLM Wiki page draft. */
export type WikiPageId = Branded<'WikiPageId'>

/** Identifies one immutable generated project-knowledge version. */
export type KnowledgeGeneratedVersionId = Branded<'KnowledgeGeneratedVersionId'>

/** Identifies one immutable effective project-knowledge version. */
export type KnowledgeEffectiveVersionId = Branded<'KnowledgeEffectiveVersionId'>

/** Identifies one immutable operator-authored project-knowledge revision. */
export type KnowledgeHumanRevisionId = Branded<'KnowledgeHumanRevisionId'>

/** Identifies one idempotent operator save request. */
export type KnowledgeHumanRevisionRequestId = Branded<'KnowledgeHumanRevisionRequestId'>

/** JSON Schema pattern for {@link KnowledgeSpaceId}. */
export const KNOWLEDGE_SPACE_ID_PATTERN = '^ks_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link KnowledgeSourceId}. */
export const KNOWLEDGE_SOURCE_ID_PATTERN = '^src_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link MemoryId}. */
export const MEMORY_ID_PATTERN = '^mem_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link KnowledgeCardId}. */
export const KNOWLEDGE_CARD_ID_PATTERN = '^card_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link MemoryCandidateId}. */
export const MEMORY_CANDIDATE_ID_PATTERN = '^cand_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link SourceSymbolId}. */
export const SOURCE_SYMBOL_ID_PATTERN = '^sym_[0-9a-f]{64}$'

/** JSON Schema pattern for {@link WikiRunId}. */
export const WIKI_RUN_ID_PATTERN = '^wrun_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link WikiCoverageId}. */
export const WIKI_COVERAGE_ID_PATTERN = '^wcov_[0-9a-f]{64}$'

/** JSON Schema pattern for {@link WikiMaterialRangeId}. */
export const WIKI_MATERIAL_RANGE_ID_PATTERN = '^wrange_[0-9a-f]{64}$'

/** JSON Schema pattern for {@link WikiTaskId}. */
export const WIKI_TASK_ID_PATTERN = '^wtask_[0-9a-f]{64}$'

/** JSON Schema pattern for {@link WikiCitationId}. */
export const WIKI_CITATION_ID_PATTERN = '^wcite_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link WikiClaimId}. */
export const WIKI_CLAIM_ID_PATTERN = '^wclaim_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link WikiConflictId}. */
export const WIKI_CONFLICT_ID_PATTERN = '^wconf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link WikiPageId}. */
export const WIKI_PAGE_ID_PATTERN = '^wpage_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link KnowledgeGeneratedVersionId}. */
export const KNOWLEDGE_GENERATED_VERSION_ID_PATTERN = '^kgv_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link KnowledgeEffectiveVersionId}. */
export const KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN = '^kev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link KnowledgeHumanRevisionId}. */
export const KNOWLEDGE_HUMAN_REVISION_ID_PATTERN = '^khr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** JSON Schema pattern for {@link KnowledgeHumanRevisionRequestId}. */
export const KNOWLEDGE_HUMAN_REVISION_REQUEST_ID_PATTERN = '^khreq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/** Brand a validated external value as a {@link KnowledgeSpaceId}. */
export function KnowledgeSpaceId(value: string): KnowledgeSpaceId {
  return value as KnowledgeSpaceId
}

/** Brand a validated external value as a {@link KnowledgeSourceId}. */
export function KnowledgeSourceId(value: string): KnowledgeSourceId {
  return value as KnowledgeSourceId
}

/** Brand a validated external value as a {@link MemoryId}. */
export function MemoryId(value: string): MemoryId {
  return value as MemoryId
}

/** Brand a validated external value as a {@link KnowledgeCardId}. */
export function KnowledgeCardId(value: string): KnowledgeCardId {
  return value as KnowledgeCardId
}

/** Brand a validated external value as a {@link MemoryCandidateId}. */
export function MemoryCandidateId(value: string): MemoryCandidateId {
  return value as MemoryCandidateId
}

/** Brand a validated deterministic value as a {@link SourceSymbolId}. */
export function SourceSymbolId(value: string): SourceSymbolId {
  return value as SourceSymbolId
}

/** Brand a validated external value as a {@link WikiRunId}. */
export function WikiRunId(value: string): WikiRunId {
  return value as WikiRunId
}

/** Brand a validated deterministic value as a {@link WikiCoverageId}. */
export function WikiCoverageId(value: string): WikiCoverageId {
  return value as WikiCoverageId
}

/** Brand a validated deterministic value as a {@link WikiMaterialRangeId}. */
export function WikiMaterialRangeId(value: string): WikiMaterialRangeId {
  return value as WikiMaterialRangeId
}

/** Brand a validated deterministic value as a {@link WikiTaskId}. */
export function WikiTaskId(value: string): WikiTaskId {
  return value as WikiTaskId
}

/** Brand a validated external value as a {@link WikiCitationId}. */
export function WikiCitationId(value: string): WikiCitationId {
  return value as WikiCitationId
}

/** Brand a validated external value as a {@link WikiClaimId}. */
export function WikiClaimId(value: string): WikiClaimId {
  return value as WikiClaimId
}

/** Brand a validated external value as a {@link WikiConflictId}. */
export function WikiConflictId(value: string): WikiConflictId {
  return value as WikiConflictId
}

/** Brand a validated external value as a {@link WikiPageId}. */
export function WikiPageId(value: string): WikiPageId {
  return value as WikiPageId
}

/** Brand a validated external value as a {@link KnowledgeGeneratedVersionId}. */
export function KnowledgeGeneratedVersionId(value: string): KnowledgeGeneratedVersionId {
  return value as KnowledgeGeneratedVersionId
}

/** Brand a validated external value as a {@link KnowledgeEffectiveVersionId}. */
export function KnowledgeEffectiveVersionId(value: string): KnowledgeEffectiveVersionId {
  return value as KnowledgeEffectiveVersionId
}

/** Brand a validated external value as a {@link KnowledgeHumanRevisionId}. */
export function KnowledgeHumanRevisionId(value: string): KnowledgeHumanRevisionId {
  return value as KnowledgeHumanRevisionId
}

/** Brand a validated external value as a {@link KnowledgeHumanRevisionRequestId}. */
export function KnowledgeHumanRevisionRequestId(value: string): KnowledgeHumanRevisionRequestId {
  return value as KnowledgeHumanRevisionRequestId
}

/** Create a random Git-shareable knowledge-space id. */
export function createKnowledgeSpaceId(): KnowledgeSpaceId {
  return KnowledgeSpaceId(`ks_${randomUUID()}`)
}

/** Create a random knowledge-source id. */
export function createKnowledgeSourceId(): KnowledgeSourceId {
  return KnowledgeSourceId(`src_${randomUUID()}`)
}

/** Create a random memory-entry id. */
export function createMemoryId(): MemoryId {
  return MemoryId(`mem_${randomUUID()}`)
}

/** Create a random knowledge-card id. */
export function createKnowledgeCardId(): KnowledgeCardId {
  return KnowledgeCardId(`card_${randomUUID()}`)
}

/** Create a random local candidate id. */
export function createMemoryCandidateId(): MemoryCandidateId {
  return MemoryCandidateId(`cand_${randomUUID()}`)
}

/** Create a random LLM Wiki run id. */
export function createWikiRunId(): WikiRunId {
  return WikiRunId(`wrun_${randomUUID()}`)
}

/** Create a random LLM Wiki citation id. */
export function createWikiCitationId(): WikiCitationId {
  return WikiCitationId(`wcite_${randomUUID()}`)
}

/** Create a random LLM Wiki claim id. */
export function createWikiClaimId(): WikiClaimId {
  return WikiClaimId(`wclaim_${randomUUID()}`)
}

/** Create a random LLM Wiki conflict id. */
export function createWikiConflictId(): WikiConflictId {
  return WikiConflictId(`wconf_${randomUUID()}`)
}

/** Create a random LLM Wiki page id. */
export function createWikiPageId(): WikiPageId {
  return WikiPageId(`wpage_${randomUUID()}`)
}

/** Create a random immutable generated knowledge-version id. */
export function createKnowledgeGeneratedVersionId(): KnowledgeGeneratedVersionId {
  return KnowledgeGeneratedVersionId(`kgv_${randomUUID()}`)
}

/** Create a random immutable effective knowledge-version id. */
export function createKnowledgeEffectiveVersionId(): KnowledgeEffectiveVersionId {
  return KnowledgeEffectiveVersionId(`kev_${randomUUID()}`)
}

/** Create a random immutable human knowledge-revision id. */
export function createKnowledgeHumanRevisionId(): KnowledgeHumanRevisionId {
  return KnowledgeHumanRevisionId(`khr_${randomUUID()}`)
}

/** Create one idempotent operator save-request id. */
export function createKnowledgeHumanRevisionRequestId(): KnowledgeHumanRevisionRequestId {
  return KnowledgeHumanRevisionRequestId(`khreq_${randomUUID()}`)
}
