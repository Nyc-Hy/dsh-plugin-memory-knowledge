import { realpath } from 'node:fs/promises'
import type { SearchWikiCatalogRequest, ListWikiCatalogRangesRequest, WikiCatalogQueryPage, WikiCatalogFileHit, WikiCatalogRangeHit } from './wiki-catalog-query.js'
import type { WikiMaterialBudgetKey, WikiMaterialReadBudget, ReserveWikiMaterialRead, ListWikiMaterialBudgetsRequest, WikiMaterialBudgetPage, WikiMaterialBudgetUpdateGuard } from './wiki-material-budget.js'
import { join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  isCanonicalStoreAbsent,
  readCanonicalStore,
  writeCanonicalCard,
  writeCanonicalCardRevision,
  writeCanonicalMemory,
} from './canonical.js'
import {
  DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG,
  planKnowledgeCardCandidates,
  type KnowledgeCardCandidateGenerationConfig,
} from './candidate-generation.js'
import { planWikiCardCandidates } from './wiki-card-candidate.js'
import {
  canonicalFingerprint,
  MemoryKnowledgeDatabase,
  type IndexedMemoryDocument,
  type MemoryJournalMode,
} from './database.js'
import {
  createKnowledgeEffectiveVersion,
  createKnowledgeGeneratedVersion,
  type KnowledgeActivationResult,
  type KnowledgeVersionState,
} from './knowledge-version.js'
import type {
  CreateKnowledgeHumanRevisionInput,
  KnowledgeHumanRevision,
  KnowledgeHumanRevisionResult,
} from './knowledge-revision.js'
import type { EffectiveKnowledgeSearchHit, EffectiveKnowledgeSearchRequest } from './effective-knowledge.js'
import {
  MAX_SOURCE_EVIDENCE_QUERY_CHARS,
  type SourceEvidencePack,
  type SourceEvidenceSearchRequest,
} from './evidence-pack.js'
import {
  MAX_SOURCE_RELATION_FILTER_CHARS,
  type SourceRelationQueryPack,
  type SourceRelationQueryRequest,
} from './source-relation-query.js'
import {
  MAX_SOURCE_SYMBOL_FILTER_CHARS,
  type SourceSymbolQueryPack,
  type SourceSymbolQueryRequest,
} from './source-symbol-query.js'
import type { MemoryCandidateId, MemoryId, WikiRunId } from './ids.js'
import type { KnowledgeProject } from './inventory-service.js'
import { KNOWLEDGE_SCHEMA_VERSION, type KnowledgeCard, type MemoryEntry } from './model.js'
import { writeProjection } from './projection.js'
import {
  buildSourceUnderstanding,
  DEFAULT_SOURCE_RECORD_CONFIG,
  sourceInventoryBaseline,
  summarizeSourceUnderstanding,
  type SourceRecordConfig,
  type SourceUnderstanding,
  type SourceUnderstandingSummary,
} from './source-records.js'
import type { SourceInventoryBaseline } from './inventory.js'
import { DeterministicSourceRelationAnalyzer, type SourceRelationAnalyzer } from './source-relations.js'
import { TypeScriptSourceSymbolAnalyzer, type SourceSymbolAnalyzer } from './source-symbols.js'
import {
  assessWikiCompletion,
  createPlannedWikiRun,
  DEFAULT_WIKI_SHARD_CONFIG,
  type PlanWikiRunInput,
  type WikiRun,
  type WikiRunSnapshot,
  type WikiShardConfig,
} from './wiki-model.js'
import {
  wikiPlanInputFromCatalog,
  type PlanWikiProjectResult,
} from './wiki-catalog.js'
import type {
  GenerateKnowledgeCardCandidatesResult,
  ConversationExtractionCheckpoint,
  CreateLocalMemoryEntryInput,
  KnowledgeCardCandidate,
  ListLocalMemoryEntriesRequest,
  ListReviewCandidatesRequest,
  ListRecallableMemoryRequest,
  LocalMemoryEntry,
  LocalMemoryEntryStatus,
  LocalMemoryRevision,
  MemoryCandidate,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryTrace,
  PromoteReviewCandidateResult,
  PrepareConversationExtractionRequest,
  RecordConversationExtractionRequest,
  RecordConversationExtractionResult,
  RecallableMemoryRecord,
  ReviewCandidate,
  ReviewCandidateDecision,
  SaveMemoryCandidateInput,
  UpdateLocalMemoryEntryInput,
} from './runtime-model.js'

/** Default private database path below the active DSH home. */
export function defaultMemoryDatabasePath(): string {
  return dshHomePath('memory-knowledge', 'memory.sqlite')
}

/** Resolved local engine configuration. */
export interface MemoryKnowledgeEngineConfig {
  path: string
  journalMode: MemoryJournalMode
  candidateGeneration?: Partial<KnowledgeCardCandidateGenerationConfig>
  sourceRecords?: Partial<SourceRecordConfig>
  wikiShards?: Partial<WikiShardConfig>
}

function cardContent(card: KnowledgeCard): string {
  return [card.summary, ...card.sections.flatMap(section => [section.title, section.content])].join('\n\n')
}

