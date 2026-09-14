import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { readCanonicalStore, writeCanonicalCardRevision } from './canonical.js'
import type { KnowledgeCardId } from './ids.js'
import {
  DshSourceInventoryBackend,
  createSourceInventoryBaseline,
  inspectKnowledgeProject,
  type ProjectKnowledgeStatus,
  type SourceInventoryBackend,
  type SourceInventoryConfig,
  type SourceInventoryInspectionOptions,
} from './inventory.js'
import { KnowledgeProject, type MarkStaleKnowledgeCardsResult } from './inventory-service.js'
import { writeProjection } from './projection.js'
import { DeterministicSourceAnalyzer, type SourceAnalyzer } from './source-analysis.js'
import {
  buildWikiProjectCatalog,
  DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
  type WikiProjectCatalog,
  type WikiProjectCatalogConfig,
} from './wiki-catalog.js'
import {
  DEFAULT_WIKI_MATERIAL_READ_CONFIG,
  prepareWikiMaterial,
  streamWikiMaterial,
  streamWikiMaterialRange,
  type WikiMaterialPreparation,
  type WikiMaterialReadConfig,
  type WikiMaterialStreamItem,
} from './wiki-material.js'
import type { WikiCatalogEntry, WikiCoverageItem, WikiMaterialRange } from './wiki-model.js'

/** Default bounded inventory settings used when the profile does not override them. */
export const DEFAULT_SOURCE_INVENTORY_CONFIG: SourceInventoryConfig = {
  includeUntracked: true,
  maxFiles: 50_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  maxPathChars: 1_024,
  maxDepth: 64,
  gitOutputMaxBytes: 16 * 1024 * 1024,
  processGraceMs: 3_000,
}

/** Local project inventory provider configuration. */
export interface Config extends Partial<SourceInventoryConfig> {
  wikiCatalog?: WikiProjectCatalogConfig
  wikiMaterial?: WikiMaterialReadConfig
}

/** Schemastery configuration for bounded local source inventory. */
export const Config: z<Config> = z.object({
  includeUntracked: z.boolean().default(DEFAULT_SOURCE_INVENTORY_CONFIG.includeUntracked),
  maxFiles: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.maxFiles),
  maxTotalBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.maxTotalBytes),
  maxFileBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.maxFileBytes),
  maxPathChars: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.maxPathChars),
  maxDepth: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.maxDepth),
  gitOutputMaxBytes: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.gitOutputMaxBytes),
  processGraceMs: z.number().step(1).min(1).default(DEFAULT_SOURCE_INVENTORY_CONFIG.processGraceMs),
  wikiCatalog: z.object({
    maxEntries: z.number().step(1).min(1).default(DEFAULT_WIKI_PROJECT_CATALOG_CONFIG.maxEntries),
    maxPathChars: z.number().step(1).min(1).default(DEFAULT_WIKI_PROJECT_CATALOG_CONFIG.maxPathChars),
    maxDepth: z.number().step(1).min(1).default(DEFAULT_WIKI_PROJECT_CATALOG_CONFIG.maxDepth),
    gitOutputMaxBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_PROJECT_CATALOG_CONFIG.gitOutputMaxBytes),
    processGraceMs: z.number().step(1).min(1).default(DEFAULT_WIKI_PROJECT_CATALOG_CONFIG.processGraceMs),
  }).default(DEFAULT_WIKI_PROJECT_CATALOG_CONFIG),
  wikiMaterial: z.object({
    chunkBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG.chunkBytes),
    maxMaterialBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG.maxMaterialBytes),
    rangeTargetBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG.rangeTargetBytes),
    rangeContextBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG.rangeContextBytes),
    stderrMaxBytes: z.number().step(1).min(1).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG.stderrMaxBytes),
    processGraceMs: z.number().step(1).min(1).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG.processGraceMs),
  }).default(DEFAULT_WIKI_MATERIAL_READ_CONFIG),
})

