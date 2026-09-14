import { describe, expect, it } from 'vitest'
import {
  createKnowledgeCardId,
  createKnowledgeEffectiveVersionId,
  createKnowledgeGeneratedVersionId,
  createKnowledgeSourceId,
  createKnowledgeSpaceId,
  createMemoryId,
  createWikiCitationId,
  createWikiClaimId,
  createWikiConflictId,
  createWikiPageId,
  createWikiRunId,
  KNOWLEDGE_CARD_ID_PATTERN,
  KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN,
  KNOWLEDGE_GENERATED_VERSION_ID_PATTERN,
  KNOWLEDGE_SOURCE_ID_PATTERN,
  KNOWLEDGE_SPACE_ID_PATTERN,
  MEMORY_ID_PATTERN,
  WIKI_CITATION_ID_PATTERN,
  WIKI_CLAIM_ID_PATTERN,
  WIKI_CONFLICT_ID_PATTERN,
  WIKI_PAGE_ID_PATTERN,
  WIKI_RUN_ID_PATTERN,
} from '../src/ids.js'

describe('branded ids', () => {
  it.each([
    [createKnowledgeSpaceId, KNOWLEDGE_SPACE_ID_PATTERN],
    [createKnowledgeSourceId, KNOWLEDGE_SOURCE_ID_PATTERN],
    [createMemoryId, MEMORY_ID_PATTERN],
    [createKnowledgeCardId, KNOWLEDGE_CARD_ID_PATTERN],
    [createKnowledgeGeneratedVersionId, KNOWLEDGE_GENERATED_VERSION_ID_PATTERN],
    [createKnowledgeEffectiveVersionId, KNOWLEDGE_EFFECTIVE_VERSION_ID_PATTERN],
    [createWikiRunId, WIKI_RUN_ID_PATTERN],
    [createWikiCitationId, WIKI_CITATION_ID_PATTERN],
    [createWikiClaimId, WIKI_CLAIM_ID_PATTERN],
    [createWikiConflictId, WIKI_CONFLICT_ID_PATTERN],
    [createWikiPageId, WIKI_PAGE_ID_PATTERN],
  ])('creates values accepted by the durable schema', (create, pattern) => {
    expect(create()).toMatch(new RegExp(pattern))
  })
})