function canonicalDocuments(
  projectRoot: string,
  store: Awaited<ReturnType<typeof readCanonicalStore>>,
  unavailableCardIds: ReadonlySet<string> = new Set(),
): IndexedMemoryDocument[] {
  const memories = store.memories
    .filter(memory => memory.status === 'verified')
    .map((memory): IndexedMemoryDocument => ({
      id: memory.id,
      recordType: 'project-memory',
      title: memory.title,
      content: memory.content,
      tags: [...memory.tags],
      evidenceClass: memory.evidenceClass,
      sensitivity: memory.sensitivity,
      projectRoot,
      scope: structuredClone(memory.scope),
      provenance: structuredClone(memory.provenance),
      updatedAt: memory.updatedAt,
    }))
  const cards = store.cards
    .filter(card => card.status === 'verified' && !unavailableCardIds.has(card.id))
    .map((card): IndexedMemoryDocument => ({
      id: card.id,
      recordType: 'knowledge-card',
      title: card.title,
      content: cardContent(card),
      tags: [card.kind],
      evidenceClass: card.evidenceClass,
      sensitivity: 'normal',
      projectRoot,
      scope: structuredClone(card.scope),
      provenance: structuredClone(card.provenance),
      updatedAt: card.updatedAt,
    }))
  return [...memories, ...cards]
}

type KnowledgeProjectRuntime = Pick<KnowledgeProject, 'inspect'>
  & Partial<Pick<KnowledgeProject, 'catalog' | 'prepareWikiMaterial' | 'needsWikiMaterialPreparation'>>

/** Domain engine shared by the Cordis provider and standalone review CLI. */
export class MemoryKnowledgeEngine {
  private promotionTail: Promise<void> = Promise.resolve()
  private readonly planningTails = new Map<string, Promise<void>>()

  private constructor(
    private readonly database: MemoryKnowledgeDatabase,
    private readonly knowledgeProject?: KnowledgeProjectRuntime,
    private readonly candidateGeneration: KnowledgeCardCandidateGenerationConfig = DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG,
    private readonly sourceRecords: SourceRecordConfig = DEFAULT_SOURCE_RECORD_CONFIG,
    private readonly wikiShards: WikiShardConfig = DEFAULT_WIKI_SHARD_CONFIG,
    private readonly sourceRelations: SourceRelationAnalyzer = new DeterministicSourceRelationAnalyzer(),
    private readonly sourceSymbols: SourceSymbolAnalyzer = new TypeScriptSourceSymbolAnalyzer(),
  ) {}

  /** Open the configured local database. */
  static async open(
    config: MemoryKnowledgeEngineConfig,
    knowledgeProject?: KnowledgeProjectRuntime,
    sourceRelations?: SourceRelationAnalyzer,
    sourceSymbols?: SourceSymbolAnalyzer,
  ): Promise<MemoryKnowledgeEngine> {
    return new MemoryKnowledgeEngine(
      await MemoryKnowledgeDatabase.open(config.path, config.journalMode),
      knowledgeProject,
      { ...DEFAULT_KNOWLEDGE_CARD_CANDIDATE_CONFIG, ...config.candidateGeneration },
      { ...DEFAULT_SOURCE_RECORD_CONFIG, ...config.sourceRecords },
      { ...DEFAULT_WIKI_SHARD_CONFIG, ...config.wikiShards },
      sourceRelations,
      sourceSymbols,
    )
  }

  /** Release the local database after queued work settles. */
  close(): Promise<void> {
    return this.database.close()
  }

  /** Create and persist one language-neutral LLM Wiki coverage plan. */
  async planWikiRun(input: PlanWikiRunInput): Promise<WikiRunSnapshot> {
    const projectRoot = await realpath(resolve(input.projectRoot))
    return this.serializePlanning(projectRoot, async () => {
      const selection = await this.database.getKnowledgeSelection(projectRoot)
      const run = await this.database.saveWikiRunSnapshot(createPlannedWikiRun({ ...input, projectRoot }, [], this.wikiShards))
      await this.database.selectKnowledgeRun(projectRoot, run.run.id, input.now, { expectedRevision: selection?.revision })
      return run
    })
  }

  /** Catalog one project from Git metadata and persist its initial Wiki coverage run. */
  async planWikiProject(projectRoot: string, signal?: AbortSignal): Promise<PlanWikiProjectResult> {
    const knowledgeProject = this.knowledgeProject
    if (knowledgeProject?.catalog === undefined) {
      throw new Error('Wiki project planning requires a KnowledgeProject catalog provider')
    }
    const root = await realpath(resolve(projectRoot))
    return this.serializePlanning(root, () => this.doPlanWikiProject(root, signal))
  }

