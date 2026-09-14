import { Context, Service } from '@deepseek-ai/cordis'
import type { KnowledgeCardId } from './ids.js'
import type { ProjectKnowledgeStatus, SourceInventoryInspectionOptions } from './inventory.js'
import type { WikiProjectCatalog } from './wiki-catalog.js'
import type { WikiMaterialPreparation, WikiMaterialStreamItem } from './wiki-material.js'
import type { WikiCatalogEntry, WikiCoverageItem, WikiMaterialRange } from './wiki-model.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    knowledgeProject: KnowledgeProject
  }
}

/** Result of explicitly persisting detected stale Knowledge Cards. */
export interface MarkStaleKnowledgeCardsResult {
  updatedCardIds: readonly KnowledgeCardId[]
  status: ProjectKnowledgeStatus
}

/** Service Definition for local project source inventory and card freshness. */
export abstract class KnowledgeProject extends Service {
  constructor(ctx: Context) {
    super(ctx, 'knowledgeProject')
  }

  /** Inspect current source revisions and effective card freshness without writes. */
  abstract inspect(projectRoot: string, options?: SourceInventoryInspectionOptions): Promise<ProjectKnowledgeStatus>

  /** Catalog current project material from Git metadata without reading every file body. */
  abstract catalog(projectRoot: string, signal?: AbortSignal): Promise<WikiProjectCatalog>

  /** Prepare one oversized immutable object as durable, bounded analysis ranges. */
  abstract prepareWikiMaterial(
    projectRoot: string,
    entry: WikiCatalogEntry,
    signal?: AbortSignal,
  ): Promise<WikiMaterialPreparation>

  /** Whether one Catalog entry needs asynchronous material preparation. */
  abstract needsWikiMaterialPreparation(entry: WikiCatalogEntry): boolean

  /** Stream one exact Catalog object in bounded chunks. */
  abstract readWikiMaterial(
    projectRoot: string,
    coverage: WikiCoverageItem,
    signal?: AbortSignal,
  ): AsyncIterable<WikiMaterialStreamItem>

  /** Stream one prepared range and its bounded context from the immutable object cache. */
  abstract readWikiMaterialRange(
    projectRoot: string,
    coverage: WikiCoverageItem,
    range: WikiMaterialRange,
    signal?: AbortSignal,
  ): AsyncIterable<WikiMaterialStreamItem>

  /** Persist every currently verified but effectively stale card as a new stale revision. */
  abstract markStale(projectRoot: string, signal?: AbortSignal): Promise<MarkStaleKnowledgeCardsResult>
}
