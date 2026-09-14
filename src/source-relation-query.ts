import type { KnowledgeSourceId } from './ids.js'
import type { SourceModuleReferenceKind } from './source-analysis.js'
import type { SourceRelationResolution } from './source-relations.js'

/** Stable version of the current-checkpoint Source relation retriever. */
export const SOURCE_RELATION_RETRIEVER_VERSION = 1 as const

/** Maximum accepted length for relation text and area filters. */
export const MAX_SOURCE_RELATION_FILTER_CHARS = 1_024

/** One current Source revision represented by relation query results. */
export interface SourceRelationRevision {
  sourceId: KnowledgeSourceId
  commit: string
  inventoryHash: string
  sourceRecordHash: string
  relationProvider: string
  relationProviderKey: string
  relationOutputHash: string
  graphOmittedEdgeCount: number
}

/** One portable, line-addressable edge from the current Source relation index. */
export interface SourceRelationQueryEdge {
  edgeId: string
  sourceId: KnowledgeSourceId
  commit: string
  inventoryHash: string
  sourceRecordHash: string
  fromPath: string
  fromContentHash: string
  toPath?: string
  specifier: string
  kind: SourceModuleReferenceKind
  resolution: SourceRelationResolution
  startLine: number
  endLine: number
}

/** Reasons why a Source relation query omitted matching indexed edges. */
export type SourceRelationQueryTruncationReason = 'result-limit'

/** Bounded query result from the current Source relation index. */
export interface SourceRelationQueryPack {
  retriever: 'source-relations-sql'
  version: typeof SOURCE_RELATION_RETRIEVER_VERSION
  query?: string
  area?: string
  resolution?: SourceRelationResolution
  kind?: SourceModuleReferenceKind
  totalMatches: number
  omittedEdgeCount: number
  truncationReasons: SourceRelationQueryTruncationReason[]
  sourceRevisions: SourceRelationRevision[]
  edges: SourceRelationQueryEdge[]
}

/** Query request whose project root and result limit are controlled by the owning Host. */
export interface SourceRelationQueryRequest {
  projectRoot: string
  query?: string
  area?: string
  resolution?: SourceRelationResolution
  kind?: SourceModuleReferenceKind
  limit: number
  signal?: AbortSignal
}