  private async doPlanWikiProject(root: string, signal?: AbortSignal): Promise<PlanWikiProjectResult> {
    const knowledgeProject = this.knowledgeProject
    if (knowledgeProject?.catalog === undefined) {
      throw new Error('Wiki project planning requires a KnowledgeProject catalog provider')
    }
    const selection = await this.database.getKnowledgeSelection(root)
      const catalog = await knowledgeProject.catalog(root, signal)
    const latest = (await this.database.listWikiRuns(root, 1))[0]
    if (latest !== undefined && latest.catalogHash === catalog.catalogHash) {
      const existing = await this.database.getWikiRunSnapshot(latest.id)
      if (existing === undefined) throw new Error('latest Wiki run disappeared during planning')
      await this.database.selectKnowledgeRun(root, existing.run.id, undefined, { expectedRevision: selection?.revision })
      return { catalog, run: existing }
    }
    const previous = latest === undefined ? undefined : await this.database.getWikiRunSnapshot(latest.id)
    const input = wikiPlanInputFromCatalog(catalog)
      if (knowledgeProject.prepareWikiMaterial !== undefined) {
      const entries: Array<(typeof input.entries)[number]> = []
      for (const entry of input.entries) {
          if (knowledgeProject.needsWikiMaterialPreparation?.(entry) === false) {
          entries.push(entry)
          continue
        }
          const prepared = await knowledgeProject.prepareWikiMaterial(root, entry, signal)
        if (prepared.kind === 'whole') {
          entries.push(entry)
          continue
        }
        if (prepared.kind === 'deferred') {
          entries.push({ ...entry, disposition: { status: 'deferred' as const, reason: prepared.reason } })
          continue
        }
        entries.push({
          ...entry,
          preparedMaterial: { contentHash: prepared.contentHash, ranges: prepared.ranges },
        })
      }
      input.entries = entries
    }
    const run = await this.database.saveWikiRunSnapshot(createPlannedWikiRun(
      input,
      previous?.coverage,
      this.wikiShards,
      previous,
    ))
    await this.database.selectKnowledgeRun(root, run.run.id, undefined, { expectedRevision: selection?.revision })
    return { catalog, run }
  }

