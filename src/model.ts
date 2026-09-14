import type { Branded } from '@deepseek-ai/dsh-brand'
import type { KnowledgeCardId, KnowledgeSourceId, KnowledgeSpaceId, MemoryId } from './ids.js'

type SessionId = Branded<'SessionId'>

/** Current canonical knowledge-file schema version. */
export const KNOWLEDGE_SCHEMA_VERSION = 1 as const

/** Name stamped into deterministic projections. */
export const PROJECTION_GENERATOR = 'dsh-plugin-memory-knowledge'

/** Format version stamped into manifests created by this projector. */
export const PROJECTION_VERSION = '1'

/** Scope of one Git-shared memory or knowledge card. */
export type SharedKnowledgeScope =
  | { kind: 'source'; sourceId: KnowledgeSourceId }
  | { kind: 'space'; spaceId: KnowledgeSpaceId }

/** One Git repository registered as a canonical knowledge source. */
export interface GitKnowledgeSource {
  id: KnowledgeSourceId
  kind: 'git'
  relativeRoot: string
}

/** Canonical root manifest committed with team knowledge. */
export interface KnowledgeManifest {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION
  spaceId: KnowledgeSpaceId
  sources: GitKnowledgeSource[]
  projection: {
    generator: string
    version: string
  }
}

/** Portable source evidence retained by canonical memory and knowledge records. */
export type ProvenanceRef =
  | {
      kind: 'git-file'
      sourceId: KnowledgeSourceId
      commit: string
      path: string
      startLine?: number
      endLine?: number
      contentHash: string
    }
  | {
      kind: 'git-commit'
      sourceId: KnowledgeSourceId
      commit: string
    }
  | {
      kind: 'session'
      sessionId: SessionId
      eventSeqs: number[]
      portableEvidence?: string
    }
  | {
      kind: 'document'
      sourceId: KnowledgeSourceId
      path: string
      contentHash: string
    }

/** One reviewed long-term memory committed to the project repository. */
export interface MemoryEntry {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION
  id: MemoryId
  revision: number
  scope: SharedKnowledgeScope
  kind: 'fact' | 'decision' | 'lesson' | 'method' | 'preference' | 'constraint'
  status: 'verified' | 'conflicted' | 'deprecated' | 'deleted'
  title: string
  content: string
  evidenceClass: 'deterministic' | 'human-verified' | 'ai-suggested'
  provenance: ProvenanceRef[]
  tags: string[]
  supersedes: MemoryId[]
  conflictsWith: MemoryId[]
  sensitivity: 'normal' | 'restricted'
  createdAt: string
  updatedAt: string
}

/** One section inside a structured knowledge card. */
export interface KnowledgeSection {
  id: string
  title: string
  content: string
  provenance: ProvenanceRef[]
}

/** Git revision that anchored one knowledge-card generation. */
export interface GitSourceRevision {
  sourceId: KnowledgeSourceId
  kind: 'git'
  commit: string
  inventoryHash?: string
  catalogHash?: string
}

/** One reviewed or reviewable project knowledge card. */
export interface KnowledgeCard {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION
  id: KnowledgeCardId
  revision: number
  scope: SharedKnowledgeScope
  kind: 'overview' | 'architecture' | 'module' | 'flow' | 'decision' | 'stack'
  title: string
  summary: string
  sections: KnowledgeSection[]
  provenance: ProvenanceRef[]
  sourceRevisions: GitSourceRevision[]
  status: 'verified' | 'needs-review' | 'stale' | 'deprecated'
  evidenceClass: 'deterministic' | 'human-verified' | 'ai-suggested'
  createdAt: string
  updatedAt: string
}
