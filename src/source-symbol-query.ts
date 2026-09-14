import type { KnowledgeSourceId, SourceSymbolId } from './ids.js'
import type { SourceSymbolReferenceKind } from './source-symbols.js'

/** Stable version of the current-checkpoint Source symbol retriever. */
export const SOURCE_SYMBOL_RETRIEVER_VERSION = 2 as const

/** Maximum accepted length for symbol text and path filters. */
export const MAX_SOURCE_SYMBOL_FILTER_CHARS = 1_024

/** One current Source revision represented by symbol query results. */
export interface SourceSymbolRevision {
  sourceId: KnowledgeSourceId
  commit: string
  inventoryHash: string
  sourceRecordHash: string
  symbolProvider: string
  symbolProviderKey: string
  symbolOutputHash: string
  graphOmittedFileCount: number
  graphOmittedReferenceCount: number
  configMode: 'default' | 'tsconfig'
  configPaths: string[]
  projectReferenceCount: number
  pathAliasCount: number
  configDiagnosticCount: number
  omittedConfigFileCount: number
}

/** One portable cross-file reference resolved to a current Source definition. */
export interface SourceSymbolQueryEdge {
  referenceId: string
  sourceId: KnowledgeSourceId
  commit: string
  inventoryHash: string
  sourceRecordHash: string
  definitionId: SourceSymbolId
  symbolName: string
  declaration: string
  definitionPath: string
  definitionContentHash: string
  definitionStartLine: number
  definitionEndLine: number
  referencePath: string
  referenceContentHash: string
  referenceKind: SourceSymbolReferenceKind
  referenceStartLine: number
  referenceEndLine: number
}

/** Reasons why a Source symbol query omitted matching indexed references. */
export type SourceSymbolQueryTruncationReason = 'result-limit'

/** Bounded query result from the current Source symbol index. */
export interface SourceSymbolQueryPack {
  retriever: 'source-symbols-sql'
  version: typeof SOURCE_SYMBOL_RETRIEVER_VERSION
  query?: string
  definitionPath?: string
  referencePath?: string
  referenceKind?: SourceSymbolReferenceKind
  totalMatches: number
  omittedReferenceCount: number
  truncationReasons: SourceSymbolQueryTruncationReason[]
  sourceRevisions: SourceSymbolRevision[]
  edges: SourceSymbolQueryEdge[]
}

/** Query request whose project root and result limit are controlled by the owning Host. */
export interface SourceSymbolQueryRequest {
  projectRoot: string
  query?: string
  definitionPath?: string
  referencePath?: string
  referenceKind?: SourceSymbolReferenceKind
  limit: number
  signal?: AbortSignal
}