/** Shared inspector used by the Cordis provider and standalone CLI. */
export class KnowledgeProjectInspector {
  private readonly baselines = new Map<string, NonNullable<SourceInventoryInspectionOptions['baselines']>>()

  constructor(
    private readonly backend: SourceInventoryBackend,
    private readonly config: SourceInventoryConfig,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly analyzer: SourceAnalyzer = new DeterministicSourceAnalyzer(),
    private readonly wikiCatalogConfig: WikiProjectCatalogConfig = DEFAULT_WIKI_PROJECT_CATALOG_CONFIG,
    private readonly wikiMaterialConfig: WikiMaterialReadConfig = DEFAULT_WIKI_MATERIAL_READ_CONFIG,
    private readonly wikiMaterialCacheRoot = dshHomePath('memory-knowledge', 'wiki-material-cache'),
  ) {}

  /** Inspect source inventory and effective card freshness without writes. */
  async inspect(projectRoot: string, options: SourceInventoryInspectionOptions = {}): Promise<ProjectKnowledgeStatus> {
    const baselines = options.baselines ?? this.baselines.get(projectRoot)
    const status = await inspectKnowledgeProject(
      this.backend,
      await readCanonicalStore(projectRoot),
      this.config,
      this.analyzer,
      {
        ...options,
        ...(baselines === undefined ? {} : { baselines }),
      },
    )
    const nextBaselines = status.sources.flatMap(source => {
      const baseline = createSourceInventoryBaseline(source)
      return baseline === undefined ? [] : [baseline]
    })
    if (nextBaselines.length > 0) this.baselines.set(projectRoot, nextBaselines)
    return status
  }

  /** Catalog project paths, object identities and sizes without reading tracked contents. */
  async catalog(projectRoot: string, signal?: AbortSignal): Promise<WikiProjectCatalog> {
    return buildWikiProjectCatalog(
      this.backend,
      await readCanonicalStore(projectRoot),
      this.wikiCatalogConfig,
      signal,
    )
  }

  /** Prepare one oversized immutable Catalog object for bounded range tasks. */
  async prepareWikiMaterial(
    projectRoot: string,
    entry: WikiCatalogEntry,
    signal?: AbortSignal,
  ): Promise<WikiMaterialPreparation> {
    return prepareWikiMaterial(
      this.backend,
      await readCanonicalStore(projectRoot),
      entry,
      this.wikiMaterialCacheRoot,
      this.wikiMaterialConfig,
      signal,
    )
  }

  /** Avoid asynchronous preparation work for ordinary Catalog entries. */
  needsWikiMaterialPreparation(entry: WikiCatalogEntry): boolean {
    return entry.disposition === undefined && entry.byteSize > this.wikiMaterialConfig.rangeTargetBytes
  }

  /** Stream one immutable Catalog object without consulting the current worktree file. */
  async *readWikiMaterial(
    projectRoot: string,
    coverage: WikiCoverageItem,
    signal?: AbortSignal,
  ): AsyncIterable<WikiMaterialStreamItem> {
    yield* streamWikiMaterial(
      this.backend,
      await readCanonicalStore(projectRoot),
      coverage,
      this.wikiMaterialConfig,
      signal,
    )
  }

  /** Stream one prepared range without consulting the current worktree file. */
  async *readWikiMaterialRange(
    projectRoot: string,
    coverage: WikiCoverageItem,
    range: WikiMaterialRange,
    signal?: AbortSignal,
  ): AsyncIterable<WikiMaterialStreamItem> {
    yield* streamWikiMaterialRange(
      this.backend,
      await readCanonicalStore(projectRoot),
      coverage,
      range,
      this.wikiMaterialCacheRoot,
      this.wikiMaterialConfig,
      signal,
    )
  }