  private async serializePlanning<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.planningTails.get(projectRoot) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const tail = prior.then(() => gate)
    this.planningTails.set(projectRoot, tail)
    await prior
    try {
      return await operation()
    } finally {
      release()
      if (this.planningTails.get(projectRoot) === tail) this.planningTails.delete(projectRoot)
    }
  }

  /** Read the consistent generated/effective version state for one canonical project. */
  async getKnowledgeVersionState(projectRoot: string): Promise<KnowledgeVersionState> {
    return this.database.getKnowledgeVersionState(await realpath(resolve(projectRoot)))
  }

  /** List immutable operator edits for one canonical project. */
  async listKnowledgeHumanRevisions(projectRoot: string, limit: number): Promise<KnowledgeHumanRevision[]> {
    return this.database.listKnowledgeHumanRevisions(await realpath(resolve(projectRoot)), limit)
  }

  /** Save one operator edit without changing the generated Wiki snapshot. */
  async applyKnowledgeHumanRevision(
    input: CreateKnowledgeHumanRevisionInput,
  ): Promise<KnowledgeHumanRevisionResult> {
    const projectRoot = await realpath(resolve(input.projectRoot))
    return this.database.applyKnowledgeHumanRevision({ ...input, projectRoot })
  }

  /** Search the FTS projection of one project's current EffectiveVersion only. */
  async searchEffectiveKnowledge(request: EffectiveKnowledgeSearchRequest): Promise<EffectiveKnowledgeSearchHit[]> {
    const projectRoot = await realpath(resolve(request.projectRoot))
    return this.database.searchEffectiveKnowledge({ ...request, projectRoot })
  }

  /** Seal and activate one complete Wiki run when every Host completion check passes. */
  async activateWikiRun(runId: WikiRunId): Promise<KnowledgeActivationResult> {
    const snapshot = await this.database.getWikiRunSnapshot(runId)
    if (snapshot === undefined) throw new Error('cannot activate a missing Wiki run')
    const completion = assessWikiCompletion(snapshot.run)
    if (!completion.eligibleForActivation) {
      throw new Error('Wiki run is not eligible for project-knowledge activation')
    }
    const generatedVersion = createKnowledgeGeneratedVersion(snapshot, completion)
    const effectiveVersion = createKnowledgeEffectiveVersion(generatedVersion)
    const selection = await this.database.getKnowledgeSelection(snapshot.run.projectRoot)
    if (selection === undefined) throw new Error('cannot activate a Wiki run without a project selection')
    return this.database.activateKnowledgeVersion({
      generatedVersion,
      effectiveVersion,
      expectedSelectionRevision: selection.revision,
    })
  }

  /** Persist a fully validated update to one local LLM Wiki run. */
  async saveWikiRunSnapshot(
    snapshot: WikiRunSnapshot,
    expectedSnapshotHash?: string,
  ): Promise<WikiRunSnapshot> {
    const projectRoot = await realpath(resolve(snapshot.run.projectRoot))
    if (projectRoot !== snapshot.run.projectRoot) {
      throw new Error('Wiki run projectRoot must be its canonical real path')
    }
    return this.database.saveWikiRunSnapshot(snapshot, expectedSnapshotHash)
  }

  /** 读取独立于 Wiki 快照的任务材料账本。
   * @param key Run 与 Task 身份。
   * @returns 当前账本；缺失时历史消耗未知。
   */
  getWikiMaterialReadBudget(key: WikiMaterialBudgetKey): Promise<WikiMaterialReadBudget | undefined> {
    return this.database.getWikiMaterialReadBudget(key)
  }

  /** 在规范项目路径内分页定位文件。
   * @param request 当前任务、字面路径条件和预算。
   * @returns 不包含正文的目录页。
   */
  async searchWikiCatalog(request: SearchWikiCatalogRequest): Promise<WikiCatalogQueryPage<WikiCatalogFileHit>> {
    return this.database.searchWikiCatalog({ ...request, projectRoot: await realpath(resolve(request.projectRoot)) })
  }

  /** 分页定位当前 Run 内的大文件区间。
   * @param request 当前任务、Coverage 和预算。
   * @returns 不包含正文的材料区间页。
   */
  async listWikiCatalogRanges(request: ListWikiCatalogRangesRequest): Promise<WikiCatalogQueryPage<WikiCatalogRangeHit>> {
    return this.database.listWikiCatalogRanges({ ...request, projectRoot: await realpath(resolve(request.projectRoot)) })
  }

  /** 按项目查询一页任务账本。
   * @param request 项目、Run、筛选和游标。
   * @returns 有界账本页。
   */
  async listWikiMaterialReadBudgets(request: ListWikiMaterialBudgetsRequest): Promise<WikiMaterialBudgetPage> {
    return this.database.listWikiMaterialReadBudgets({ ...request, projectRoot: await realpath(resolve(request.projectRoot)) })
  }

  /** 预扣材料字节，恢复或重试不会重置账本。
   * @param request 当前运行 Session 与读取额度。
   * @returns 包含预扣结果或持久化拒绝状态的账本。
   */
  reserveWikiMaterialRead(request: ReserveWikiMaterialRead): Promise<WikiMaterialReadBudget> {
    return this.database.reserveWikiMaterialRead(request)
  }

  /** 操作者显式扩额；模型工具不暴露此操作。
   * @param key Run 与 Task 身份。
   * @param limitBytes 高于旧额度且可容纳被拒绝读取的新总额度。
   * @param guard 浏览器确认所绑定的项目与账本版本。
   * @returns 保留全部消耗的更新账本。
   */
  async increaseWikiMaterialReadBudget(key: WikiMaterialBudgetKey, limitBytes: number, guard?: WikiMaterialBudgetUpdateGuard): Promise<WikiMaterialReadBudget> {
    return this.database.increaseWikiMaterialReadBudget(key, limitBytes,
      guard === undefined ? undefined : { ...guard, projectRoot: await realpath(resolve(guard.projectRoot)) })
  }

  /** Read one fully validated local LLM Wiki run. */
  getWikiRunSnapshot(id: WikiRunSnapshot['run']['id']): Promise<WikiRunSnapshot | undefined> {
    return this.database.getWikiRunSnapshot(id)
  }

  /** List local LLM Wiki run headers under an optional project and result limit. */
  async listWikiRuns(projectRoot?: string, limit?: number): Promise<WikiRun[]> {
    if (projectRoot === undefined) return this.database.listWikiRuns(undefined, limit)
    return this.database.listWikiRuns(await realpath(resolve(projectRoot)), limit)
  }

  /** Save or deduplicate a local candidate. */
  async saveCandidate(input: SaveMemoryCandidateInput): Promise<MemoryCandidate> {
    if (input.applicability === 'project' && input.projectRoot === undefined) {
      throw new Error('project candidate requires projectRoot')
    }
    if (input.applicability === 'global' && input.projectRoot !== undefined) {
      throw new Error('global candidate must not carry projectRoot')
    }
    if (input.projectRoot === undefined) return this.database.saveCandidate(input)
    const projectRoot = await realpath(resolve(input.projectRoot))
    return this.database.saveCandidate({ ...input, projectRoot })
  }

  /** Create or read one durable conversation extraction checkpoint. */
  prepareConversationExtraction(
    request: PrepareConversationExtractionRequest,
  ): Promise<ConversationExtractionCheckpoint> {
    return this.database.prepareConversationExtraction(request)
  }

  /** Atomically save one extracted candidate and checkpoint its completed turn. */
  async recordConversationExtraction(
    request: RecordConversationExtractionRequest,
  ): Promise<RecordConversationExtractionResult> {
    const candidate = request.candidate
    if (candidate === undefined) return this.database.recordConversationExtraction(request)
    if (candidate.applicability === 'project' && candidate.projectRoot === undefined) {
      throw new Error('project candidate requires projectRoot')
    }
    if (candidate.applicability === 'global' && candidate.projectRoot !== undefined) {
      throw new Error('global candidate must not carry projectRoot')
    }
    if (candidate.projectRoot === undefined) return this.database.recordConversationExtraction(request)
    const projectRoot = await realpath(resolve(candidate.projectRoot))
    return this.database.recordConversationExtraction({
      ...request,
      candidate: { ...candidate, projectRoot },
    })
  }

  /** List local review candidates. */
  async listCandidates(request: ListReviewCandidatesRequest): Promise<ReviewCandidate[]> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new Error('candidate list limit must be a positive safe integer')
    }
    if (request.projectRoot !== undefined && request.applicability === 'global') {
      throw new Error('global candidate list must not carry projectRoot')
    }
    if (request.projectRoot === undefined) return this.database.listCandidates(request)
    const projectRoot = await realpath(resolve(request.projectRoot))
    return this.database.listCandidates({ ...request, projectRoot })
  }

  /** Read one candidate by opaque id. */
  getCandidate(id: MemoryCandidateId): Promise<ReviewCandidate | undefined> {
    return this.database.getCandidate(id)
  }

  /** Apply an explicit human review decision. */
  reviewCandidate(
    id: MemoryCandidateId,
    decision: ReviewCandidateDecision,
    expectedRevision?: number,
  ): Promise<ReviewCandidate> {
    return this.database.reviewCandidate(id, decision, expectedRevision)
  }

  /** Create one explicitly saved local long-term memory entry. */
  async createLocalMemoryEntry(input: CreateLocalMemoryEntryInput): Promise<LocalMemoryEntry> {
    if (input.applicability === 'global') {
      if (input.projectRoot !== undefined) throw new Error('personal memory must not carry projectRoot')
      return this.database.createLocalMemoryEntry(input)
    }
    if (input.projectRoot === undefined) throw new Error('project memory requires projectRoot')
    const projectRoot = await realpath(resolve(input.projectRoot))
    return this.database.createLocalMemoryEntry({ ...input, projectRoot })
  }

  /** List local long-term memory entries in one exact personal or project scope. */
  async listLocalMemoryEntries(request: ListLocalMemoryEntriesRequest): Promise<LocalMemoryEntry[]> {
    if (request.projectRoot === undefined) return this.database.listLocalMemoryEntries(request)
    return this.database.listLocalMemoryEntries({ ...request, projectRoot: await realpath(resolve(request.projectRoot)) })
  }

  /** Read one local memory entry in one exact scope. */
  async getLocalMemoryEntry(id: MemoryId, projectRoot?: string): Promise<LocalMemoryEntry | undefined> {
    return this.database.getLocalMemoryEntry(
      id,
      projectRoot === undefined ? undefined : await realpath(resolve(projectRoot)),
    )
  }

  /** Save editable local memory fields through revision compare-and-swap. */
  async updateLocalMemoryEntry(
    id: MemoryId,
    input: UpdateLocalMemoryEntryInput,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry> {
    return this.database.updateLocalMemoryEntry(
      id,
      input,
      expectedRevision,
      projectRoot === undefined ? undefined : await realpath(resolve(projectRoot)),
    )
  }

  /** Change one local memory lifecycle state without discarding history. */
  async setLocalMemoryEntryStatus(
    id: MemoryId,
    status: LocalMemoryEntryStatus,
    expectedRevision: number,
    projectRoot?: string,
  ): Promise<LocalMemoryEntry> {
    return this.database.setLocalMemoryEntryStatus(
      id,
      status,
      expectedRevision,
      projectRoot === undefined ? undefined : await realpath(resolve(projectRoot)),
    )
  }

  /** Read immutable local memory revision history. */
  async listLocalMemoryRevisions(
    id: MemoryId,
    projectRoot: string | undefined,
    limit: number,
  ): Promise<LocalMemoryRevision[]> {
    return this.database.listLocalMemoryRevisions(
      id,
      projectRoot === undefined ? undefined : await realpath(resolve(projectRoot)),
      limit,
    )
  }

  /** Generate or recover deterministic Knowledge Card review candidates for one project. */
  async generateKnowledgeCardCandidates(projectRoot: string): Promise<GenerateKnowledgeCardCandidatesResult> {
    const knowledgeProject = this.knowledgeProject
    const catalogProject = knowledgeProject?.catalog
    if (knowledgeProject === undefined || catalogProject === undefined) {
      throw new Error('Knowledge Card generation requires project inventory and Catalog providers')
    }
    const root = await realpath(resolve(projectRoot))
    const baselines = await this.sourceInventoryBaselines(root)
    const [store, status, catalog] = await Promise.all([
      readCanonicalStore(root),
      knowledgeProject.inspect(root, { baselines }),
      catalogProject.call(knowledgeProject, root),
    ])
    const understandings: SourceUnderstanding[] = []
    for (const inventory of [...status.sources].sort((left, right) => (
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0
    ))) {
      if (inventory.state !== 'ready' || inventory.dirty || inventory.commit === undefined
        || inventory.inventoryHash === undefined) continue
      const manifestSource = store.manifest.sources.find(source => source.id === inventory.sourceId)
      if (manifestSource === undefined) throw new Error('Source inventory has no canonical manifest source')
      const sourceRoot = await realpath(resolve(root, manifestSource.relativeRoot))
      const symbols = await this.sourceSymbols.analyze({
        projectRoot: sourceRoot,
        files: inventory.files.map(file => ({
          path: file.path,
          contentHash: file.contentHash,
          size: file.size,
          ...(file.language === undefined ? {} : { language: file.language }),
        })),
      })
      if (symbols.providerKey !== this.sourceSymbols.cacheKey) {
        throw new Error('Source symbol Provider returned an inconsistent cache identity')
      }
      understandings.push(await this.database.saveSourceUnderstanding(
        root,
        buildSourceUnderstanding(inventory, this.sourceRecords, this.sourceRelations, symbols),
      ))
    }
    const plan = planKnowledgeCardCandidates(store, status, this.candidateGeneration, understandings)
    const candidates: KnowledgeCardCandidate[] = []
    for (const input of plan.inputs) candidates.push(await this.database.saveKnowledgeCardCandidate(input))
    const latestWikiRun = (await this.database.listWikiRuns(root, 1))[0]
    const wikiSnapshot = latestWikiRun === undefined
      ? undefined
      : await this.database.getWikiRunSnapshot(latestWikiRun.id)
    const wikiPlan = wikiSnapshot === undefined
      ? { inputs: [], skipped: [] }
      : planWikiCardCandidates(wikiSnapshot, store, catalog)
    for (const input of wikiPlan.inputs) candidates.push(await this.database.saveKnowledgeCardCandidate(input))
    return {
      candidates,
      skipped: [...plan.skipped, ...wikiPlan.skipped],
      understandings: understandings.map(summarizeSourceUnderstanding),
    }
  }

  /** List current local Source record checkpoints without exposing file paths. */
  async listSourceUnderstandings(projectRoot: string): Promise<SourceUnderstandingSummary[]> {
    const root = await realpath(resolve(projectRoot))
    return (await this.database.listSourceUnderstandings(root)).map(summarizeSourceUnderstanding)
  }

  /** Read file-level Source baselines for trusted same-process inventory reuse. */
  async listSourceInventoryBaselines(projectRoot: string): Promise<SourceInventoryBaseline[]> {
    return this.sourceInventoryBaselines(await realpath(resolve(projectRoot)))
  }

  private async sourceInventoryBaselines(projectRoot: string): Promise<SourceInventoryBaseline[]> {
    return (await this.database.listSourceUnderstandings(projectRoot)).map(sourceInventoryBaseline)
  }

  /** Search the current local Source evidence generation for one project. */
  async searchSourceEvidence(request: SourceEvidenceSearchRequest): Promise<SourceEvidencePack> {
    const query = request.query.trim()
    if (query.length === 0 || [...query].length > MAX_SOURCE_EVIDENCE_QUERY_CHARS) {
      throw new Error(`Source evidence query must contain 1-${MAX_SOURCE_EVIDENCE_QUERY_CHARS} characters`)
    }
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new Error('Source evidence search limit must be a positive safe integer')
    }
    const projectRoot = await realpath(resolve(request.projectRoot))
    return this.database.searchSourceEvidence({ ...request, projectRoot, query })
  }

  /** Query bounded module relations from the current project Source checkpoint. */
  async querySourceRelations(request: SourceRelationQueryRequest): Promise<SourceRelationQueryPack> {
    const query = request.query?.trim() || undefined
    const area = request.area?.trim() || undefined
    for (const [name, value] of [['query', query], ['area', area]] as const) {
      if (value !== undefined && [...value].length > MAX_SOURCE_RELATION_FILTER_CHARS) {
        throw new Error(`Source relation ${name} must contain at most ${MAX_SOURCE_RELATION_FILTER_CHARS} characters`)
      }
    }
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new Error('Source relation query limit must be a positive safe integer')
    }
    const projectRoot = await realpath(resolve(request.projectRoot))
    const normalized: SourceRelationQueryRequest = { ...request, projectRoot }
    if (query === undefined) delete normalized.query
    else normalized.query = query
    if (area === undefined) delete normalized.area
    else normalized.area = area
    return this.database.querySourceRelations(normalized)
  }

  /** Query bounded symbol definition/reference edges from the current project Source checkpoint. */
  async querySourceSymbols(request: SourceSymbolQueryRequest): Promise<SourceSymbolQueryPack> {
    const query = request.query?.trim() || undefined
    const definitionPath = request.definitionPath?.trim() || undefined
    const referencePath = request.referencePath?.trim() || undefined
    for (const [name, value] of [
      ['query', query], ['definitionPath', definitionPath], ['referencePath', referencePath],
    ] as const) {
      if (value !== undefined && [...value].length > MAX_SOURCE_SYMBOL_FILTER_CHARS) {
        throw new Error(`Source symbol ${name} must contain at most ${MAX_SOURCE_SYMBOL_FILTER_CHARS} characters`)
      }
    }
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new Error('Source symbol query limit must be a positive safe integer')
    }
    const projectRoot = await realpath(resolve(request.projectRoot))
    const normalized: SourceSymbolQueryRequest = { ...request, projectRoot }
    if (query === undefined) delete normalized.query
    else normalized.query = query
    if (definitionPath === undefined) delete normalized.definitionPath
    else normalized.definitionPath = definitionPath
    if (referencePath === undefined) delete normalized.referencePath
    else normalized.referencePath = referencePath
    return this.database.querySourceSymbols(normalized)
  }

  /** List records currently eligible for recall in one optional project. */
  async listRecallable(request: ListRecallableMemoryRequest): Promise<RecallableMemoryRecord[]> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
      throw new Error('recallable list limit must be a positive safe integer')
    }
    if (request.projectRoot === undefined) return this.database.listRecallable(request)
    const projectRoot = await realpath(resolve(request.projectRoot))
    await this.synchronizeCanonical(projectRoot)
    return this.database.listRecallable({ ...request, projectRoot })
  }

  /** Synchronize one Git canonical store into the disposable local search index. */
  async synchronizeCanonical(projectRoot: string): Promise<void> {
    const root = await realpath(resolve(projectRoot))
    try {
      const store = await readCanonicalStore(root)
      const baselines = await this.sourceInventoryBaselines(root)
      const status = await this.knowledgeProject?.inspect(root, { baselines })
      const unavailableCardIds = new Set(status?.cards
        .filter(card => card.state !== 'fresh')
        .map(card => card.cardId))
      await this.database.replaceCanonicalDocuments(
        root,
        canonicalFingerprint({
          manifest: store.manifest,
          memories: store.memories,
          cards: store.cards,
          unavailableCardIds: [...unavailableCardIds].sort(),
        }),
        canonicalDocuments(root, store, unavailableCardIds),
      )
    } catch (error: unknown) {
      if (!isCanonicalStoreAbsent(error, root)) throw error
      await this.database.replaceCanonicalDocuments(root, canonicalFingerprint({ absent: true }), [])
    }
  }

  /** Search accepted personal memory and the current canonical project snapshot. */
  async search(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) throw new Error('memory search limit must be positive')
    if (!Number.isSafeInteger(request.maxChars) || request.maxChars < 1) throw new Error('memory search maxChars must be positive')
    if (request.projectRoot === undefined) return this.database.search(request)
    const projectRoot = await realpath(resolve(request.projectRoot))
    await this.synchronizeCanonical(projectRoot)
    return this.database.search({ ...request, projectRoot })
  }

  /** Trace one local candidate or currently indexed canonical document. */
  async trace(id: string, projectRoot?: string): Promise<MemoryTrace | undefined> {
    if (projectRoot === undefined) return this.database.trace(id)
    const resolvedRoot = await realpath(resolve(projectRoot))
    await this.synchronizeCanonical(resolvedRoot)
    return this.database.trace(id, resolvedRoot)
  }

  /** Promote a candidate under a cross-process canonical writer lock. */
  promoteCandidate(
    id: MemoryCandidateId,
    projectRoot?: string,
    expectedRevision?: number,
  ): Promise<PromoteReviewCandidateResult> {
    return this.serializePromotion(() => this.doPromoteCandidate(id, projectRoot, expectedRevision))
  }

  private async serializePromotion<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const prior = this.promotionTail
    this.promotionTail = prior.then(() => gate)
    await prior
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async doPromoteCandidate(
    id: MemoryCandidateId,
    requestedRoot?: string,
    expectedRevision?: number,
  ): Promise<PromoteReviewCandidateResult> {
    const reserved = await this.database.reservePromotion(id, expectedRevision)
    const selectedRoot = requestedRoot ?? reserved.projectRoot
    if (selectedRoot === undefined) throw new Error(`global candidate ${id} needs an explicit project root for promotion`)
    const root = await realpath(resolve(selectedRoot))
    if (reserved.target === 'knowledge-card' && root !== await realpath(reserved.projectRoot)) {
      throw new Error('Knowledge Card candidates can only be promoted into their source project')
    }
    return reserved.target === 'memory'
      ? this.promoteMemoryCandidate(reserved, root)
      : this.promoteKnowledgeCardCandidate(reserved, root)
  }

  private async promoteMemoryCandidate(
    reserved: MemoryCandidate,
    root: string,
  ): Promise<PromoteReviewCandidateResult> {
    const manifestPath = join(root, '.dsh', 'knowledge', 'manifest.json')
    const reviewedAt = reserved.reviewedAt ?? reserved.updatedAt
    const promotedMemoryId = reserved.promotedMemoryId
    if (promotedMemoryId === undefined) throw new Error(`memory candidate ${reserved.id} has no reserved memory id`)
    let memory: MemoryEntry | undefined
    let path = ''
    await withFileLock(manifestPath, async () => {
      const store = await readCanonicalStore(root)
      memory = {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        id: promotedMemoryId,
        revision: 1,
        scope: { kind: 'space', spaceId: store.manifest.spaceId },
        kind: reserved.kind,
        status: 'verified',
        title: reserved.title,
        content: reserved.content,
        evidenceClass: 'human-verified',
        provenance: structuredClone(reserved.provenance),
        tags: [...reserved.tags],
        supersedes: [],
        conflictsWith: [],
        sensitivity: reserved.sensitivity,
        createdAt: reserved.createdAt,
        updatedAt: reviewedAt,
      }
      const result = await writeCanonicalMemory(store, memory)
      path = result.path
      await writeProjection(await readCanonicalStore(root))
    })
    if (memory === undefined) throw new Error('memory promotion lock completed without a canonical document')
    const candidate = await this.database.completePromotion(reserved.id)
    if (candidate.target !== 'memory') throw new Error('candidate target changed during memory promotion')
    await this.synchronizeCanonical(root)
    return { recordType: 'memory', candidate, memory, path }
  }

  private async promoteKnowledgeCardCandidate(
    reserved: KnowledgeCardCandidate,
    root: string,
  ): Promise<PromoteReviewCandidateResult> {
    const knowledgeProject = this.knowledgeProject
    if (knowledgeProject === undefined) throw new Error('Knowledge Card promotion requires a project inventory provider')
    const promotedId = reserved.promotedKnowledgeCardId
    if (promotedId === undefined) throw new Error(`Knowledge Card candidate ${reserved.id} has no reserved card id`)
    const reviewedAt = reserved.reviewedAt ?? reserved.updatedAt
    const manifestPath = join(root, '.dsh', 'knowledge', 'manifest.json')
    let card: KnowledgeCard | undefined
    let path = ''
    await withFileLock(manifestPath, async () => {
      const store = await readCanonicalStore(root)
      const current = store.cards.find(candidate => candidate.id === promotedId)
      const targetCardId = reserved.card.targetCardId
      const baseRevision = reserved.card.baseRevision
      if (baseRevision !== undefined && targetCardId === undefined
        || targetCardId !== undefined && targetCardId !== promotedId) {
        throw new Error('Knowledge Card candidate target is inconsistent with its reserved id')
      }
      const expectedRevision = baseRevision === undefined ? 1 : baseRevision + 1
      const createdAt = current?.createdAt ?? reserved.createdAt
      card = {
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        id: promotedId,
        revision: expectedRevision,
        scope: structuredClone(reserved.card.scope),
        kind: reserved.card.kind,
        title: reserved.title,
        summary: reserved.card.summary,
        sections: structuredClone(reserved.card.sections),
        provenance: structuredClone(reserved.card.provenance),
        sourceRevisions: structuredClone(reserved.card.sourceRevisions),
        status: 'verified',
        evidenceClass: reserved.card.evidenceClass,
        createdAt,
        updatedAt: reviewedAt,
      }
      const alreadyWritten = current !== undefined && JSON.stringify(current) === JSON.stringify(card)
      if (!alreadyWritten) {
        if (baseRevision === undefined && reserved.generation.generator !== 'wiki-page' && store.cards.some(existing => (
          existing.id !== promotedId && existing.kind === reserved.card.kind
          && existing.scope.kind === 'source' && reserved.card.scope.kind === 'source'
          && existing.scope.sourceId === reserved.card.scope.sourceId
          && existing.title === reserved.title
        ))) {
          throw new Error('a Knowledge Card for this source, kind, and title already exists; generate a new candidate')
        }
        const revision = reserved.card.sourceRevisions.find(source => source.sourceId === reserved.generation.sourceId)
        if (reserved.generation.generator === 'wiki-page' && reserved.generation.catalogHash !== undefined) {
          if (knowledgeProject.catalog === undefined) {
            throw new Error('Wiki Knowledge Card promotion requires a project Catalog provider')
          }
          const catalog = await knowledgeProject.catalog(root)
          const source = catalog.sources.find(value => value.sourceId === reserved.generation.sourceId)
          if (catalog.state !== 'complete' || catalog.catalogHash !== reserved.generation.catalogHash
            || source?.complete !== true || source.commit === undefined || revision?.commit !== source.commit
            || revision.catalogHash !== catalog.catalogHash) {
            throw new Error('Wiki Knowledge Card candidate source changed; generate a new candidate before promotion')
          }
        } else {
          const baselines = await this.sourceInventoryBaselines(root)
          const status = await knowledgeProject.inspect(root, { baselines })
          const inventory = status.sources.find(source => source.sourceId === reserved.generation.sourceId)
          if (inventory === undefined || inventory.state !== 'ready' || inventory.dirty || inventory.commit === undefined
            || inventory.inventoryHash !== reserved.generation.inventoryHash || revision?.commit !== inventory.commit) {
            throw new Error('Knowledge Card candidate source changed; generate a new candidate before promotion')
          }
        }
        if (baseRevision === undefined) {
          const result = await writeCanonicalCard(store, card)
          path = result.path
        } else {
          if (current === undefined || current.revision !== baseRevision) {
            throw new Error(`Knowledge Card ${promotedId} changed after candidate generation`)
          }
          const result = await writeCanonicalCardRevision(store, card)
          path = result.path
        }
      } else {
        path = join(store.knowledgeRoot, 'cards', `${promotedId}.json`)
      }
      await writeProjection(await readCanonicalStore(root))
    })
    if (card === undefined) throw new Error('Knowledge Card promotion lock completed without a canonical document')
    const candidate = await this.database.completePromotion(reserved.id)
    if (candidate.target !== 'knowledge-card') throw new Error('candidate target changed during Knowledge Card promotion')
    await this.synchronizeCanonical(root)
    return { recordType: 'knowledge-card', candidate, card, path }
  }
}