  /** Persist newly detected stale cards under the canonical writer lock. */
  async markStale(projectRoot: string, signal?: AbortSignal): Promise<MarkStaleKnowledgeCardsResult> {
    const manifestPath = join(projectRoot, '.dsh', 'knowledge', 'manifest.json')
    const updatedCardIds: KnowledgeCardId[] = []
    await withFileLock(manifestPath, async () => {
      const store = await readCanonicalStore(projectRoot)
      const status = await this.inspect(projectRoot, signal === undefined ? {} : { signal })
      const staleIds = new Set(status.cards
        .filter(card => card.state === 'stale' && card.canonicalStatus === 'verified')
        .map(card => card.cardId))
      const updatedAt = this.now()
      for (const card of store.cards) {
        if (!staleIds.has(card.id)) continue
        await writeCanonicalCardRevision(store, {
          ...structuredClone(card),
          revision: card.revision + 1,
          status: 'stale',
          updatedAt,
        })
        updatedCardIds.push(card.id)
      }
      if (updatedCardIds.length > 0) await writeProjection(await readCanonicalStore(projectRoot))
    })
    return { updatedCardIds, status: await this.inspect(projectRoot, signal === undefined ? {} : { signal }) }
  }
}

/** DSH fs/subprocess-backed provider for source inventory and card freshness. */
export class LocalKnowledgeProject extends KnowledgeProject {
  static inject = ['fs', 'subprocess', 'sourceAnalysis']
  static Config = Config

  private readonly inspector: KnowledgeProjectInspector
  private readonly inFlight = new Map<string, Promise<ProjectKnowledgeStatus>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.inspector = new KnowledgeProjectInspector(
      new DshSourceInventoryBackend(ctx.fs, ctx.subprocess),
      { ...DEFAULT_SOURCE_INVENTORY_CONFIG, ...config },
      undefined,
      ctx.sourceAnalysis,
      { ...DEFAULT_WIKI_PROJECT_CATALOG_CONFIG, ...config.wikiCatalog },
      { ...DEFAULT_WIKI_MATERIAL_READ_CONFIG, ...config.wikiMaterial },
      dshHomePath('memory-knowledge', 'wiki-material-cache'),
    )
  }

  override inspect(projectRoot: string, options: SourceInventoryInspectionOptions = {}): Promise<ProjectKnowledgeStatus> {
    if (options.signal !== undefined) return this.inspector.inspect(projectRoot, options)
    const current = this.inFlight.get(projectRoot)
    if (current !== undefined) return current
    const started = this.inspector.inspect(projectRoot, options)
    this.inFlight.set(projectRoot, started)
    void started.finally(() => { this.inFlight.delete(projectRoot) }).catch(() => {})
    return started
  }

  override catalog(projectRoot: string, signal?: AbortSignal): Promise<WikiProjectCatalog> {
    return this.inspector.catalog(projectRoot, signal)
  }

  override prepareWikiMaterial(
    projectRoot: string,
    entry: WikiCatalogEntry,
    signal?: AbortSignal,
  ): Promise<WikiMaterialPreparation> {
    return this.inspector.prepareWikiMaterial(projectRoot, entry, signal)
  }

  override needsWikiMaterialPreparation(entry: WikiCatalogEntry): boolean {
    return this.inspector.needsWikiMaterialPreparation(entry)
  }

  override readWikiMaterial(
    projectRoot: string,
    coverage: WikiCoverageItem,
    signal?: AbortSignal,
  ): AsyncIterable<WikiMaterialStreamItem> {
    return this.inspector.readWikiMaterial(projectRoot, coverage, signal)
  }

  override readWikiMaterialRange(
    projectRoot: string,
    coverage: WikiCoverageItem,
    range: WikiMaterialRange,
    signal?: AbortSignal,
  ): AsyncIterable<WikiMaterialStreamItem> {
    return this.inspector.readWikiMaterialRange(projectRoot, coverage, range, signal)
  }

  override markStale(projectRoot: string, signal?: AbortSignal): Promise<MarkStaleKnowledgeCardsResult> {
    return this.inspector.markStale(projectRoot, signal)
  }
}

export default LocalKnowledgeProject
